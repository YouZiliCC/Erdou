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
  // start a swap that switchEnvironment would reject anyway.
  if (running) {
    return <span className="chip" aria-label="Environment (locked during run)">{currentLabel}</span>;
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
