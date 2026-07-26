import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { THEMES, getTheme, applyTheme, type Theme } from "../lib/theme.js";

/** Notify on every theme change, whoever made it: applyTheme stamps `data-theme`
 *  on <html> before persisting, so that attribute is the one signal every applier
 *  passes through — including Studio.mountFolder applying a mounted folder's
 *  .erdou/config.json theme, which this component never hears about otherwise. */
export function subscribeToTheme(onThemeChange: () => void): () => void {
  const observer = new MutationObserver(onThemeChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

/** Titlebar theme picker: a swatch button that opens a popover of the themes,
 *  each previewed by its background/accent/ink dots. Applying persists (theme.ts)
 *  and calls onChange so the app can mirror the choice to the mounted folder. */
export function ThemeMenu({ onChange }: { onChange?: () => void }) {
  const [open, setOpen] = useState(false);
  // Re-derived, never latched: seeding `current` from useState left the swatch
  // and the picker's checkmark showing the old theme after an OUTSIDE applyTheme
  // (mounting a folder whose config says "cream" repainted the page but not this
  // menu) — TitleBar/ThemeMenu are rendered without a key, so they never remount.
  const current = useSyncExternalStore<Theme>(subscribeToTheme, getTheme, getTheme);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  function pick(id: Theme) {
    applyTheme(id); // the attribute write re-renders us through subscribeToTheme
    setOpen(false);
    onChange?.();
  }

  const active = THEMES.find((t) => t.id === current) ?? THEMES[0]!;

  return (
    <div className="theme-menu" ref={ref}>
      <button
        className="btn ghost theme-btn"
        aria-label={`Theme: ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <ThemeSwatch swatch={active.swatch} />
      </button>
      {open && (
        <ul className="ui-select-pop theme-pop" role="menu">
          {THEMES.map((t) => (
            <li
              key={t.id}
              role="menuitemradio"
              aria-checked={t.id === current}
              className={"ui-select-opt theme-opt" + (t.id === current ? " active" : "")}
              onClick={() => pick(t.id)}
            >
              <ThemeSwatch swatch={t.swatch} />
              <span>{t.label}</span>
              {t.id === current && <span className="theme-check">✓</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ThemeSwatch({ swatch }: { swatch: readonly [string, string, string] }) {
  const [bg, accent, ink] = swatch;
  return (
    <span className="theme-swatch" style={{ background: bg }} aria-hidden="true">
      <span className="theme-swatch-dot" style={{ background: accent }} />
      <span className="theme-swatch-dot" style={{ background: ink }} />
    </span>
  );
}
