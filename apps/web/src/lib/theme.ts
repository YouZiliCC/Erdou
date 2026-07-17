// Theme registry. Each theme is a set of CSS custom properties defined in
// styles.css under :root[data-theme="<id>"] (":root" itself is the "dark"
// default). Switching = stamping data-theme on <html> + persisting the id.
// "dark"/"light" ids are kept for backward compat with saved configs.

export type Theme = "dark" | "light" | "erdou" | "cream";

/** A theme's picker entry: three swatch colors preview [background, accent, ink]. */
export interface ThemeDef {
  readonly id: Theme;
  readonly label: string;
  readonly swatch: readonly [string, string, string];
}

/** Order is the picker order. "dark" (Ink) is the default. */
export const THEMES: readonly ThemeDef[] = [
  { id: "dark", label: "Ink", swatch: ["#0d0d0d", "#58a6ff", "#ededed"] },
  { id: "light", label: "Paper", swatch: ["#ffffff", "#58a6ff", "#0d0d0d"] },
  { id: "erdou", label: "二豆", swatch: ["#18110b", "#e07a3c", "#f1e3c9"] },
  { id: "cream", label: "Cream", swatch: ["#fbf5e9", "#c15e22", "#2c1d10"] },
];

const KEY = "erdou.theme";
const IDS = new Set(THEMES.map((t) => t.id));

export function getTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  return saved && IDS.has(saved as Theme) ? (saved as Theme) : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(KEY, t);
}

/** Advance to the next theme in registry order (wraps). Returns the new id. */
export function cycleTheme(): Theme {
  const ids = THEMES.map((t) => t.id);
  const next = ids[(ids.indexOf(getTheme()) + 1) % ids.length] ?? "dark";
  applyTheme(next);
  return next;
}

/** Back-compat: the old ◐ dark/light toggle. Prefer cycleTheme / the picker. */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "light" ? "dark" : "light";
  applyTheme(next);
  return next;
}
