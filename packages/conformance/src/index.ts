import { describe, afterEach } from "vitest";
import type { MakeRuntime } from "./types.js";
import { teardownRuntimes } from "./types.js";
import { filesystemSuite } from "./suites/filesystem.js";
import { processSuite } from "./suites/process.js";
import { shellSuite } from "./suites/shell.js";
import { snapshotSuite } from "./suites/snapshot.js";
import { portSuite } from "./suites/port.js";
import { capabilitiesSuite } from "./suites/capabilities.js";

export type { MakeRuntime } from "./types.js";

/**
 * Run the Erdou Runtime conformance suite against a Runtime implementation.
 * Any adapter that passes this proves it satisfies the contract's observable
 * behavior for filesystem, process, shell, snapshot, port and capabilities.
 *
 * Assumes a POSIX-ish baseline of shell built-ins (echo, grep, false, sleep).
 */
export function runConformance(name: string, make: MakeRuntime): void {
  describe(`conformance: ${name}`, () => {
    afterEach(async () => {
      await teardownRuntimes();
    });
    filesystemSuite(make);
    processSuite(make);
    shellSuite(make);
    snapshotSuite(make);
    portSuite(make);
    capabilitiesSuite(make);
  });
}
