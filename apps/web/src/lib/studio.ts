import { BrowserRuntime, IndexedDbSnapshotStore } from "@erdou/runtime-browser";
import { ModelGateway, type ModelConfig } from "@erdou/model-gateway";
import { CodingAgent, type AgentEvent } from "@erdou/agent-core";
import type { RuntimeEvent, ProcessInfo } from "@erdou/runtime-contract";

const SNAPSHOT_ID = "erdou:default";

export type TraceKind = "system" | "user" | "thought" | "tool" | "result" | "done" | "error";

export interface TraceLine {
  id: number;
  kind: TraceKind;
  text: string;
  detail?: string;
  ok?: boolean;
  ts: number;
}

export interface FileNode {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink";
  children?: FileNode[];
}

/**
 * Owns the browser runtime, model gateway, agent and project persistence.
 * React subscribes for re-render; all Erdou logic lives here, not in components.
 */
export class Studio {
  readonly runtime = new BrowserRuntime();
  private readonly gateway = new ModelGateway();
  private readonly store = new IndexedDbSnapshotStore();
  private booted = false;
  private nextId = 1;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;

  trace: TraceLine[] = [];
  running = false;
  fsVersion = 0;
  /** Bumped on every change so React's useSyncExternalStore re-renders. */
  version = 0;

  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(): void {
    this.version++;
    for (const listener of this.listeners) listener();
  }

  async boot(): Promise<void> {
    if (this.booted) return;
    this.booted = true;
    await this.runtime.boot();
    try {
      const snap = await this.store.load(SNAPSHOT_ID);
      if (snap) {
        await this.runtime.restoreSnapshot(snap);
        this.log("system", "Restored your project from this browser.");
      } else {
        this.log("system", "Runtime booted. Describe what you want to build.");
      }
    } catch (err) {
      this.log("error", "Could not restore project.", asMessage(err));
    }
    this.runtime.subscribe((e: RuntimeEvent) => {
      if (e.type === "file.changed") {
        this.fsVersion++;
        this.scheduleSave();
        this.notify();
      } else if (e.type === "port.opened") {
        this.log("system", `Port ${e.port} exposed`, e.url);
      }
    });
    this.notify();
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), 400);
  }
  async save(): Promise<void> {
    await this.store.save(SNAPSHOT_ID, await this.runtime.createSnapshot());
  }

  private log(kind: TraceKind, text: string, detail?: string, ok?: boolean): void {
    this.trace = [...this.trace, { id: this.nextId++, kind, text, detail, ok, ts: Date.now() }];
    this.notify();
  }
  clearTrace(): void {
    this.trace = [];
    this.notify();
  }

  async runTask(task: string, model: ModelConfig): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.log("user", task);
    this.notify();
    const agent = new CodingAgent({
      runtime: this.runtime,
      gateway: this.gateway,
      model,
      maxSteps: 25,
      onEvent: (e) => this.onAgentEvent(e),
    });
    try {
      await agent.run(task);
    } catch (err) {
      this.log("error", "Agent stopped", asMessage(err));
    } finally {
      this.running = false;
      await this.save();
      this.notify();
    }
  }

  private onAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case "assistant":
        if (e.content.trim().length > 0) this.log("thought", e.content);
        break;
      case "tool_call":
        this.log("tool", e.name, formatArgs(e.args));
        break;
      case "tool_result":
        this.log("result", firstLine(e.output), e.output, e.ok);
        break;
      case "done":
        this.log("done", e.summary || (e.reason === "max_steps" ? "Stopped at the step limit." : "Done."));
        break;
    }
  }

  async exec(command: string): Promise<{ stdout: string; stderr: string; code: number }> {
    const p = await this.runtime.exec(command);
    const [status, stdout, stderr] = await Promise.all([p.wait(), p.stdout.text(), p.stderr.text()]);
    this.fsVersion++;
    this.scheduleSave();
    this.notify();
    return { stdout, stderr, code: status.code };
  }

  async readTree(path = "/"): Promise<FileNode[]> {
    const entries = await this.runtime.readdir(path);
    const out: FileNode[] = [];
    for (const e of entries) {
      const childPath = path === "/" ? `/${e.name}` : `${path}/${e.name}`;
      if (e.type === "directory") {
        out.push({ name: e.name, path: childPath, type: e.type, children: await this.readTree(childPath) });
      } else {
        out.push({ name: e.name, path: childPath, type: e.type });
      }
    }
    return out;
  }

  async readFileText(path: string): Promise<string> {
    return new TextDecoder().decode(await this.runtime.readFile(path));
  }

  listProcesses(): Promise<ProcessInfo[]> {
    return this.runtime.getProcesses();
  }

  async resetProject(): Promise<void> {
    await this.store.delete(SNAPSHOT_ID);
    location.reload();
  }
}

const asMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const firstLine = (s: string): string => s.split("\n")[0] ?? "";
function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`)
    .join("   ");
}
