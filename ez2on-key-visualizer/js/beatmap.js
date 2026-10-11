import { maniaNotes } from "./convert.js";
import { createManiaRandomColumnMap } from "./maniaRandom.js";

// Legacy (stable) mod bits; lazer reports the same bits next to its acronyms.
const MOD_KEY_BITS = [
  [1 << 26, 1],
  [1 << 28, 2],
  [1 << 27, 3],
  [1 << 15, 4],
  [1 << 16, 5],
  [1 << 17, 6],
  [1 << 18, 7],
  [1 << 19, 8],
  [1 << 24, 9],
];
const MOD_COOP = 1 << 25;
const MOD_RANDOM = 1 << 21;
const MOD_MIRROR = 1 << 30;

/** Mods that change which notes exist or where they land, read from the API `play.mods` object. */
export function noteMods(mods) {
  const acronyms = new Set((mods?.array ?? []).map((mod) => mod?.acronym));
  const bits = Number(mods?.number) || 0;
  let targetKeys = null;
  for (const acronym of acronyms) {
    const match = /^(\d+)K$/.exec(acronym ?? "");
    if (match) targetKeys = Number(match[1]);
  }
  if (targetKeys === null) {
    for (const [bit, keys] of MOD_KEY_BITS) if (bits & bit) targetKeys = keys;
  }
  return {
    targetKeys,
    dual: acronyms.has("DS") || (bits & MOD_COOP) !== 0,
    holdOff: acronyms.has("HO"),
    invert: acronyms.has("IN"),
    random: acronyms.has("RD") || (bits & MOD_RANDOM) !== 0,
    randomSeed: mods?.array?.find((mod) => mod?.acronym === "RD")?.settings?.seed,
    mirror: acronyms.has("MR") || (bits & MOD_MIRROR) !== 0,
  };
}

/**
 * Per-column note arrays for the map as the mania ruleset plays it: native maps pass through,
 * osu!standard maps go through the legacy converter (key mods, Dual Stages), then Hold Off,
 * Invert, Random and Mirror apply. Returns null when the notes cannot be reproduced (taiko/catch
 * maps, or stable Random whose seed is not exposed).
 */
export function buildColumns(text, mods) {
  const options = noteMods(mods);
  const result = maniaNotes(text, options);
  if (!result) return null;
  const { keyCount } = result;
  const [starts, ends, lanes] = result.notes;

  let map = null;
  if (options.random) {
    if (!Number.isInteger(options.randomSeed)) return null;
    map = createManiaRandomColumnMap(keyCount, options.randomSeed);
  }

  const perColumn = Array.from({ length: keyCount }, () => []);
  for (let i = 0; i < starts.length; i++) {
    let column = lanes[i];
    // lazer: Random sets Column = shuffled[Column]; Mirror sets Column = total - 1 - Column.
    if (map) column = map[column];
    if (options.mirror) column = keyCount - 1 - column;
    perColumn[column].push(i);
  }

  const columns = perColumn.map((indices) => {
    indices.sort((a, b) => starts[a] - starts[b]);
    const columnStarts = new Float64Array(indices.length);
    const columnEnds = new Float64Array(indices.length);
    const rawEnds = new Float64Array(indices.length);
    let maxEnd = Number.NEGATIVE_INFINITY;
    indices.forEach((note, i) => {
      columnStarts[i] = starts[note];
      rawEnds[i] = ends[note];
      // Running maximum keeps `ends` sorted even if notes overlap within a column.
      maxEnd = Math.max(maxEnd, ends[note]);
      columnEnds[i] = maxEnd;
    });
    return { starts: columnStarts, ends: columnEnds, rawEnds };
  });

  // lazer splits native maps above 10K into two stages; Dual Stages doubles converts.
  const native = /^\s*Mode\s*:\s*3\s*$/m.test(text);
  const stages = (native ? keyCount > 10 : options.dual) ? 2 : 1;
  return { keyCount, stages, columns };
}

/** Index of the first element in a sorted Float64Array that is >= value. */
export function lowerBound(array, value) {
  let low = 0;
  let high = array.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (array[mid] < value) low = mid + 1;
    else high = mid;
  }
  return low;
}
