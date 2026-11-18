import { BeatmapFile, STATE_RESULTS, SettingsChannel, Subscription, VISIBILITY_OPTIONS, isVisibleIn } from "./js/vosu.js";
import { expectedJudgements, formatRate, judgeRate, usedManiaColumns } from "./js/judgements.js";

const POINTERS = [
  "/state/number",
  "/play/mode/number",
  "/play/hits",
  "/play/mods",
  "/resultsScreen/mode/number",
  "/resultsScreen/hits",
  "/resultsScreen/mods",
  "/beatmap/stats/objects",
  "/beatmap/stats/maxCombo",
  "/beatmap/stats/cs/converted",
  "/directPath/beatmapFile",
  "/client",
  "/play/accuracy",
  "/resultsScreen/accuracy",
];
const [
  STATE,
  PLAY_MODE,
  PLAY_HITS,
  PLAY_MODS,
  RESULT_MODE,
  RESULT_HITS,
  RESULT_MODS,
  OBJECTS,
  MAX_COMBO,
  CS,
  FILE,
  CLIENT,
  PLAY_ACCURACY,
  RESULT_ACCURACY,
] = POINTERS.keys();

const VALUE_JUDGE_RATE = "judge rate";
const VALUE_ACCURACY = "vosu accuracy";

const root = document.querySelector("[data-root]");
const rateValue = root.querySelector("[data-rate]");

const settings = { visibility: "gameplay", value: VALUE_JUDGE_RATE };
let lastValues = null;
let usedColumns = null;

const beatmap = new BeatmapFile((text) => {
  usedColumns = usedManiaColumns(text);
  if (lastValues) update(lastValues);
});

function update(values) {
  lastValues = values;
  if (beatmap.track(values[FILE])) usedColumns = null;
  const state = values[STATE] ?? -1;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));

  const inResults = state === STATE_RESULTS;
  let rate;
  if (settings.value === VALUE_ACCURACY) {
    rate = (inResults ? values[RESULT_ACCURACY] : values[PLAY_ACCURACY]) ?? 0;
  } else {
    const mode = (inResults ? values[RESULT_MODE] : values[PLAY_MODE]) ?? 0;
    const hits = inResults ? values[RESULT_HITS] : values[PLAY_HITS];
    const play = {
      objects: values[OBJECTS],
      maxCombo: values[MAX_COMBO],
      client: values[CLIENT],
      mods: inResults ? values[RESULT_MODS] : values[PLAY_MODS],
      keys: values[CS],
      usedColumns,
    };
    rate = judgeRate(mode, hits, expectedJudgements(mode, play), play);
  }
  const text = formatRate(rate);
  if (rateValue.textContent !== text) rateValue.textContent = text;
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  if (incoming.value === VALUE_JUDGE_RATE || incoming.value === VALUE_ACCURACY) settings.value = incoming.value;
  if (lastValues) update(lastValues);
}

new Subscription(POINTERS, update);
new SettingsChannel(applySettings);
