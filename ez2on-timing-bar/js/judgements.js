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
    { label: "320", key: "geki", tone: "kool", weight: 1 },
    { label: "300", key: "300", tone: "cool", weight: 300 / MANIA_MAX },
    { label: "200", key: "katu", tone: "good", weight: 200 / MANIA_MAX },
    { label: "100", key: "100", tone: "ok", weight: 100 / MANIA_MAX },
    { label: "50", key: "50", tone: "miss", weight: 50 / MANIA_MAX },
    { label: "0", key: "0", tone: "fail", weight: 0 },
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

/**
 * Judgements the whole map will produce for this ruleset, from the beatmap statistics.
 * lazer judges mania hold heads and tails separately; stable judges a hold once.
 */
export function expectedJudgements(mode, { objects, maxCombo, client }) {
  if (!objects) return 0;
  const circles = objects.circles ?? 0;
  const holds = objects.holds ?? 0;
  switch (mode) {
    case MODE_MANIA:
      if (holds === 0 && (objects.sliders ?? 0) > 0) {
        // Converted map: hold count is decided by the converter, so fall back to object count.
        return objects.total ?? 0;
      }
      return circles + holds * (client === "lazer" ? 2 : 1);
    case MODE_TAIKO:
      // Drum rolls and swells are bonus objects in lazer and stable alike.
      return circles;
    case MODE_CATCH:
      // Fruits plus large droplets: exactly the combo-giving objects.
      return maxCombo ?? 0;
    default:
      return objects.total ?? 0;
  }
}

/**
 * Accuracy measured against the entire map rather than the notes judged so far: 0 % at the start,
 * 100 % only when every object received the best judgement.
 */
export function judgeRate(mode, hits, expected) {
  const judgements = rateJudgementsFor(mode);
  let judged = 0;
  let points = 0;
  for (const judgement of judgements) {
    const count = countOf(hits, judgement);
    judged += count;
    points += count * judgement.weight;
  }
  const total = Math.max(expected, judged);
  return total > 0 ? (points / total) * 100 : 0;
}

export function formatRate(rate) {
  return `${(Math.floor(rate * 100) / 100).toFixed(2)}%`;
}
