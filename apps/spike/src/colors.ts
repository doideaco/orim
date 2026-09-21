import type { PaletteColor } from "@orim/schema";

/** Placeholder palette: every fill/text pair clears WCAG AA for normal text. */
export const PALETTE: Record<PaletteColor, { fill: string; text: string; edge: string }> = {
  gray:   { fill: "#E7E5E4", text: "#292524", edge: "#D6D3D1" },
  blue:   { fill: "#BFDBFE", text: "#1E3A5F", edge: "#93C5FD" },
  teal:   { fill: "#99F6E4", text: "#134E4A", edge: "#5EEAD4" },
  green:  { fill: "#BBF7D0", text: "#14532D", edge: "#86EFAC" },
  yellow: { fill: "#FDE68A", text: "#57430A", edge: "#FCD34D" },
  orange: { fill: "#FED7AA", text: "#7C2D12", edge: "#FDBA74" },
  red:    { fill: "#FECACA", text: "#7F1D1D", edge: "#FCA5A5" },
  pink:   { fill: "#FBCFE8", text: "#831843", edge: "#F9A8D4" },
  violet: { fill: "#DDD6FE", text: "#3B2C74", edge: "#C4B5FD" },
};

export const PALETTE_KEYS = Object.keys(PALETTE) as PaletteColor[];

export const CURSOR_COLORS = [
  "#4F7CFF", "#E0529C", "#0DA678", "#E28413", "#8B5CF6", "#DC2626",
];
