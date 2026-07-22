import type { RuntimeCapabilities } from "@erdou/runtime-contract";
import type { EnvironmentInfo } from "./types.js";

/**
 * One environment the agent can run in (or switch into). Structural, plain data:
 * the app owns the catalog (which profiles are baked, their install stories) and
 * supplies it — agent-core only renders it into the brief. Shaped so the app's
 * environment descriptors map straight in.
 */
export interface EnvironmentBrief {
  /** Stable env id — the switch_environment target, e.g. "browser" | "vm:base" | "vm:node" | "vm:sci". */
  readonly id: string;
  readonly label: string;
  /** Language runtimes available here. */
  readonly interpreters: readonly string[];
  /** Package managers available here (empty when none). */
  readonly packageManagers: readonly string[];
  /** One line per supported install path — persistence/speed caveats included (app-authored, so they stay truthful). */
  readonly installRecipes: readonly string[];
  /** When to pick this environment. */
  readonly switchGuidance: string;
  /** Human-readable speed class, e.g. "instant" or "slow — emulated x86". */
  readonly speed?: string;
}

/**
 * The set of environments the agent can move between via switch_environment,
 * plus which one it is running in right now. Supplied by the app on
 * `AgentOptions.environment.catalog`; rendered by buildSystemPrompt.
 */
export interface EnvironmentCatalog {
  /** Id of the environment the agent is running in right now. */
  readonly current: string;
  /** Every environment switch_environment can move to (includes the current one). */
  readonly available: readonly EnvironmentBrief[];
}

// Extend the app-supplied environment shape with the catalog, without owning
// types.ts: the catalog is agent-core's type, delivered through the existing
// AgentOptions.environment channel that agent.ts already forwards.
declare module "./types.js" {
  interface EnvironmentInfo {
    /** Environments the agent can switch between (+ the current one). */
    catalog?: EnvironmentCatalog;
  }
}

const SHELL_BUILTINS =
  "ls cat grep sed awk find head tail mkdir rm cp mv touch echo pwd env which ps kill jobs true false";

/**
 * Foundational orientation shared by BOTH kernels — what Erdou *is* and how it
 * differs from a normal machine, so the agent designs to fit instead of assuming
 * a server/laptop. This is the single source of truth for the agent's
 * environment self-image; keep it in sync as the project's major capabilities
 * change (preview transport, kernels, egress, persistence).
 */
const ERDOU_ABOUT = [
  "ABOUT ERDOU (read this — it changes how you build)",
  "- Erdou is a browser-first agent OS: your whole world runs inside the user's browser tab, not on a server or laptop. There is no host machine to fall back to — no ssh, no cloud box, no second terminal.",
  "- The project is the /workspace filesystem, persisted by the browser (IndexedDB / snapshots) or a mounted local folder — NOT a normal disk. Work under /workspace; files elsewhere may not survive a reload.",
  '- To show a running server to the user it MUST bind 0.0.0.0 (not localhost / 127.0.0.1) — the preview reaches it through a reverse proxy, so a loopback-only bind is invisible. For web pages prefer RELATIVE asset URLs (href="style.css", not "/style.css"); absolute root paths need care to resolve through the preview.',
  "- When an open_preview tool is available, use it to put your work in front of the user: pass `command` to start a blocking server the sanctioned way (run_shell would hang on it), or call it bare after a server is already listening.",
  "- When the preview observation tools are available, verify your served app yourself after open_preview: preview_read reads the rendered DOM, preview_click clicks an element, preview_logs drains the page's console output and uncaught errors.",
  "- When a package_project tool is available, use it whenever the user asks to export, download, or hand off the project — it zips the workspace (minus node_modules and Erdou-internal state) and puts a Download button in front of the user.",
  "- When a delegate tool is available, you can fan out 1-3 sub-agents in parallel — each works one self-contained subtask in an isolated copy of the workspace, and its file changes merge back when it finishes (a file two sub-agents both change gets the later one's changes rejected). Delegate only genuinely independent subtasks that touch DIFFERENT files; do small or entangled work yourself.",
  "- Design to fit this environment. When you write code or config that only exists BECAUSE of Erdou — binding 0.0.0.0, relative URLs, avoiding native/compiled deps, staying within the RAM cap — that is an Erdou adaptation; record it (see HOW TO WORK).",
];

const HOW_TO_WORK = [
  "HOW TO WORK",
  "- Use the tools: file tools to read/write, run_shell for commands. Create parent dirs with make_dir before writing.",
  "- After making changes, verify them (run_shell, read_file, or list_dir).",
  "- Keep a root ERDOU.md. The workspace has (or should have) an ERDOU.md explaining how this environment differs from a normal machine. Whenever you make an Erdou-specific adaptation, add a short bullet to its '## Project adaptations' section — what you did and why — so the user and the next agent understand the non-obvious choices. Create ERDOU.md from the standard intro if it is missing.",
  "- Make reasonable decisions and proceed. When the task is fully complete, reply with a short plain-text summary and DO NOT call any tool.",
];

/**
 * The seed ERDOU.md dropped into a fresh project workspace (by the app, before
 * the agent runs). Explains the universal Erdou differences and leaves a
 * "Project adaptations" section the agent extends as it makes Erdou-specific
 * choices. Canonical here (single source) so the app can import it without
 * owning the copy; agent-core stays app-independent.
 */
