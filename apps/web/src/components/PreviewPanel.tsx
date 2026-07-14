import { useState } from "react";
import type { Studio } from "../lib/studio.js";
import { buildPreview, type PreviewResult } from "../lib/preview-build.js";

export function PreviewPanel({ studio }: { studio: Studio }) {
  const [result, setResult] = useState<PreviewResult | null>(null);
  const [building, setBuilding] = useState(false);

  async function build() {
    setBuilding(true);
    try {
      setResult(await buildPreview(studio.runtime.fs));
    } catch (err) {
      setResult({ entry: null, errors: [err instanceof Error ? err.message : String(err)] });
    } finally {
      setBuilding(false);
    }
  }

  return (
    <div className="preview">
      <div className="preview-bar">
        <button className="btn primary" onClick={() => void build()} disabled={building}>
          {building ? "Building…" : "Build & Run"}
        </button>
        {result?.entry && <span className="entry">entry: {result.entry}</span>}
      </div>
      {!result && (
        <div className="hint">
          Bundles the project with esbuild-wasm and runs it in an isolated iframe — npm deps load from esm.sh, no
          install. Ask the agent to build a React app, then Build &amp; Run. (First build downloads the bundler.)
        </div>
      )}
      {result && result.errors.length > 0 ? (
        <div className="build-errors">
          <pre>{result.errors.join("\n\n")}</pre>
        </div>
      ) : result?.html ? (
        <iframe className="preview-frame" title="preview" sandbox="allow-scripts" srcDoc={result.html} />
      ) : null}
    </div>
  );
}
