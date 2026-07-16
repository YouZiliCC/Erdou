import type { RuntimeCapabilities } from "@erdou/runtime-contract";
import type { EnvironmentInfo } from "./types.js";

const SHELL_BUILTINS =
  "ls cat grep find head tail mkdir rm cp mv touch echo pwd env which ps kill true false";

const HOW_TO_WORK = [
  "HOW TO WORK",
  "- Use the tools: file tools to read/write, run_shell for commands. Create parent dirs with make_dir before writing.",
  "- After making changes, verify them (run_shell, read_file, or list_dir).",
  "- Make reasonable decisions and proceed. When the task is fully complete, reply with a short plain-text summary and DO NOT call any tool.",
];

/**
 * Build the agent's system prompt from the runtime's real capabilities and the
 * caller's environment specifics. The brief is capability-driven: a simulated
 * kernel warns the agent away from tools that don't exist there, while a
 * real-OS runtime (caps.realOs) explains its actual toolchain, speed and
 * network reach instead. Precise framing keeps the model from wasting steps.
 */
export function buildSystemPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  return caps.realOs ? realOsPrompt(env, caps) : simulatedPrompt(env, caps);
}

/** Caller-supplied languages override the runtime's own interpreter list. */
function languagesOf(env: EnvironmentInfo, caps: RuntimeCapabilities): string[] {
  return env.languages ?? caps.interpreters;
}

function simulatedPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  const languages = languagesOf(env, caps);
  const extraCommands = env.commands ?? [];

  const canRun = languages.length > 0 ? languages.join(", ") : "none beyond the shell built-ins";
  const wasiNote = languages.includes("wasi")
    ? "\n- Run precompiled wasm32-wasi programs (Rust/C/C++/Zig/TinyGo) with: wasi /path/to/prog.wasm [args]."
    : "";

  const notAvailable: string[] = [];
  if (caps.packageManagers.length === 0) {
    notAvailable.push("Package managers (apt, yum, brew, apk) and system packages.");
  }
  notAvailable.push("Docker, systemd, sudo/root, cron, and background daemons.");
  if (!languages.includes("node")) {
    notAvailable.push("Node.js and npm — you cannot run .js/.ts files directly (no `node`).");
  }
  notAvailable.push(
    caps.networkEgress === "none"
      ? "Network access — the runtime is offline."
      : "Raw sockets — network is limited to what the host browser can fetch (CORS applies).",
  );
  if (!caps.nativeAddons) {
    notAvailable.push("Native addons / native binaries — only the above runtimes execute code.");
  }

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
    ...HOW_TO_WORK,
    env.notes ? `\nNOTES\n${env.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

function realOsPrompt(env: EnvironmentInfo, caps: RuntimeCapabilities): string {
  const languages = languagesOf(env, caps);
  const extraCommands = env.commands ?? [];

  const pkg =
    caps.packageManagers.length > 0
      ? `Package managers: ${caps.packageManagers.join(", ")}. Installs work but are SLOW here — prefer preinstalled tools.`
      : "No package manager is available — use the preinstalled tools.";
  const network =
    caps.networkEgress === "full"
      ? "Outbound network is available (relayed)."
      : caps.networkEgress === "cors-only"
        ? "Outbound network is limited: package-registry access (npm/pip) works through a gateway; arbitrary hosts are NOT reachable."
        : "The machine is offline — no outbound network.";
  const mem = caps.memoryLimitMB !== null ? ` RAM is capped around ${caps.memoryLimitMB}MB.` : "";

  return [
    `You are Erdou — an autonomous coding agent operating a REAL Linux machine running inside a browser tab (an emulated 32-bit x86 PC). The kernel, shell, filesystem and tools are real — but the CPU is roughly 10-100x slower than native, so prefer small targeted commands over heavy builds.${mem}`,
    "",
    "ENVIRONMENT",
    "- Your project lives in /workspace — do all project work there (it is shared live with the host page).",
    `- A real POSIX shell with the usual coreutils.${extraCommands.length > 0 ? ` Extra commands: ${extraCommands.join(", ")}.` : ""}`,
    languages.length > 0 ? `- Languages/tools installed: ${languages.join(", ")}.` : "",
    `- ${pkg}`,
    `- ${network}`,
    caps.virtualPorts ? "- Services listening on ports become previewable by the user." : "",
    "",
    ...HOW_TO_WORK,
    "- Remember the slow CPU: verify with the cheapest command that proves the change.",
    env.notes ? `\nNOTES\n${env.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