export const ERDOU_MD_TEMPLATE = `# Running in Erdou

This project was built inside **Erdou**, a browser-first agent OS — the whole
environment runs in a web browser tab, not on a normal server or laptop. A few
things work differently here than on a traditional machine:

- **Where it lives.** The project is the \`/workspace\` filesystem, persisted by
  the browser (IndexedDB / snapshots) or a mounted local folder — not a real disk.
- **Preview / servers.** A server is only visible to the user when it binds
  \`0.0.0.0\` (not \`localhost\`), and web pages should use **relative** asset URLs —
  the preview reaches the server through a reverse proxy, not a real localhost.
- **Network.** Outbound requests go through the browser's own \`fetch\` (CORS
  applies); \`pip\` / \`npm\` install from the real registries via a gateway. There
  are no raw sockets, no arbitrary hosts, and no \`apt\` / system installs at runtime.
- **No host services.** No Docker, sudo, systemd, or long-lived daemons; the
  Linux VM is a real but slow (~10-100x) emulated 32-bit machine with limited RAM.

## Project adaptations

_Code or config in this project that only exists to fit Erdou (rather than a
normal machine) is listed here by the agent, so you know what is Erdou-specific
and can hand it to the next agent to review._

- _(none yet)_
`;

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

/**
 * The environments-catalog section, appended to whichever base brief applies.
 * Data-driven: every per-env fact (interpreters, package managers, install
 * recipes) comes from the app; the framing (when/how to switch, the mid-run
 * caveat, the egress boundary) is agent-core's. Returns "" when no catalog is
 * supplied, so old callers are unaffected. The leading "\n" survives the empty
 * filter and separates it from the prior section with a blank line.
 */
function environmentsCatalogSection(env: EnvironmentInfo): string {
  const catalog = env.catalog;
  if (!catalog) return "";

  const current = catalog.available.find((e) => e.id === catalog.current);
  const currentLabel = current ? `${current.label} (${catalog.current})` : catalog.current;

  const lines = [
    "ENVIRONMENTS & PACKAGES",
    `- You are running in: ${currentLabel}. You can move between the environments below with the switch_environment tool; your /workspace files follow you.`,
    "- The current environment can change mid-run via switch_environment — so trust the latest tool result over this brief, which is NOT rebuilt on later turns.",
    "- Switch when the current environment lacks an interpreter, package manager, or preinstalled package you need (e.g. you need npm, a real Linux shell, or NumPy/Pandas). Stay put when it already has what you need — switching copies the workspace and boots another VM.",
    "- Package installs go through the package gateway: the npm and PyPI registries are reachable, but arbitrary hosts are not. apk system packages are baked into the image at build time, not installable at runtime.",
    "- Available environments (switch_environment targets):",
  ];
  for (const e of catalog.available) {
    const marker = e.id === catalog.current ? " [current]" : "";
    const interps = e.interpreters.length > 0 ? e.interpreters.join(", ") : "shell built-ins only";
    const pms = e.packageManagers.length > 0 ? e.packageManagers.join(", ") : "none";
    const speed = e.speed ? ` Speed: ${e.speed}.` : "";
    lines.push(`  - ${e.id} — ${e.label}${marker}. Interpreters: ${interps}. Package managers: ${pms}.${speed} ${e.switchGuidance}`);
    for (const recipe of e.installRecipes) lines.push(`      install: ${recipe}`);
  }
  return `\n${lines.join("\n")}`;
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
  notAvailable.push(
    "Docker, systemd, sudo/root, cron, and managed services — but long-running BACKGROUND PROCESSES exist: a trailing & backgrounds the whole command line (prints [pid]; `jobs` lists them and surfaces a finished job's buffered output; `kill <pid>` stops one). A non-trailing & (cmd1 & cmd2) is an error.",
  );
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
    ...ERDOU_ABOUT,
    "",
    "ENVIRONMENT",
    "- A virtual OS inside a web browser tab: an in-memory POSIX-ish filesystem, processes, and a shell. Paths are absolute and start with '/'. The filesystem starts empty.",
    `- Shell: pipes (|), redirection (> >> <), && || ; and trailing-& background jobs (see \`jobs\`). Built-in commands: ${SHELL_BUILTINS}. cd and export change the shell state. sed/awk are honest busybox-style subsets that ERROR on anything unsupported (JS RegExp semantics) — prefer simple invocations.`,
    extraCommands.length > 0 ? `- Extra commands: ${extraCommands.join(", ")}.` : "",
    `- Languages you can run: ${canRun}.${wasiNote}`,
    caps.virtualPorts
      ? "- To preview a web app, serve it on a virtual port then call open_preview. This (browser) kernel has NO real network sockets, so `python -m http.server` and other socket servers do NOT work here — serve static files with `erdou serve <dir>` (add --spa for a client-side router), or a Python WSGI app with `erdou.serve(app, port)`. Don't switch to a vm:* kernel just to serve a static site; this kernel serves it natively."
      : "",
    "",
    "NOT AVAILABLE (do not attempt these — they will fail and waste steps):",
    ...notAvailable.map((n) => `- ${n}`),
    "- Interactive prompts: you cannot ask the user anything mid-task.",
    "",
    ...HOW_TO_WORK,
    environmentsCatalogSection(env),
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
    ...ERDOU_ABOUT,
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
    environmentsCatalogSection(env),
    env.notes ? `\nNOTES\n${env.notes}` : "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
