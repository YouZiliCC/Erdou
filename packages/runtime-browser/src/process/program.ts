import type { ExecContext, Executor } from "@erdou/runtime-contract";

/**
 * A process's execution context and program type come from the contract's
 * executor extension point, so language runtimes (Python, WASI, …) can be
 * written against the contract alone. `ProcessContext`/`Program` are kept as
 * local aliases for readability inside runtime-browser.
 */
export type ProcessContext = ExecContext;
export type Program = Executor;

export type ProgramRegistry = Map<string, Program>;
