import { STATE_PLAYING, SettingsChannel, Subscription, VISIBILITY_OPTIONS, isVisibleIn, num } from "./js/vosu.js";
import { countOf, judgementsFor } from "./js/judgements.js";

const POINTERS = ["/state/number", "/play/mode/number", "/play/hits"];
const [STATE, MODE, HITS] = POINTERS.keys();

const root = document.querySelector("[data-root]");
const popup = root.querySelector("[data-popup]");

const settings = { visibility: "gameplay", popupHoldMs: 450 };
let mode = -1;
let judgements = [];
let previous = null; // { judged, counts } from the last gameplay sample
let animation = null;
let lastValues = null;

function show(judgement) {
  popup.dataset.tone = judgement.tone;
  // The best judgement copies EZ2ON's "KOOL": a hot first glyph, the rest in white.
  if (judgement === judgements[0]) {
    const lead = document.createElement("span");
    lead.className = "lead";
    lead.textContent = judgement.label[0];
    popup.replaceChildren(lead, judgement.label.slice(1));
  } else {
    popup.textContent = judgement.label;
  }
  animation?.cancel();
  const hold = settings.popupHoldMs;
  const total = 260 + hold + 220;
  animation = popup.animate(
    [
      { opacity: 0, transform: "scale(1.42)", filter: "blur(3px)" },
      { opacity: 1, transform: "scale(0.97)", filter: "blur(0)", offset: 110 / total },
      { opacity: 1, transform: "scale(1)", offset: 260 / total },
      { opacity: 1, transform: "scale(1)", offset: (260 + hold) / total },
      { opacity: 0, transform: "scale(1.02)" },
    ],
    { duration: total, easing: "linear", fill: "forwards" },
  );
}

function update(values) {
  lastValues = values;
  const state = values[STATE] ?? -1;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));

  const nextMode = values[MODE] ?? 0;
  if (nextMode !== mode) {
    mode = nextMode;
    judgements = judgementsFor(mode);
    previous = null;
  }
  if (state !== STATE_PLAYING) {
    previous = null;
    return;
  }

  const hits = values[HITS];
  const counts = judgements.map((judgement) => countOf(hits, judgement));
  const judged = counts.reduce((sum, count) => sum + count, 0);
  if (previous && judged > previous.judged) {
    // Several judgements can land between two samples; show the worst of them.
    let worst = null;
    for (let i = 0; i < judgements.length; i++) if (counts[i] > previous.counts[i]) worst = judgements[i];
    if (worst) show(worst);
  } else if (previous && judged < previous.judged) {
    // A retry or seek lowered the totals: restart without flashing a judgement.
    animation?.cancel();
  }
  previous = { judged, counts };
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  settings.popupHoldMs = num(incoming.popupHoldMs, settings.popupHoldMs, 0, 5000);
  if (lastValues) update(lastValues);
}

new Subscription(POINTERS, update);
new SettingsChannel(applySettings);
