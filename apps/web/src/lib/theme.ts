export type Theme = "dark" | "light";
const KEY = "erdou.theme";
export function getTheme(): Theme {
  return (localStorage.getItem(KEY) as Theme) || "dark";
}
export function applyTheme(t: Theme): void {
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem(KEY, t);
}
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === "dark" ? "light" : "dark";
  applyTheme(next);
  return next;
}
