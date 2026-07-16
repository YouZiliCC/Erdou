import { useSyncExternalStore } from "react";
import type { Studio } from "../lib/studio.js";
import { Select } from "./ui/Select.js";

const OPTIONS = [
  { value: "browser" as const, label: "Browser kernel" },
  { value: "vm" as const, label: "Linux VM" },
];

/** Switch between the fast simulated browser kernel and the real Alpine VM.
 *  The VM boots lazily on first selection (~40 MB download + ~2 s), shown as a
 *  progress chip; the current project is copied across on switch. */
export function KernelToggle({ studio }: { studio: Studio }) {
  const kind = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.kernelKind);
  const switching = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.switchingKernel);
  const running = useSyncExternalStore((cb) => studio.subscribe(cb), () => studio.running);
  if (switching) {
    return <span className="chip"><span className="dot busy" /> VM: {switching.phase}</span>;
  }
  // Plan-review I2: no switching mid-run. Show a static (non-interactive) chip
  // while a run is active instead of the interactive Select, so the user can't
  // start a swap that switchKernel would reject anyway.
  if (running) {
    return <span className="chip" aria-label="Kernel (locked during run)">{kind === "vm" ? "Linux VM" : "Browser kernel"}</span>;
  }
  return (
    <Select
      value={kind}
      options={OPTIONS}
      ariaLabel="Kernel"
      onChange={(v) => void studio.switchKernel(v as "browser" | "vm")}
    />
  );
}
