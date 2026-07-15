import type { SVGProps } from "react";

/** Shared defaults for the tree's line icons: 14px, single-color via `currentColor`. */
const base: SVGProps<SVGSVGElement> = {
  width: 14,
  height: 14,
  viewBox: "0 0 16 16",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
};

/** Closed folder outline. */
export function Folder(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2 4.5c0-.55.45-1 1-1h2.8l1.2 1.5h6c.55 0 1 .45 1 1v5.5c0 .55-.45 1-1 1H3c-.55 0-1-.45-1-1z" />
    </svg>
  );
}

/** Open folder: the back tab plus a wider, scooped-open front flap. */
export function FolderOpen(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M2 4.5c0-.55.45-1 1-1h2.8l1.2 1.5h6c.55 0 1 .45 1 1v.5H2z" />
      <path d="M1.6 6.5h11.8c.65 0 1.1.65.9 1.27l-1.2 3.73a1 1 0 0 1-.95.7H2.85a1 1 0 0 1-.95-.7L.7 7.77c-.2-.62.25-1.27.9-1.27z" />
    </svg>
  );
}

/** A document with a folded top-right corner. */
export function File(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M4 1.5h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" />
      <path d="M9 1.5v3h3" />
    </svg>
  );
}

/** Right-pointing chevron; rotate it via a CSS class/transform to show expanded state. */
export function Chevron(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...base} {...props}>
      <path d="M6 3.5l5 4.5-5 4.5" />
    </svg>
  );
}
