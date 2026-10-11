import { STATE_RESULTS, SettingsChannel, Subscription, VISIBILITY_OPTIONS, isVisibleIn } from "./js/vosu.js";
import { countOf, judgementsFor } from "./js/judgements.js";

const POINTERS = ["/state/number", "/play/mode/number", "/play/hits", "/resultsScreen/mode/number", "/resultsScreen/hits"];
const [STATE, PLAY_MODE, PLAY_HITS, RESULT_MODE, RESULT_HITS] = POINTERS.keys();

const root = document.querySelector("[data-root]");

const settings = { visibility: "gameplay" };
let mode = -1;
let judgements = [];
let countNodes = [];
let shownCounts = [];
let lastValues = null;

function buildCounts() {
  root.replaceChildren();
  countNodes = judgements.map((judgement) => {
    const item = document.createElement("li");
    item.className = "count";
    item.style.setProperty("--tone", `var(--${judgement.tone})`);
    const value = document.createElement("span");
    value.className = "count-value";
    value.textContent = "0";
    const label = document.createElement("span");
    label.className = "count-label";
    label.textContent = judgement.label;
    item.append(value, label);
    root.append(item);
    return item;
  });
  shownCounts = judgements.map(() => -1);
}

function update(values) {
  lastValues = values;
  const state = values[STATE] ?? -1;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));

  const inResults = state === STATE_RESULTS;
  const nextMode = (inResults ? values[RESULT_MODE] : values[PLAY_MODE]) ?? 0;
  const hits = inResults ? values[RESULT_HITS] : values[PLAY_HITS];
  if (nextMode !== mode) {
    mode = nextMode;
    judgements = judgementsFor(mode);
    buildCounts();
  }
  for (let i = 0; i < judgements.length; i++) {
    const count = countOf(hits, judgements[i]);
    if (count === shownCounts[i]) continue;
    shownCounts[i] = count;
    countNodes[i].firstChild.textContent = count;
    countNodes[i].classList.toggle("is-zero", count === 0);
  }
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  if (lastValues) update(lastValues);
}

new Subscription(POINTERS, update);
new SettingsChannel(applySettings);
