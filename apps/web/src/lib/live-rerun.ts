/**
 * Pure gate for the Preview panel's `live` re-run effect.
 *
 * `doRun` records `studio.fsVersion` as `lastRunFsVersion` right after its
 * action (Run / Bundle & Run) finishes — by then every VFS write the action
 * itself made (e.g. Bundle & Run's `/dist` assembly) is already reflected in
 * `fsVersion`. So if `fsVersion` is still equal to `lastRunFsVersion` when the
 * `live` timer fires, nothing happened since the run completed except the
 * run's OWN writes — re-running would just re-produce the same writes forever
 * (Bundle & Run's self-sustaining rebuild loop). Only a STRICTLY GREATER
 * `fsVersion` means a real external edit landed after the run settled.
 */
export function shouldRerun(currentFsVersion: number, lastRunFsVersion: number): boolean {
  return currentFsVersion > lastRunFsVersion;
}
