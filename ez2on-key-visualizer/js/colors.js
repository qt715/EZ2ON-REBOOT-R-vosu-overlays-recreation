// Lane colour defaults (BMS / O2Jam style) and parsing of "space separated RGBA" settings.

const NOTE = {
  W: "F4F2FFFF",
  C: "3FCBFFFF",
  Y: "FFD53DFF",
  R: "FF4B5CFF",
  G: "4FE08AFF",
};

// Each press colour contrasts with the note colour of its lane.
const PRESS_FOR_NOTE = {
  W: "FF5FAEFF", // pink
  C: "FF9B3DFF", // orange
  Y: "A66BFFFF", // purple
  R: "4DA3FFFF", // blue
  G: "FFFFFFFF", // white
};

const LAYOUTS = {
  1: "W",
  2: "WW",
  3: "WCW",
  4: "WCCW",
  5: "WCYCW",
  6: "WCYYCW",
  7: "WCWYWCW",
  8: "RWCWYWCW",
  9: "RWCWYWCWR",
  10: "RWCWYGWCWR",
};

export const MAX_SETTING_KEYS = 10;

export function defaultNoteColors(keys) {
  return [...LAYOUTS[keys]].map((tone) => NOTE[tone]).join(" ");
}

export function defaultHitColors(keys) {
  return [...LAYOUTS[keys]].map((tone) => PRESS_FOR_NOTE[tone]).join(" ");
}

export const DEFAULT_MODE_HIT_COLORS = {
  standard: "FF5FAEFF 4DA3FFFF A66BFFFF FF9B3DFF",
  taiko: "4DA3FFFF FF5FAEFF FF5FAEFF 4DA3FFFF",
  catch: "FF5FAEFF 4DA3FFFF A66BFFFF",
};

const WHITE = [1, 1, 1, 1];

/** Parses one RGBA token: RRGGBBAA or RRGGBB, with or without '#'. */
function parseToken(token) {
  const hex = token.replace(/^#/, "");
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) return null;
  const channel = (index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255;
  return [channel(0), channel(2), channel(4), hex.length === 8 ? channel(6) : 1];
}

/**
 * Lane colours for `count` lanes. Missing or invalid tokens fall back to the default list, so a
 * partially edited setting still renders every lane.
 */
export function parseColorList(text, fallbackText, count) {
  const parsed = String(text ?? "")
    .trim()
    .split(/\s+/)
    .map(parseToken);
  const fallback = String(fallbackText ?? "")
    .trim()
    .split(/\s+/)
    .map(parseToken);
  const colors = [];
  for (let i = 0; i < count; i++) {
    colors.push(parsed[i] ?? fallback[i] ?? fallback[fallback.length - 1] ?? WHITE);
  }
  return colors;
}
