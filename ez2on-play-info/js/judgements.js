// osu! judgements expressed in the EZ2ON REBOOT : R colour language.
// Each overlay folder carries its own copy so it can be installed on its own.

export const MODE_STANDARD = 0;
export const MODE_TAIKO = 1;
export const MODE_CATCH = 2;
export const MODE_MANIA = 3;

/** Tones sampled from the EZ2ON result card chips (KOOL, COOL, GOOD, MISS, FAIL, RATE). */
export const TONES = Object.freeze({
  kool: "#14d8ea",
  cool: "#ecaf20",
  good: "#df843e",
  // EZ2ON has five judgements; mania's sixth (100) gets a green between GOOD and MISS.
  ok: "#55c46a",
  miss: "#d0262c",
  fail: "#9037ea",
  rate: "#929292",
});

const MANIA_MAX = 305;

/**
 * Judgements per ruleset, best first. `key` is the field in the API `hits` object.
 * `weight` drives the rate: only an all-best play reaches 100 %. Geki/katu stay ignored outside
 * mania, where they carry 320 and 200. `hidden` entries count toward the rate but are not shown.
 * `scoreV1Weight` is stable's mania accuracy without ScoreV2, where 320 is worth the same as 300.
 */
export const MODE_JUDGEMENTS = Object.freeze({
  [MODE_STANDARD]: [
    { label: "300", key: "300", tone: "kool", weight: 1 },
    { label: "100", key: "100", tone: "cool", weight: 1 / 3 },
    { label: "50", key: "50", tone: "good", weight: 1 / 6 },
    { label: "0", key: "0", tone: "fail", weight: 0 },
  ],
  [MODE_TAIKO]: [
    { label: "300", key: "300", tone: "kool", weight: 1 },
    { label: "100", key: "100", tone: "cool", weight: 0.5 },
    { label: "0", key: "0", tone: "fail", weight: 0 },
  ],
  // Catch has only GREAT (fruits, `300`) and MISS (`0`, which in vosu's legacy layout also holds
  // missed large droplets). Caught large droplets (`100`) still count toward the rate so it can
  // reach 100 % only on a full catch; small droplets stay out of it, as in the map's max combo.
  [MODE_CATCH]: [
    { label: "300", key: "300", tone: "kool", weight: 1 },
    { label: "100", key: "100", tone: "cool", weight: 1, hidden: true },
    { label: "0", key: "0", tone: "fail", weight: 0 },
  ],
  [MODE_MANIA]: [
    { label: "320", key: "geki", tone: "kool", weight: 1, scoreV1Weight: 1 },
    { label: "300", key: "300", tone: "cool", weight: 300 / MANIA_MAX, scoreV1Weight: 1 },
    { label: "200", key: "katu", tone: "good", weight: 200 / MANIA_MAX, scoreV1Weight: 2 / 3 },
    { label: "100", key: "100", tone: "ok", weight: 100 / MANIA_MAX, scoreV1Weight: 1 / 3 },
    { label: "50", key: "50", tone: "miss", weight: 50 / MANIA_MAX, scoreV1Weight: 1 / 6 },
    { label: "0", key: "0", tone: "fail", weight: 0, scoreV1Weight: 0 },
  ],
});

function rateJudgementsFor(mode) {
  return MODE_JUDGEMENTS[mode] ?? MODE_JUDGEMENTS[MODE_STANDARD];
}

/** Judgements displayed for the ruleset (counts, popups, chips). */
export function judgementsFor(mode) {
  return rateJudgementsFor(mode).filter((judgement) => !judgement.hidden);
}

export function countOf(hits, judgement) {
  const value = hits?.[judgement.key];
  return Number.isFinite(value) && value > 0 ? value : 0;
}

// Highest key count the legacy converter picks for an osu!standard map without a key mod.
const MAX_CONVERT_KEYS = 7;

/** Acronyms of the active mods, from the API `play.mods` / `resultsScreen.mods` object. */
function modAcronyms(mods) {
  return new Set((mods?.array ?? []).map((mod) => mod?.acronym));
}

/**
 * How the client scores the play. stable's ScoreV2 (`V2` in vosu's stable mod list) changes which
 * objects are judged; lazer's SV2 changes neither the judgements nor the accuracy.
 */
function scoringOf({ client, mods }) {
  const acronyms = modAcronyms(mods);
  const lazer = client === "lazer";
  return { acronyms, lazer, scoreV2: !lazer && (acronyms.has("V2") || acronyms.has("SV2")) };
}

/**
 * Columns an osu!standard convert is played on. vosu's converted CS is only a display estimate
 * that can sit below the converter's real choice, so take the converter's ceiling instead: an
 * upper bound can only lower the expected count, which judgeRate's `max` absorbs by the map end.
 */
