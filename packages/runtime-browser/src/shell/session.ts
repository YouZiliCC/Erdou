import type { Vfs } from "../vfs/vfs.js";
import type { ProcessTable } from "../process/process-table.js";
import { Shell } from "./interpreter.js";

export interface ShellSession {
  /** Live working directory — reads back after every command (for the prompt). */
  readonly cwd: string;
  exec(commandLine: string): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function createShellSession(deps: {
  table: ProcessTable;
  vfs: Vfs;
  cwd?: string;
  env?: Record<string, string>;
}): ShellSession {
  const shell = new Shell({ table: deps.table, vfs: deps.vfs, cwd: deps.cwd ?? "/", env: deps.env ?? {} });
  return {
    get cwd() {
      return shell.cwd;
    },
    async exec(commandLine: string) {
      const result = shell.execute(commandLine);
      const [code, stdout, stderr] = await Promise.all([
        result.wait(),
        result.stdout.text(),
        result.stderr.text(),
      ]);
      return { code, stdout, stderr };
    },
  };
}
