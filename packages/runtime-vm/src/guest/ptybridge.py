#!/usr/bin/env python3
# Erdou PTY bridge — runs inside chroot /workspace. Daemonizes onto /dev/hvc<port>,
# runs an interactive /bin/sh under a real pty, and pumps bytes both ways. Verified
# by Round-11b Spike F. Launched by guestd's pty-open op: python3 ptybridge.py <port>.
import os, sys, tty, termios, fcntl, select, signal, struct

port = int(sys.argv[1]) if len(sys.argv) > 1 else 1
dev = "/dev/hvc%d" % port

if os.fork() > 0:
    os._exit(0)                 # parent (guestd's child) returns immediately
os.setsid()                     # daemon: new session, no ctty
hvc = os.open(dev, os.O_RDWR)   # becomes our controlling tty (session leader, no ctty yet)
tty.setraw(hvc)                 # raw transport; fd held → sticks
try:
    fcntl.ioctl(hvc, termios.TIOCSCTTY, 0)
except OSError:
    pass

pid, master = os.forkpty()      # child: real tty (pts) = stdin/out/err + ctty
if pid == 0:
    os.environ["TERM"] = "vt100"
    os.environ["PS1"] = "$ "
    os.execv("/bin/sh", ["/bin/sh"])
    os._exit(127)

# forkpty SUCCEEDED — only now record the daemon pid so guestd's pty-open returns
# it. If forkpty had failed (e.g. devpts not mounted) we'd have crashed before
# writing the pidfile → guestd's poll times out → it replies EIO (fail-fast),
# instead of the host hanging on a bridge that never came up.
try:
    with open("/tmp/erdou-pty-%d.pid" % port, "w") as f:
        f.write(str(os.getpid()))
except OSError:
    pass

def winch(_sig, _frm):
    try:
        sz = fcntl.ioctl(hvc, termios.TIOCGWINSZ, bytes(8))
        rows, cols = struct.unpack("HHHH", sz)[:2]
        if rows and cols:
            fcntl.ioctl(master, termios.TIOCSWINSZ, sz)
    except OSError:
        pass
signal.signal(signal.SIGWINCH, winch)
winch(None, None)

os.write(hvc, b"PTYBRIDGE_READY\n")   # host gates its first input on this
while True:
    try:
        r, _, _ = select.select([hvc, master], [], [])
    except InterruptedError:
        continue
    if hvc in r:
        d = os.read(hvc, 4096)
        if not d:
            break
        os.write(master, d)
    if master in r:
        try:
            d = os.read(master, 4096)
        except OSError:
            break               # EIO = shell exited
        if not d:
            break
        os.write(hvc, d)
