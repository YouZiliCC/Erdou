import { useEffect, useState, useSyncExternalStore } from "react";
import type { Studio } from "../lib/studio.js";
import { ENVIRONMENTS, environmentOptions } from "../lib/environments.js";
import { Select } from "./ui/Select.js";

/** Select the execution environment: the fast browser kernel or a per-profile
 *  Alpine VM (base/node/sci). VM boots lazily on first selection (~40 MB + boot),
 *  shown as a progress chip; the current project is copied across on switch.
 *  Profiles whose image hasn't been baked are listed but flagged — selecting one
 *  fails loud at boot (with a `bake --profile <p>` hint) and keeps the user on
 *  the working kernel. Presence comes from /vm-assets/profiles.json (written by
 *  link-vm-assets); the pure `environmentOptions()` maps it to disabled+hint. */
export function KernelToggle({ studio }: { studio: Studio }) {
  const envId = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.currentEnvId);
  const switching = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.switchingKernel);
  const running = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.running);

  const [present, setPresent] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    fetch("/vm-assets/profiles.json")
      .then((r) => (r.ok ? r.json() : []))
      .then((list) => { if (alive && Array.isArray(list)) setPresent(list as string[]); })
      .catch(() => {}); // dev/build serve missing the file: everything but browser stays flagged
    return () => { alive = false; };
  }, []);

  const options = environmentOptions(ENVIRONMENTS, present).map((o) => ({
    value: o.value,
    // Select can't render a disabled row — surface the unbaked state in the
    // label; selecting it still fails loud at boot (switchEnvironment's catch).
    label: o.disabled ? `${o.label} — not baked` : o.label,
  }));
  const currentLabel = ENVIRONMENTS.find((e) => e.id === envId)?.label ?? envId;

  if (switching) {
    return <span className="chip"><span className="dot busy" /> {switching.phase}</span>;
  }
  // Plan-review I2: no switching mid-run. Show a static (non-interactive) chip
  // while a run is active instead of the interactive Select, so the user can't
  // start a swap that switchEnvironment would reject anyway. It carries a lock
  // glyph + tooltip so the reason is legible — otherwise the environment name
  // just sits as dead text and the switch (which fully works once idle) reads as
  // "stuck on the VM".
  if (running) {
    return (
      <span
        className="chip locked"
        title="Environment is locked while a task runs — stop the task to switch (you can always return to the Browser kernel then)."
        aria-label="Environment locked while a task runs — stop the task to switch"
      >
        <svg className="chip-lock" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor"
          strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="4" y="11" width="16" height="9" rx="2" />
          <path d="M8 11V7a4 4 0 0 1 8 0v4" />
        </svg>
        {currentLabel}
      </span>
    );
  }
  return (
    <Select
      value={envId}
      options={options}
      ariaLabel="Environment"
      onChange={(v) => void studio.switchEnvironment(v)}
    />
  );
}
