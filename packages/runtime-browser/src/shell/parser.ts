import { ErrnoError } from "@erdou/runtime-contract";
import { tokenize, type Token } from "./tokenizer.js";
import type { Command, List, ListItem, ListOp, Pipeline } from "./ast.js";

/** Parse a command line into a List AST. */
export function parse(src: string): List {
  const tokens = tokenize(src);
  let background = false;

  let pos = 0;
  const peek = (): Token | undefined => tokens[pos];

  function parseCommand(): Command {
    const command: Command = { kind: "command", words: [], redirects: [] };
    while (pos < tokens.length) {
      const t = tokens[pos]!;
      if (t.type === "word") {
        command.words.push({ parts: t.parts });
        pos++;
      } else if (t.type === "redirect") {
        pos++;
        const target = tokens[pos];
        if (!target || target.type !== "word") {
          throw new ErrnoError("EINVAL", { syscall: "parse", path: "redirect without a target" });
        }
        command.redirects.push({ fd: t.fd, op: t.op, target: { parts: target.parts } });
        pos++;
      } else {
        break; // an operator ends the command
      }
    }
    if (command.words.length === 0) {
      throw new ErrnoError("EINVAL", { syscall: "parse", path: "empty command" });
    }
    return command;
  }

  function parsePipeline(): Pipeline {
    const commands: Command[] = [parseCommand()];
    while (peek()?.type === "op" && (peek() as { value: string }).value === "|") {
      pos++;
      commands.push(parseCommand());
    }
    return { kind: "pipeline", commands };
  }

  const items: ListItem[] = [];
  let op: ListOp | null = null;
  if (tokens.length > 0) {
    while (true) {
      const pipeline = parsePipeline();
      items.push({ pipeline, op });
      const t = peek();
      if (
        t &&
        t.type === "op" &&
        (t.value === "&&" || t.value === "||" || t.value === ";" || t.value === "&")
      ) {
        // '&' backgrounds the list; in this round it sequences like ';'.
        if (t.value === "&") background = true;
        op = t.value === "&" ? ";" : t.value;
        pos++;
        if (pos >= tokens.length) {
          // A trailing ';' or '&' just terminates the list.
          if (t.value === ";" || t.value === "&") break;
          throw new ErrnoError("EINVAL", { syscall: "parse", path: "dangling operator" });
        }
      } else {
        break;
      }
    }
  }

  if (pos < tokens.length) {
    throw new ErrnoError("EINVAL", { syscall: "parse", path: "unexpected token" });
  }

  return { kind: "list", items, background };
}
