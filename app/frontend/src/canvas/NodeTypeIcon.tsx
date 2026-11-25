/**
 * Unified 14x14 linear SVG icons (strokeWidth=1.5) for all node types across
 * AddNodePalette and NodeCard headers. Replaces mismatched Unicode glyphs.
 */
export function NodeTypeIcon({
  type,
  size = 13,
  className,
}: {
  type: string;
  size?: number;
  className?: string;
}) {
  const props = {
    width: size,
    height: size,
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className,
    "aria-hidden": true as const,
  };

  switch (type) {
    case "character":
      return (
        <svg {...props}>
          <circle cx="8" cy="5.5" r="2.75" />
          <path d="M3 13.5c0-2.5 2.2-4 5-4s5 1.5 5 4" />
        </svg>
      );
    case "image":
      return (
        <svg {...props}>
          <rect x="2" y="2.5" width="12" height="11" rx="2" />
          <circle cx="5.6" cy="6" r="1" fill="currentColor" stroke="none" />
          <path d="M2.5 11.5l3.2-3.2 2.4 2.4 2.2-2.2 3.2 3" />
        </svg>
      );
    case "Storyboard":
      return (
        <svg {...props}>
          <rect x="2" y="2.5" width="5" height="4.5" rx="1" />
          <rect x="9" y="2.5" width="5" height="4.5" rx="1" />
          <rect x="2" y="9" width="5" height="4.5" rx="1" />
          <rect x="9" y="9" width="5" height="4.5" rx="1" />
        </svg>
      );
    case "video":
      return (
        <svg {...props}>
          <rect x="2" y="3" width="12" height="10" rx="2" />
          <polygon points="6.6,5.6 11,8 6.6,10.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "visual_asset":
      return (
        <svg {...props}>
          <path d="M8 2L13.5 5v6L8 14l-5.5-3V5L8 2z" />
          <path d="M2.5 5L8 8l5.5-3M8 8v6" />
        </svg>
      );
    case "prompt":
      return (
        <svg {...props}>
          <path d="M8 2l1.2 3.3L12.5 6.5 9.2 7.7 8 11 6.8 7.7 3.5 6.5 6.8 5.3 8 2z" />
          <path d="M12.5 11v2.5M11.25 12.25h2.5" />
        </svg>
      );
    case "note":
      return (
        <svg {...props}>
          <path d="M3 2.5h10v8l-3 3H3V2.5z" />
          <path d="M10 13.5v-3h3M5.5 6h5M5.5 9h3.5" />
        </svg>
      );
    default:
      return (
        <svg {...props}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
        </svg>
      );
  }
}
