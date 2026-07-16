#!/usr/bin/env python3
# Erdou guestd — runs inside `chroot /workspace` on the v86 Alpine guest.
# Its filesystem root IS the contract root, so user commands are a plain
# subprocess (no per-command chroot). Speaks the length-prefixed binary frame
# protocol (see guestd-protocol.ts) over /dev/hvc0. Verified by the gated
# conformance run (packages/runtime-vm/src/vm-runtime.conformance.test.ts).
import os, sys, json, struct, subprocess, threading, signal, shutil

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
procs = {}   # id -> subprocess.Popen

def pump(stream, type_char, ident):
    while True:
        chunk = stream.read(4096)
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
    except FileNotFoundError:
        send_json("!", ident, {"code": "ENOENT", "message": " ".join(argv) if isinstance(argv, list) else str(argv)})
        return
    procs[ident] = p
    send_json("S", ident, {"pid": p.pid})
    t_out = threading.Thread(target=pump, args=(p.stdout, "O", ident), daemon=True)
    t_err = threading.Thread(target=pump, args=(p.stderr, "E", ident), daemon=True)
    t_out.start(); t_err.start()
    code = p.wait()
    t_out.join(); t_err.join()
    procs.pop(ident, None)
    sig = None
    if code < 0:
        sig = next((n for n, v in SIGNALS.items() if v == -code), None)
    send_json("X", ident, {"code": code if code >= 0 else 128 - code, "signal": sig})

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
