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

export interface Pyodide {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(options: { batched: (text: string) => void }): void;
  setStderr(options: { batched: (text: string) => void }): void;
  globals: PyGlobals;
  FS: EmscriptenFS;
}

/** Returns a (typically cached) Pyodide instance. */
export type PyodideLoader = () => Promise<Pyodide>;
