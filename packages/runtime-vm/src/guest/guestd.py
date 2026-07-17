#!/usr/bin/env python3
# Erdou guestd — runs inside `chroot /workspace` on the v86 Alpine guest.
# Its filesystem root IS the contract root, so user commands are a plain
# subprocess (no per-command chroot). Speaks the length-prefixed binary frame
# protocol (see guestd-protocol.ts) over /dev/hvc0. Verified by the gated
# conformance run (packages/runtime-vm/src/vm-runtime.conformance.test.ts).
import os, json, struct, subprocess, threading, signal, shutil, time

fd = os.open("/dev/hvc0", os.O_RDWR)
import tty
tty.setraw(fd)                       # we HOLD fd → raw sticks (spike B/C gotcha)
_wlock = threading.Lock()

# Frame: u32be payloadLen | 1 byte type | u32be id | body   (payloadLen counts type+id+body)
def send(type_char, ident, body):
    payload = type_char.encode() + struct.pack(">I", ident) + body
    with _wlock:
        os.write(fd, struct.pack(">I", len(payload)) + payload)

def send_json(type_char, ident, obj):
    send(type_char, ident, json.dumps(obj).encode())

SIGNALS = {"SIGTERM": signal.SIGTERM, "SIGKILL": signal.SIGKILL, "SIGINT": signal.SIGINT, "SIGHUP": signal.SIGHUP}

def pump(stream, type_char, ident):
    while True:
        chunk = stream.read1(4096)
        if not chunk:
            break
        send(type_char, ident, chunk)

