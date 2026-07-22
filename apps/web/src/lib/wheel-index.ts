// The local wheel index: turns `wheels.json` (pinned pure-Python wheels for the
// document skills) into a LocalWheelResolver for @erdou/lang-python's pip. The
// browser kernel installs a bundled package (python-pptx/docx/openpyxl/fpdf2 +
// their pure-Python closure) from same-origin wheel URLs — offline, version-
// locked — while native deps (lxml/Pillow) still come from Pyodide's lockfile.
// The app owns this manifest + the normalization; lang-python only calls the
// resolver (layering invariant).

export interface WheelEntry {
  readonly version: string;
  readonly file: string;
  readonly url: string;
  readonly sha256: string;
}

export interface WheelManifest {
  /** Native deps deliberately NOT bundled — resolved from Pyodide's lockfile. */
  readonly pyodideProvided: readonly string[];
  /** Top package (as a user would `pip install` it) → its pure-Python closure. */
  readonly closures: Record<string, readonly string[]>;
  /** Every bundled wheel, keyed by distribution name. */
  readonly wheels: Record<string, WheelEntry>;
}

/**
 * Normalize a pip requirement to a bare, comparable key: strip the version /
 * extras / marker tail, lowercase, and fold `_`→`-` (PEP 503 name normalization,
 * enough for our fixed manifest). `python-pptx==1.0.2` and `Python_PPTX` both
 * become `python-pptx`.
 */
export function normalizeReq(req: string): string {
  const bare = req.split(/[=<>!~;[ ]/)[0] ?? req;
  return bare.trim().toLowerCase().replace(/_/g, "-");
}

/**
 * Build a resolver: a bundled top package → its closure of same-origin wheel
 * URLs; a bundled leaf wheel → just its own URL; anything else → null (pip then
 * uses the loadPackage/micropip path). Fails fast if a closure references a
 * wheel the manifest doesn't pin (manifest integrity error, surfaced at build/
 * boot rather than as a silent missing install).
 */
export function buildLocalWheelResolver(
  manifest: WheelManifest,
  origin: string,
): (requirement: string) => string[] | null {
  const closures = new Map<string, readonly string[]>();
  for (const [top, members] of Object.entries(manifest.closures)) closures.set(normalizeReq(top), members);
  const wheelByName = new Map<string, WheelEntry>();
  for (const [name, entry] of Object.entries(manifest.wheels)) wheelByName.set(normalizeReq(name), entry);

  const base = origin.replace(/\/$/, "");
  const urlFor = (name: string): string => {
    const entry = wheelByName.get(normalizeReq(name));
    if (!entry) throw new Error(`wheel-index: manifest has no wheel for "${name}" (referenced by a closure)`);
    return `${base}/wheels/${entry.file}`;
  };

  return (requirement) => {
    // Only the BARE name uses the offline bundle. Any version pin / range /
    // extras falls through (null) so micropip resolves it from PyPI and honors
    // the exact request — never a silent substitution of the bundled version.
    if (/[=<>!~;[\] ]/.test(requirement.trim())) return null;
    const key = normalizeReq(requirement);
    const members = closures.get(key);
    if (members) return members.map(urlFor);
    if (wheelByName.has(key)) return [urlFor(key)];
    return null;
  };
}
