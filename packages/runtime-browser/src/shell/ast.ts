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

export interface Redirect {
  fd: 0 | 1 | 2;
  op: ">" | ">>" | "<";
  target: Word;
}

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
