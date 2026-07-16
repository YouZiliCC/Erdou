// Browser self-test entry: exercises the REAL runtime-vm browser path.
// esbuild-bundled and loaded by the e2e page; not part of the package's Node API.
import { loadBrowserInputs } from "./browser-assets.js";
import { V86Host } from "./v86-host.js";
import { GuestdClient } from "./guestd-client.js";
import { SyncFs9pFs } from "./sync-fs.js";
import { openPtySession } from "./pty.js";

const dec = new TextDecoder();

export async function bootAndSelfTest(baseUrl: string, wasmUrl: string): Promise<string> {
  const results: string[] = [];
  const inputs = await loadBrowserInputs({ baseUrl, wasmUrl, version: "e2e", memoryMB: 512 });
  const host = new V86Host();
  await host.boot(inputs, { bootTimeoutMs: 30_000 });
  host.run();
  const guestd = new GuestdClient(host.channel());
  await guestd.ready({ deadlineMs: 20_000 });
  results.push("READY");

  // 1) smoke: python3 → 42
  const p = await guestd.exec("python3 -c 'print(6*7)'");
  const out = (await p.stdout.text()).trim();
  results.push(out === "42" ? "PASS python-42" : `FAIL python-42 got=${out}`);

  // 2) sync-fs write the guest sees: SyncFs9pFs.writeFile then guest cat
  const sync = new SyncFs9pFs(host.fs9p, () => {});
  sync.writeFile("/sync.txt", "sync-visible");
  const cat = await guestd.exec("cat /sync.txt");
  const catOut = (await cat.stdout.text()).trim();
  results.push(catOut === "sync-visible" ? "PASS sync-fs" : `FAIL sync-fs got=${catOut}`);
  // and read a guest-written file back synchronously
  await (await guestd.exec("echo from-guest > /g.txt")).wait();
  results.push(dec.decode(sync.readFile("/g.txt")).trim() === "from-guest" ? "PASS sync-read" : "FAIL sync-read");

  // 3) PTY: open (subscribe-before-launch), see the prompt/echo, run a command
  const session = await openPtySession(
    host.terminal(1),
    () => guestd.ptyOpen(1),
    (x) => guestd.kill(x, "SIGKILL"),
    { deadlineMs: 15_000 },
  );
  let ptyOut = "";
  session.onData((d) => { ptyOut += dec.decode(d); });
  session.resize(80, 24);
  session.write(new TextEncoder().encode("echo pty-live\n"));
  await new Promise((r) => setTimeout(r, 1500));
  results.push(ptyOut.includes("pty-live") ? "PASS pty" : `FAIL pty out=${JSON.stringify(ptyOut.slice(-80))}`);
  await session.dispose();

  const ok = results.every((r) => !r.startsWith("FAIL"));
  return (ok ? "ALL_PASS " : "SOME_FAIL ") + results.join(" | ");
}

// expose for the page
(globalThis as unknown as { bootAndSelfTest: typeof bootAndSelfTest }).bootAndSelfTest = bootAndSelfTest;
