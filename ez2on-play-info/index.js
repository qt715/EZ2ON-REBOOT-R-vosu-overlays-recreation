import {
  STATE_RESULTS,
  SettingsChannel,
  Subscription,
  VISIBILITY_OPTIONS,
  bool,
  isVisibleIn,
  num,
} from "./js/vosu.js";
import {
  MODE_MANIA,
  countOf,
  expectedJudgements,
  formatRate,
  judgeRate,
  judgementsFor,
} from "./js/judgements.js";

const POINTERS = [
  "/state/number",
  // Same snapshot as the metadata; `/files/beatmap/background` follows vosu's separately polled
  // selection and can briefly serve the previous map's image under the new URL.
  "/directPath/beatmapBackground",
  "/beatmap/title",
  "/beatmap/titleUnicode",
  "/beatmap/artist",
  "/beatmap/artistUnicode",
  "/beatmap/version",
  "/beatmap/stats/cs/converted",
  "/beatmap/stats/objects",
  "/beatmap/stats/maxCombo",
  "/play/mode/number",
  "/play/hits",
  "/resultsScreen/mode/number",
  "/resultsScreen/hits",
  "/settings/mode/number",
  "/client",
];
const [
  STATE,
  BACKGROUND,
  TITLE,
  TITLE_UNICODE,
  ARTIST,
  ARTIST_UNICODE,
  VERSION,
  CS,
  OBJECTS,
  MAX_COMBO,
  PLAY_MODE,
  PLAY_HITS,
  RESULT_MODE,
  RESULT_HITS,
  MENU_MODE,
  CLIENT,
] = POINTERS.keys();

const RULESET_NAMES = ["STANDARD", "TAIKO", "CATCH", "MANIA"];
const STATE_PLAYING = 2;

const root = document.querySelector("[data-root]");
const backdrop = root.querySelector("[data-backdrop]");
const titleNode = root.querySelector("[data-title]");
const artistNode = root.querySelector("[data-artist]");
const keysNode = root.querySelector("[data-keys]");
const rulesetNode = root.querySelector("[data-ruleset]");
const difficultyNode = root.querySelector("[data-difficulty]");
const chipList = root.querySelector("[data-chips]");

const settings = {
  visibility: "gameplay + results",
  unicode: false,
  backgroundDim: 72,
};

let mode = -1;
let chipValues = [];
let rateValue = null;
let background = null;
let lastValues = null;

function chip(label, tone) {
  const item = document.createElement("li");
  item.className = "chip";
  item.style.setProperty("--tone", `var(--${tone})`);
  const pill = document.createElement("span");
  pill.className = "chip-label";
  pill.textContent = label;
  const value = document.createElement("span");
  value.className = "chip-value";
  item.append(pill, value);
  chipList.append(item);
  return value;
}

function buildChips(judgements) {
  chipList.replaceChildren();
  chipValues = judgements.map((judgement) => chip(judgement.label, judgement.tone));
  rateValue = chip("RATE", "rate");
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function activeMode(values, state) {
  if (state === STATE_RESULTS) return values[RESULT_MODE] ?? 0;
  if (state === STATE_PLAYING) return values[PLAY_MODE] ?? 0;
  return values[MENU_MODE] ?? values[PLAY_MODE] ?? 0;
}

function update(values) {
  lastValues = values;
  const state = values[STATE] ?? -1;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state) || !values[TITLE]);

  if (values[BACKGROUND] !== background) {
    background = values[BACKGROUND];
    const encoded = background?.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
    backdrop.style.backgroundImage = encoded ? `url("/files/beatmap/${encoded}")` : "none";
  }

  const pick = (unicode, plain) => (settings.unicode && values[unicode]) || values[plain] || "";
  setText(titleNode, pick(TITLE_UNICODE, TITLE));
  setText(artistNode, pick(ARTIST_UNICODE, ARTIST));
  setText(difficultyNode, values[VERSION] ?? "");

  const nextMode = activeMode(values, state);
  const judgements = judgementsFor(nextMode);
  if (nextMode !== mode) {
    mode = nextMode;
    buildChips(judgements);
  }
  setText(rulesetNode, RULESET_NAMES[mode] ?? "");
  const keyCount = Math.round(values[CS] ?? 0);
  setText(keysNode, mode === MODE_MANIA && keyCount > 0 ? `${keyCount}K ` : "");

  const hits = state === STATE_RESULTS ? values[RESULT_HITS] : state === STATE_PLAYING ? values[PLAY_HITS] : null;
  for (let i = 0; i < judgements.length; i++) setText(chipValues[i], String(countOf(hits, judgements[i])));
  const expected = expectedJudgements(mode, {
    objects: values[OBJECTS],
    maxCombo: values[MAX_COMBO],
    client: values[CLIENT],
  });
  setText(rateValue, formatRate(judgeRate(mode, hits, expected)));
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  settings.unicode = bool(incoming.unicode, settings.unicode);
  settings.backgroundDim = num(incoming.backgroundDim, settings.backgroundDim, 0, 100);
  root.style.setProperty("--dim-amount", String(settings.backgroundDim / 100));
  if (lastValues) update(lastValues);
}

new Subscription(POINTERS, update);
new SettingsChannel(applySettings);
