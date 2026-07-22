import { TITLE_SYSTEM } from "../run-title.js";
import type { ChatMessage } from "@erdou/model-gateway";

/** The fixed title a wrapped mock returns for the title-summarizer call. */
export const TITLE_TEST_REPLY = "Test Title";

/**
 * Wrap a chat mock so Studio's background title-summarizer call (its system
 * message is run-title's `TITLE_SYSTEM`) is answered with a fixed title WITHOUT
 * consuming the agent's scripted turns. Every other request passes through to
 * the wrapped `chat`. Keeps run-driving tests unaffected by the extra model
 * call `startRun` now makes to name the thread.
 */
export function withTitleReplies<F extends (config: never, messages: ChatMessage[], options?: never) => unknown>(
  chat: F,
): F {
  return ((config: never, messages: ChatMessage[], options?: never) =>
    messages[0]?.content === TITLE_SYSTEM
      ? Promise.resolve({ content: TITLE_TEST_REPLY })
      : chat(config, messages, options)) as F;
}
