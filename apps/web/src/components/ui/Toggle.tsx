/** Token-styled replacement for a native `<input type="checkbox">`: a switch
 *  (track + sliding knob). It's a real `<button>`, so Space/Enter activation
 *  and focus styling come for free from the browser — no extra key handler
 *  needed (that would double-fire the click a `<button>` already synthesizes). */
export function Toggle({
  checked,
  onChange,
  label,
  ariaLabel,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label ? undefined : ariaLabel}
      className={"ui-toggle" + (checked ? " on" : "") + (className ? " " + className : "")}
      onClick={() => onChange(!checked)}
    >
      <span className="ui-toggle-track">
        <span className="ui-toggle-knob" />
      </span>
      {label && <span className="ui-toggle-label">{label}</span>}
    </button>
  );
}