function convertColumns(acronyms) {
  let keys = MAX_CONVERT_KEYS;
  for (const acronym of acronyms) {
    const match = /^(\d+)K$/.exec(acronym ?? "");
    if (match) keys = Number(match[1]);
  }
  return acronyms.has("DS") ? keys * 2 : keys;
}

const roundEven = (n) => {
  const lo = Math.floor(n);
  return n - lo === 0.5 ? lo + (lo % 2 !== 0 ? 1 : 0) : Math.round(n);
};

/**
 * Columns a native mania map puts notes in, from its .osu text; null for any other map. Invert's
 * judgement count depends on it, and the beatmap stats do not carry it.
 */
export function usedManiaColumns(text) {
  if (!text || !/^\s*Mode\s*:\s*3\s*$/m.test(text)) return null;
  const cs = Number(/^\s*CircleSize\s*:\s*([\d.]+)/m.exec(text)?.[1]);
  const section = text.split(/^\s*\[HitObjects\]\s*$/m)[1];
  if (!Number.isFinite(cs) || section === undefined) return null;
  const keys = Math.max(1, roundEven(cs));
  const used = new Set();
  for (const line of section.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    // lazer truncates positions to integers before picking the column.
    const x = Math.trunc(Number.parseFloat(line));
    if (Number.isFinite(x) && line.includes(",")) {
      used.add(Math.min(keys - 1, Math.max(0, Math.floor((x * keys) / 512))));
    }
  }
  return used.size;
}

function maniaJudgements(objects, { acronyms, keys, usedColumns, splitHolds }) {
  const circles = objects.circles ?? 0;
  const holds = objects.holds ?? 0;
  // Converted map: the converter decides the notes, so the object count stands in for them. Each
  // object yields at least one note, so this never overshoots.
  const converted = holds === 0 && (objects.sliders ?? 0) > 0;
  const notes = converted ? (objects.total ?? 0) : circles + holds;
  // Hold Off and Invert are lazer-only, so their holds always judge head and tail separately.
  if (acronyms.has("HO")) return notes;
  if (acronyms.has("IN")) {
    // Every note becomes a hold reaching the next note in its column, so each column that has
    // notes loses its last one. Until the beatmap file has loaded, every column counts as used.
    const columns = converted ? convertColumns(acronyms) : (usedColumns ?? Math.round(keys ?? 0));
    return 2 * Math.max(0, notes - columns);
  }
  if (converted) return notes;
  return circles + holds * (splitHolds ? 2 : 1);
}

/**
 * Judgements the whole map will produce for this ruleset, from the beatmap statistics and the
 * active mods. `keys` is the mania key count (the converted CS); `usedColumns` comes from
 * usedManiaColumns. Counts per client, checked against stable's scores.db:
 * - mania: lazer and stable's ScoreV2 judge a hold's head and tail separately; stable without
 *   ScoreV2 judges a hold once.
 * - taiko: drum rolls and swells are bonus objects, except under stable's ScoreV2, which judges
 *   each of them once.
 */
export function expectedJudgements(mode, { objects, maxCombo, client, mods, keys, usedColumns }) {
  if (!objects) return 0;
  const { acronyms, lazer, scoreV2 } = scoringOf({ client, mods });
  switch (mode) {
    case MODE_MANIA:
      return maniaJudgements(objects, { acronyms, keys, usedColumns, splitHolds: lazer || scoreV2 });
    case MODE_TAIKO:
      // A converted slider may become several hits instead of a drum roll, so this can only
      // undershoot on converts.
      return (objects.circles ?? 0) + (scoreV2 ? (objects.sliders ?? 0) + (objects.spinners ?? 0) : 0);
    case MODE_CATCH:
      // Fruits plus large droplets: exactly the combo-giving objects.
      return maxCombo ?? 0;
    default:
      return objects.total ?? 0;
  }
}

/**
 * Accuracy measured against the entire map rather than the notes judged so far: 0 % at the start,
 * 100 % only when every object received a judgement worth full accuracy. `client` and `mods` pick
 * the client's mania weights, so a mania rate ends at the accuracy the game shows; catch differs,
 * as its small droplets stay out of the rate.
 */
export function judgeRate(mode, hits, expected, { client, mods } = {}) {
  const judgements = rateJudgementsFor(mode);
  const { lazer, scoreV2 } = scoringOf({ client, mods });
  const scoreV1 = !lazer && !scoreV2;
  let judged = 0;
  let points = 0;
  for (const judgement of judgements) {
    const count = countOf(hits, judgement);
    judged += count;
    points += count * (scoreV1 ? (judgement.scoreV1Weight ?? judgement.weight) : judgement.weight);
  }
  const total = Math.max(expected, judged);
  return total > 0 ? (points / total) * 100 : 0;
}

export function formatRate(rate) {
  // Floors like osu!, but a value that is a hair under a hundredth only through float error
  // (29 / 100 * 100 = 28.999999999999996) must not drop a digit.
  return `${(Math.floor(rate * 100 + 1e-9) / 100).toFixed(2)}%`;
}
