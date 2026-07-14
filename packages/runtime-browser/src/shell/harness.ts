import { Vfs } from "../vfs/vfs.js";
import { EventBus } from "../core/event-bus.js";
import { ProcessTable } from "../process/process-table.js";
import type { ProgramRegistry } from "../process/program.js";
import { createBuiltins } from "../builtins/index.js";
import { Shell } from "./interpreter.js";

/** A fully-wired Vfs + ProcessTable + builtins + Shell for tests. */
export function makeShell(): { shell: Shell; vfs: Vfs } {
  const vfs = new Vfs({ clock: () => 0 });
  const bus = new EventBus();
  const registry: ProgramRegistry = new Map();
  const table = new ProcessTable({ vfs, bus, registry, clock: () => 0 });
  createBuiltins({
    registry,
    listProcesses: () => table.list(),
    killProcess: (pid, signal) => table.kill(pid, signal),
  });
  const shell = new Shell({ table, vfs });
  return { shell, vfs };
}
