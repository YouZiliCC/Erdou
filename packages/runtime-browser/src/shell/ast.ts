/** A fragment of a word. Quoted text and plain text are `lit`; `$VAR`/`${VAR}`
 *  are `var`; an unquoted run containing `*`/`?` is `glob` (so quoting disables
 *  globbing, as in POSIX); `$(...)` is `cmdsub`, holding the raw source of the
 *  command to run — the interpreter resolves it to a `sub` before expansion, so
 *  everything downstream of that stays synchronous. (`sub`, not `lit`: the two
 *  glob differently — a `lit`'s `*`/`?` are escaped to literals, a `sub`'s are
 *  left alone like a variable's value.)
 *
 *  `cmdsub` carries no "was it quoted" flag because it needs none: this shell
 *  never field-splits an expansion (an unquoted `$VAR` is one argument too), so
 *  quoted and unquoted substitutions expand identically. */
export type WordPart =
  | { t: "lit"; v: string }
  | { t: "var"; name: string }
  | { t: "glob"; v: string }
  /** `$(...)` as parsed: the raw source of the command to run. */
  | { t: "cmdsub"; src: string }
  /** `$(...)` after the interpreter ran it: the captured output. Expanded
   *  exactly like a `var`, so the rule is one sentence — a substitution behaves
   *  like a `$VAR` holding its output. */
  | { t: "sub"; v: string };

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
