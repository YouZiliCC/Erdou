import { useSyncExternalStore } from "react";
import { Studio } from "./studio.js";

let singleton: Studio | undefined;

function getStudio(): Studio {
  if (!singleton) {
    singleton = new Studio();
    void singleton.boot();
    if (import.meta.env.DEV) {
      (globalThis as unknown as { __erdouStudio?: Studio }).__erdouStudio = singleton;
    }
  }
  return singleton;
}

/** Subscribe to the studio; re-renders whenever its version bumps. */
export function useStudio(): Studio {
  const studio = getStudio();
  useSyncExternalStore(
    (cb) => studio.subscribe(cb),
    () => studio.version,
  );
  return studio;
}
