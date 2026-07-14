import { useState, useEffect, useRef } from "react";
import type { Studio } from "../lib/studio.js";
import { buildSite, publishSite, previewUrl } from "../lib/preview-sw.js";
import { buildPreview } from "../lib/preview-build.js";

const SITE_ID = "app";

export function PreviewPanel({ studio }: { studio: Studio }) {
  const [errors, setErrors] = useState<string[]>([]);
  const [entry, setEntry] = useState<string | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [live, setLive] = useState(false);
  const built = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  async function build(): Promise<void> {
    setBuilding(true);
    try {
      const site = await buildSite(studio.runtime.fs);
      setEntry(site.entry);
      if (site.errors.length > 0 || !site.files) {
        setErrors(site.errors);
        return;
      }
      const served = await publishSite(SITE_ID, site.files);
      if (served) {
        setSrcDoc(null);
        setSrc(previewUrl(SITE_ID, Date.now()));
        setErrors([]);
      } else {
        // Fallback: a self-contained srcdoc bundle (no service worker available).
        const pv = await buildPreview(studio.runtime.fs);
        if (pv.errors.length > 0 || !pv.html) setErrors(pv.errors);
        else {
          setSrc(null);
          setSrcDoc(pv.html);
          setErrors([]);
        }
      }
      built.current = true;
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setBuilding(false);
    }
  }

  // Live mode: rebuild shortly after the filesystem changes, once a build exists.
  useEffect(() => {
    if (!live || !built.current) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void build(), 1200);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studio.fsVersion, live]);

  return (
    <div className="preview">
      <div className="preview-bar">
        <button className="btn primary" onClick={() => void build()} disabled={building}>
          {building ? "Building…" : "Build & Run"}
        </button>
        <label className="live-toggle">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> live
        </label>
        {entry && <span className="entry">entry: {entry}</span>}
      </div>
      {!src && !srcDoc && errors.length === 0 && (
        <div className="hint">
          Bundles the project (esbuild-wasm) and serves it via a service worker — multi-file apps, static assets,
          fetch() and client-side routing all work in an isolated iframe. Ask the agent to build a React app, then
          Build &amp; Run.
        </div>
      )}
      {errors.length > 0 ? (
        <div className="build-errors">
          <pre>{errors.join("\n\n")}</pre>
        </div>
      ) : src ? (
        // The service worker only controls same-origin clients, so the SW-served
        // preview needs allow-same-origin. In production, serve it from a separate
        // origin to fully isolate it from the app.
        <iframe className="preview-frame" title="preview" sandbox="allow-scripts allow-same-origin" src={src} />
      ) : srcDoc ? (
        <iframe className="preview-frame" title="preview" sandbox="allow-scripts" srcDoc={srcDoc} />
      ) : null}
    </div>
  );
}
