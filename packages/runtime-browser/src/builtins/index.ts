import type { ProcessInfo, Signal } from "@erdou/runtime-contract";
import type { Program, ProgramRegistry } from "../process/program.js";
import { describeError } from "./util.js";
import * as fsCmd from "./fs.js";
import * as textCmd from "./text.js";
import { sed } from "./sed.js";
import { awk } from "./awk.js";
import { erdou } from "./serve.js";

export interface BuiltinDeps {
  /** The registry to populate (also read by `which`). */
  registry: ProgramRegistry;
  listProcesses(): ProcessInfo[];
  killProcess(pid: number, signal?: Signal): void;
}

const SIGNAL_ALIASES: Record<string, Signal> = {
  KILL: "SIGKILL",
  SIGKILL: "SIGKILL",
  "9": "SIGKILL",
  TERM: "SIGTERM",
  SIGTERM: "SIGTERM",
  "15": "SIGTERM",
  INT: "SIGINT",
  SIGINT: "SIGINT",
  "2": "SIGINT",
  HUP: "SIGHUP",
  SIGHUP: "SIGHUP",
  "1": "SIGHUP",
};

/**
 * Populate and return the program registry. `cd`/`export`/`jobs` are
 * intercepted by the shell interpreter (they touch shell-session state: cwd,
 * environment, background-job list) and registered here only as harmless
 * guards so `which cd` works and a stray `cd` in a pipeline is a no-op.
 */
export function createBuiltins(deps: BuiltinDeps): ProgramRegistry {
  const reg = deps.registry;

  const which: Program = async (ctx) => {
    const name = ctx.argv[1];
    if (name !== undefined && reg.has(name)) {
      ctx.stdout.write(name + "\n");
      return 0;
    }
    return 1;
  };

  const ps: Program = async (ctx) => {
    ctx.stdout.write("PID PPID STATE CMD\n");
    for (const p of deps.listProcesses()) {
      ctx.stdout.write(`${p.pid} ${p.ppid} ${p.state} ${p.cmd}\n`);
    }
    return 0;
  };

  const kill: Program = async (ctx) => {
    const args = ctx.argv.slice(1);
    let signal: Signal = "SIGTERM";
    const pids: number[] = [];
    for (const a of args) {
      if (a.startsWith("-")) {
        const mapped = SIGNAL_ALIASES[a.slice(1).toUpperCase()];
        if (mapped) signal = mapped;
      } else {
        pids.push(Number.parseInt(a, 10));
      }
    }
    let code = 0;
    for (const pid of pids) {
      try {
        deps.killProcess(pid, signal);
      } catch (err) {
        ctx.stderr.write(describeError(err) + "\n");
        code = 1;
      }
    }
    return code;
  };

  const noop: Program = async () => 0;

  const programs: Record<string, Program> = {
    ls: fsCmd.ls,
    cat: fsCmd.cat,
    mkdir: fsCmd.mkdir,
    rm: fsCmd.rm,
    cp: fsCmd.cp,
    mv: fsCmd.mv,
    touch: fsCmd.touch,
    find: fsCmd.find,
    echo: textCmd.echo,
    pwd: textCmd.pwd,
    env: textCmd.env,
    grep: textCmd.grep,
    head: textCmd.head,
    tail: textCmd.tail,
    sed,
    awk,
    true: textCmd.trueCmd,
    false: textCmd.falseCmd,
    which,
    ps,
    kill,
    erdou,
    cd: noop,
    export: noop,
    jobs: noop,
  };

  for (const [name, prog] of Object.entries(programs)) reg.set(name, prog);
  return reg;
}
