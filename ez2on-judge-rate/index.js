import { STATE_RESULTS, SettingsChannel, Subscription, VISIBILITY_OPTIONS, isVisibleIn } from "./js/vosu.js";
import { expectedJudgements, formatRate, judgeRate } from "./js/judgements.js";

const POINTERS = [
  "/state/number",
  "/play/mode/number",
  "/play/hits",
  "/resultsScreen/mode/number",
  "/resultsScreen/hits",
  "/beatmap/stats/objects",
  "/beatmap/stats/maxCombo",
  "/client",
];
const [STATE, PLAY_MODE, PLAY_HITS, RESULT_MODE, RESULT_HITS, OBJECTS, MAX_COMBO, CLIENT] = POINTERS.keys();

const root = document.querySelector("[data-root]");
const rateValue = root.querySelector("[data-rate]");

const settings = { visibility: "gameplay" };
let lastValues = null;

function update(values) {
  lastValues = values;
  const state = values[STATE] ?? -1;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));

  const inResults = state === STATE_RESULTS;
  const mode = (inResults ? values[RESULT_MODE] : values[PLAY_MODE]) ?? 0;
  const hits = inResults ? values[RESULT_HITS] : values[PLAY_HITS];
  const expected = expectedJudgements(mode, {
    objects: values[OBJECTS],
    maxCombo: values[MAX_COMBO],
    client: values[CLIENT],
  });
  const text = formatRate(judgeRate(mode, hits, expected));
  if (rateValue.textContent !== text) rateValue.textContent = text;
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  if (lastValues) update(lastValues);
}

new Subscription(POINTERS, update);
new SettingsChannel(applySettings);