def run_command(ident, argv, cwd, env, shell):
    try:
        full_env = dict(os.environ)
        if env:
            full_env.update(env)
        p = subprocess.Popen(argv, cwd=cwd or "/", env=full_env, shell=shell,
                              stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except OSError as e:
        # FileNotFoundError (ENOENT) is the common case; other OSErrors (e.g.
        # EACCES, ENOTDIR) are rare — ENOENT is an acceptable generic here.
        # The point is no OSError may kill this thread silently, which would
        # hang the host's exec/spawn promise forever.
        send_json("!", ident, {"code": "ENOENT", "message": str(e)})
        return
    send_json("S", ident, {"pid": p.pid})
    t_out = threading.Thread(target=pump, args=(p.stdout, "O", ident), daemon=True)
    t_err = threading.Thread(target=pump, args=(p.stderr, "E", ident), daemon=True)
    t_out.start(); t_err.start()
    code = p.wait()
    t_out.join(); t_err.join()
    sig = None
    if code < 0:
        sig = next((n for n, v in SIGNALS.items() if v == -code), None)
    send_json("X", ident, {"code": code if code >= 0 else 128 - code, "signal": sig})

def pty_open(ident, req):
    port = int(req.get("port", 1))
    pidfile = "/tmp/erdou-pty-%d.pid" % port
    try:
        os.remove(pidfile)
    except OSError:
        pass
    p = subprocess.Popen(["/usr/bin/python3", "/usr/lib/erdou/ptybridge.py", str(port)],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    p.wait()                        # reap the intermediate — ptybridge double-forks the daemon away, so this returns fast
    pid = None
    for _ in range(200):            # up to ~2s for the daemon to write its pid (after a successful forkpty)
        try:
            with open(pidfile) as f:
                pid = int(f.read().strip()); break
        except (OSError, ValueError):
            time.sleep(0.01)
    if pid is None:
        send_json("!", ident, {"code": "EIO", "message": "pty bridge did not start (forkpty/devpts?)"})
    else:
        send_json("T", ident, {"pid": pid, "port": port})

def handle(type_char, ident, body):
    if type_char == "x":            # EXEC: sh -c cmd
        req = json.loads(body or b"{}")
        threading.Thread(target=run_command, args=(ident, req["cmd"], req.get("cwd"), req.get("env"), True), daemon=True).start()
    elif type_char == "s":          # SPAWN: cmd + args, resolve via PATH first
        req = json.loads(body or b"{}")
        if shutil.which(req["cmd"]) is None:
            send_json("!", ident, {"code": "ENOENT", "message": req["cmd"]})
            return
        argv = [req["cmd"], *req.get("args", [])]
        threading.Thread(target=run_command, args=(ident, argv, req.get("cwd"), req.get("env"), False), daemon=True).start()
    elif type_char == "k":          # KILL
        req = json.loads(body or b"{}")
        try:
            os.kill(req["pid"], SIGNALS.get(req.get("signal"), signal.SIGTERM))
        except ProcessLookupError:
            pass
        send_json("X", ident, {"code": 0, "signal": None})   # ack (control id, not a process id)
    elif type_char == "p":          # PS
        send_json("P", ident, {"procs": list_procs()})
    elif type_char == "i":          # PING → the client's post-restore kick; re-announce READY
        send_json("R", 0, {"pid": os.getpid()})
    elif type_char == "t":          # PTY_OPEN {port} — launch ptybridge, reply {pid}
        threading.Thread(target=pty_open, args=(ident, json.loads(body or b"{}")), daemon=True).start()

def list_procs():
    out = []
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            with open("/proc/%s/cmdline" % pid, "rb") as f:
                parts = f.read().split(b"\x00")
            with open("/proc/%s/stat" % pid) as f:
                ppid = int(f.read().split(") ", 1)[1].split()[1])
            cmd = (parts[0] or b"").decode(errors="replace")
            args = [p.decode(errors="replace") for p in parts[1:] if p]
            out.append({"pid": int(pid), "ppid": ppid, "cmd": cmd, "args": args,
                        "cwd": "/", "state": "running", "startTimeMs": 0, "exitCode": None})
        except (FileNotFoundError, ProcessLookupError, IndexError, PermissionError):
            continue
    return out

# --- port watcher: mirror of src/proc-net-parse.ts (keep in sync) ---
_V4_ANY = "00000000"
_V6_ANY = "00000000000000000000000000000000"
_ETH0_HEX = "6456A8C0"  # 192.168.86.100 little-endian

def _parse_listening(text):
    out = {}
    for line in text.split("\n"):
        cols = line.split()
        if len(cols) < 4 or cols[3] != "0A":
            continue
        local = cols[1]
        if ":" not in local:
            continue
        iphex, porthex = local.split(":", 1)
        try:
            port = int(porthex, 16)
        except ValueError:
            continue
        if port <= 0:
            continue
        ip = iphex.upper()
        reachable = ip in (_V4_ANY, _V6_ANY, _ETH0_HEX)
        loop = not reachable
        prev = out.get(port)
        out[port] = loop if prev is None else (prev and loop)
    return out

def port_watcher():
    last = {}
    while True:
        cur = {}
        for path in ("/proc/net/tcp", "/proc/net/tcp6"):
            try:
                with open(path) as f:
                    text = f.read()
            except OSError:
                continue
            for port, loop in _parse_listening(text).items():
                prev = cur.get(port)
                cur[port] = loop if prev is None else (prev and loop)
        for port, loop in cur.items():
            if port not in last or last[port] != loop:
                send_json("L", 0, {"port": port, "listening": True, "loopback": loop})
        for port, loop in last.items():
            if port not in cur:
                send_json("L", 0, {"port": port, "listening": False, "loopback": loop})
        last = cur
        time.sleep(0.5)

threading.Thread(target=port_watcher, daemon=True).start()

send_json("R", 0, {"pid": os.getpid()})

# Frame reader loop
buf = b""
while True:
    chunk = os.read(fd, 65536)
    if not chunk:
        break
    buf += chunk
    while len(buf) >= 4:
        (plen,) = struct.unpack(">I", buf[:4])
        if plen < 5 or plen > 16 * 1024 * 1024:
            # implausible length — resync by dropping a byte, symmetric with
            # the TS FrameReader's resync behavior on garbage input
            buf = buf[1:]
            continue
        if len(buf) - 4 < plen:
            break
        payload = buf[4:4 + plen]
        buf = buf[4 + plen:]
        t = chr(payload[0])
        (ident,) = struct.unpack(">I", payload[1:5])
        try:
            handle(t, ident, payload[5:])
        except Exception as e:            # never let one bad frame kill the daemon
            send_json("!", ident, {"code": "EINVAL", "message": str(e)})
