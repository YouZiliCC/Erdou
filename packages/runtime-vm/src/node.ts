// Node-only entry: file-based asset loading (top-level node: imports). Browser
// consumers must NOT import this — the default entry (index.ts) is browser-clean.
export { loadNodeInputs, defaultAssets, assetsPresent } from "./assets.js";
export type { V86Assets } from "./assets.js";
