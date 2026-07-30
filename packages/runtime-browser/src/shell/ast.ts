/** A fragment of a word. Quoted text and plain text are `lit`; `$VAR`/`${VAR}`
 *  are `var`; an unquoted run containing `*`/`?` is `glob` (so quoting disables
 *  globbing, as in POSIX). */
export type WordPart =
  | { t: "lit"; v: string }
  | { t: "var"; name: string }
  | { t: "glob"; v: string };

export interface Word {
  parts: WordPart[];
}

/** A redirect, discriminated by `op`: a file redirect names a target word, a
 *  duplication (`2>&1`) names another fd instead. `redirects` is ORDERED and
 *  the interpreter folds it left to right — that order is the whole difference
 *  between `> log 2>&1` (both streams to the file) and `2>&1 > log` (stderr to
 *  the terminal, stdout to the file). */
export type Redirect =
  | { fd: 0 | 1 | 2; op: ">" | ">>" | "<"; target: Word }
  | { fd: 1 | 2; op: ">&"; from: 1 | 2 };

export interface Command {
  kind: "command";
  words: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  kind: "pipeline";
  commands: Command[];
}

export type ListOp = "&&" | "||" | ";";

/** `op` is the operator that connects this item to the previous one (null for
 *  the first item). */
export interface ListItem {
  pipeline: Pipeline;
  op: ListOp | null;
}

export interface List {
  kind: "list";
  items: ListItem[];
  background: boolean;
}
