/**
 * Title helpers for agent runs (the task threads in the sidebar).
 *
 * A new run gets an INSTANT placeholder — `runTitle(task)`, the task's first
 * line — so the sidebar shows something the moment the thread is created. In
 * the background the studio then asks the USER's own model for a concise
 * summary (system prompt `TITLE_SYSTEM`) and swaps the placeholder for the
 * cleaned result (`cleanTitle`). Pure + isolated here so the studio just wires
 * the model call and the persistence.
 */

/** First non-empty line of the task, trimmed to ~48 chars — the instant
 *  placeholder shown before the model-summarized title arrives. Pure. */
export function runTitle(task: string): string {
  const firstLine = (task.split("\n")[0] ?? "").trim();
  const base = firstLine.length > 0 ? firstLine : task.trim();
  return base.length > 48 ? base.slice(0, 47).trimEnd() + "…" : base;
}

/** System prompt for the one-shot title-summarizer call (the user's own model,
 *  no tools). Kept tight so cheap/instruction-light models still comply. */
export const TITLE_SYSTEM =
  "You write a very short title for a coding task — 3 to 6 words, at most 48 characters, " +
  "capturing what the user wants done. Use the task's own language. Output ONLY the title: " +
  "no surrounding quotes, no trailing punctuation, no 'Title:' prefix, no explanation.";

/** Clean a model-generated title into one tidy line, or "" when the model
 *  returned nothing usable. Takes the first non-empty line, strips wrapping
 *  quotes and trailing sentence punctuation, collapses whitespace, and caps the
 *  length via `runTitle`. Pure — defends against a chatty/over-long reply. */
export function cleanTitle(raw: string): string {
  const firstLine = raw.split("\n").map((l) => l.trim()).find((l) => l !== "") ?? "";
  const unquoted = firstLine.replace(/^["'“”‘’`]+|["'“”‘’`]+$/gu, "").trim();
  const noTrailingPunct = unquoted.replace(/[.。！!？?、,，;；:：]+$/u, "").trim();
  const collapsed = noTrailingPunct.replace(/\s+/g, " ");
  return collapsed.length > 0 ? runTitle(collapsed) : "";
}
