/**
 * The minimal slice of Pyodide's API this adapter uses. Kept as an interface so
 * the package doesn't hard-depend on the (large) pyodide package and can be
 * unit-tested with a mock. A real Pyodide instance satisfies this shape.
 */
export interface EmscriptenFS {
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  isFile(mode: number): boolean;
  readFile(path: string, opts: { encoding: "binary" }): Uint8Array;
  writeFile(path: string, data: Uint8Array): void;
  mkdir(path: string): void;
  analyzePath(path: string): { exists: boolean };
}

export interface PyGlobals {
  set(name: string, value: unknown): void;
  get(name: string): unknown;
}

/**
 * A handle to a Python object living in the Pyodide heap. Only the members the
 * WSGI bridge needs are typed. `copy()` returns an independently-owned handle
 * that outlives the current JS call (Pyodide auto-destroys the argument proxies
 * of a JS function when it returns — a copy survives, which is how the served
 * `app` stays alive for the life of the server). `toJs()` converts to plain JS.
 */
export interface PyProxy {
  copy(): PyProxy;
  toJs(options?: { depth?: number }): unknown;
  destroy(): void;
}

/** A callable Python object handle (e.g. the WSGI `app` or a helper function). */
export type PyCallable = PyProxy & ((...args: unknown[]) => unknown);

export interface Pyodide {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: PyGlobals;
  FS: EmscriptenFS;
}

/** Returns a (typically cached) Pyodide instance. */
export type PyodideLoader = () => Promise<Pyodide>;
