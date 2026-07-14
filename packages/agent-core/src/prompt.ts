import type { RuntimeCapabilities } from "@erdou/runtime-contract";
import type { EnvironmentInfo } from "./types.js";

const SHELL_BUILTINS =
  "ls cat grep find head tail mkdir rm cp mv touch echo pwd env which ps kill true false";

/**
 * Build the agent's system prompt from the runtime's real capabilities and the
 * caller's environment specifics. Telling the agent it operates a *simulated
 * browser OS* — and exactly what is and isn't available — keeps it from wasting
 * steps on apt/docker/node/network and makes its behavior far more predictable.
 */
export function buildSystemPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  const languages = env.languages ?? [];
  const extraCommands = env.commands ?? [];

  const canRun = languages.length > 0 ? languages.join(", ") : "none beyond the shell built-ins";
  const wasiNote = languages.includes("wasi")
    ? "\n- Run precompiled wasm32-wasi programs (Rust/C/C++/Zig/TinyGo) with: wasi /path/to/prog.wasm [args]."
    : "";

  const notAvailable: string[] = [
    "Package managers (apt, yum, brew, apk) and system packages.",
    "Docker, systemd, sudo/root, cron, and background daemons.",
  ];
  if (!languages.includes("node")) {
    notAvailable.push("Node.js and npm — you cannot run .js/.ts files directly (no `node`).");
  }
  notAvailable.push(
    caps.network ? "Raw sockets — network is limited to what the host proxies." : "Network access — the runtime is offline.",
  );
  if (!caps.nativeAddons) notAvailable.push("Native addons / native binaries — only the above runtimes execute code.");

  return [
    "You are Erdou — an autonomous coding agent operating a *simulated, browser-native* operating environment. It is NOT a real Linux machine; know your environment precisely so you don't waste steps.",
    "",
    "ENVIRONMENT",
    "- A virtual OS inside a web browser tab: an in-memory POSIX-ish filesystem, processes, and a shell. Paths are absolute and start with '/'. The filesystem starts empty.",
    `- Shell: pipes (|), redirection (> >> <), and && || ; . Built-in commands: ${SHELL_BUILTINS}. cd and export change the shell state.`,
    extraCommands.length > 0 ? `- Extra commands: ${extraCommands.join(", ")}.` : "",
    `- Languages you can run: ${canRun}.${wasiNote}`,
    caps.virtualPorts ? "- You can open virtual ports for previews." : "",
    "",
    "NOT AVAILABLE (do not attempt these — they will fail and waste steps):",
    ...notAvailable.map((n) => `- ${n}`),
    "- Interactive prompts: you cannot ask the user anything mid-task.",
    "",
    "HOW TO WORK",
    "- Use the tools: file tools to read/write, run_shell for commands. Create parent dirs with make_dir before writing.",
    "- After making changes, verify them (run_shell, read_file, or list_dir).",
    "- Make reasonable decisions and proceed. When the task is fully complete, reply with a short plain-text summary and DO NOT call any tool.",
    env.notes ? `\nNOTES\n${env.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
