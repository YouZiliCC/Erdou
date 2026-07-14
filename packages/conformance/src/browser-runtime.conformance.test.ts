import { runConformance } from "./index.js";
import { BrowserRuntime } from "@erdou/runtime-browser";

// This is the only place a concrete Runtime is imported — the suite modules
// themselves depend on @erdou/runtime-contract alone.
runConformance("BrowserRuntime", () => new BrowserRuntime({ clock: () => 0 }));
