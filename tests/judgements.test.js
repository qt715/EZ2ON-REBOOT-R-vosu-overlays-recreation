import { describe, expect, test } from "bun:test";
import {
  MODE_MANIA,
  MODE_TAIKO,
  expectedJudgements,
  judgeRate,
  usedManiaColumns,
} from "../ez2on-judge-rate/js/judgements.js";
import { maniaNotes } from "../ez2on-key-visualizer/js/convert.js";

const mods = (...acronyms) => ({ array: acronyms.map((acronym) => ({ acronym })) });

/** Native mania map; each entry is [column, start] for a note or [column, start, end] for a hold. */
function maniaMap(keys, objects) {
  const lines = objects.map(([column, start, end]) => {
    const x = Math.floor(((column + 0.5) * 512) / keys);
    return end === undefined ? `${x},192,${start},1,0,0:0:0:0:` : `${x},192,${start},128,0,${end}:0:0:0:0:`;
  });
  return [
    "osu file format v14",
    "[General]",
    "Mode: 3",
    "[Difficulty]",
    "HPDrainRate:5",
    `CircleSize:${keys}`,
    "OverallDifficulty:5",
    "ApproachRate:5",
    "SliderMultiplier:1.4",
    "[TimingPoints]",
    "0,500,4,1,0,100,1,0",
    "[HitObjects]",
    ...lines,
    "",
  ].join("\n");
}

function statsOf(objects) {
  const holds = objects.filter((object) => object.length === 3).length;
  return { circles: objects.length - holds, sliders: 0, spinners: 0, holds, total: objects.length };
}

/** Judgements lazer produces for the map: one per note, head and tail per hold. */
function lazerJudgements(text, options) {
  const [starts, ends] = maniaNotes(text, options).notes;
  let count = starts.length;
  for (let i = 0; i < starts.length; i++) if (ends[i] > starts[i]) count++;
  return count;
}

function expectedFor(objects, keys, acronyms) {
  const text = maniaMap(keys, objects);
  return expectedJudgements(MODE_MANIA, {
    objects: statsOf(objects),
    client: "lazer",
    mods: mods(...acronyms),
    keys,
    usedColumns: usedManiaColumns(text),
  });
}

describe("mania Invert", () => {
  test("a perfect partial play stays below 100% when lanes go unused", () => {
    // Four notes in one lane of a 4K map become three holds: six judgements.
    const objects = [0, 500, 1000, 1500].map((start) => [0, start]);
    const expected = expectedFor(objects, 4, ["IN"]);
    expect(expected).toBe(6);
    expect(judgeRate(MODE_MANIA, { geki: 1 }, expected)).toBeCloseTo(100 / 6, 6);
    expect(judgeRate(MODE_MANIA, { geki: 6 }, expected)).toBe(100);
  });

  test("matches lazer's note generation with holds and empty lanes", () => {
    const objects = [
      [0, 0],
      [0, 400, 900],
      [0, 1200],
      [2, 300],
      [2, 800, 1600],
      [5, 1000],
    ];
    const text = maniaMap(7, objects);
    expect(expectedFor(objects, 7, ["IN"])).toBe(lazerJudgements(text, { invert: true }));
  });
});

describe("mania Hold Off", () => {
  test("a perfect play reaches 100% on the last note, not before", () => {
    const objects = [
      [0, 0],
      [1, 250, 750],
      [2, 500, 1500],
      [3, 1000],
    ];
    const text = maniaMap(4, objects);
    const expected = expectedFor(objects, 4, ["HO"]);
    expect(expected).toBe(lazerJudgements(text, { holdOff: true }));
    expect(judgeRate(MODE_MANIA, { geki: expected - 1 }, expected)).toBeLessThan(100);
    expect(judgeRate(MODE_MANIA, { geki: expected }, expected)).toBe(100);
  });
});

// Counts and accuracies below match stable's own scores (scores.db) on the same maps.
describe("stable", () => {
  const maniaObjects = { circles: 100, holds: 40, sliders: 0, spinners: 0, total: 140 };

  test("mania judges a hold once without ScoreV2 and head plus tail with it", () => {
    const count = (client, ...acronyms) =>
      expectedJudgements(MODE_MANIA, { objects: maniaObjects, client, mods: mods(...acronyms), keys: 4 });
    expect(count("stable")).toBe(140);
    expect(count("stable", "V2")).toBe(180);
    expect(count("lazer")).toBe(180);
  });

  test("mania ends at the accuracy stable shows: 300 equals 320 only without ScoreV2", () => {
    const v1 = { client: "stable", mods: mods() };
    const v2 = { client: "stable", mods: mods("V2") };
    expect(judgeRate(MODE_MANIA, { 300: 140 }, 140, v1)).toBe(100);
    expect(judgeRate(MODE_MANIA, { geki: 70, katu: 70 }, 140, v1)).toBeCloseTo((100 * 500) / 600, 9);
    expect(judgeRate(MODE_MANIA, { 300: 180 }, 180, v2)).toBeCloseTo((100 * 300) / 305, 9);
  });

  test("taiko ScoreV2 also judges drum rolls and swells", () => {
    const objects = { circles: 4370, sliders: 23, spinners: 19, holds: 0, total: 4412 };
    const count = (...acronyms) => expectedJudgements(MODE_TAIKO, { objects, client: "stable", mods: mods(...acronyms) });
    expect(count()).toBe(4370);
    expect(count("V2")).toBe(4412);
  });
});
