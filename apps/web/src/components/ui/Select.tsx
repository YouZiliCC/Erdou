import { useEffect, useRef, useState } from "react";
import { Chevron } from "./icons.js";

/** Structural subset of React.KeyboardEvent — everything handleSelectKey touches. */
export interface SelectKeyEvent {
  key: string;
  preventDefault(): void;
  stopPropagation(): void;
}

/** The effects the key policy asks the component (which owns the state) for. */
export interface SelectKeyActions {
  openList(): void;
  move(delta: 1 | -1): void;
  choose(): void;
  close(): void;
}

/**
 * Keydown policy for the trigger button, split out of the component so this
 * layering contract is testable without a DOM.
 *
 * A key this Select acts on is CONSUMED, propagation included: SyntheticEvent's
 * stopPropagation forwards to the native event, which React 18 is dispatching
 * at the root container, so the keydown never reaches the document-level
 * listeners below it. Without that, Escape on an open popover inside
 * SettingsDialog closed the popover AND the dialog — discarding every unsaved
 * field, a typed API key included. A CLOSED popover consumes nothing, so
 * Escape then still reaches the surface hosting the Select and closes it: the
 * innermost open layer, and only that one.
 */
export function handleSelectKey(e: SelectKeyEvent, open: boolean, on: SelectKeyActions): void {
  const consume = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (!open) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
      consume();
      on.openList();
    }
    return;
  }
  if (e.key === "ArrowDown") {
    consume();
    on.move(1);
  } else if (e.key === "ArrowUp") {
    consume();
    on.move(-1);
  } else if (e.key === "Enter") {
    consume();
    on.choose();
  } else if (e.key === "Escape") {
    consume();
    on.close();
  }
}

/** Token-styled replacement for a native `<select>`: a button showing the
 *  current label, opening a popover `listbox` underneath. Dependency-free —
 *  no portal, no combobox search, no virtualization (the option lists here
 *  are always tiny). */
export function Select<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  ariaLabel?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selectedIndex = options.findIndex((o) => o.value === value);
  const current = options[selectedIndex] ?? options[0];

  // Click-outside closes the popover.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  function openList() {
    setActive(selectedIndex >= 0 ? selectedIndex : 0);
    setOpen(true);
  }

  function choose(index: number) {
    const opt = options[index];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    handleSelectKey(e, open, {
      openList,
      move: (delta) => setActive((i) => Math.min(options.length - 1, Math.max(0, i + delta))),
      choose: () => choose(active),
      close: () => setOpen(false),
    });
  }

  return (
    <div className={"ui-select" + (className ? " " + className : "")} ref={rootRef}>
      <button
        type="button"
        className="ui-select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : openList())}
        onKeyDown={onKeyDown}
      >
        <span className="ui-select-label">{current?.label ?? ""}</span>
        <Chevron className="ui-select-chev" />
      </button>
      {open && (
        <ul className="ui-select-pop" role="listbox">
          {options.map((opt, i) => (
            <li
              key={opt.value}
              role="option"
              aria-selected={opt.value === value}
              className={"ui-select-opt" + (i === active ? " active" : "")}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(i)}
            >
              {opt.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
