import {
  STATE_PLAYING,
  SettingsChannel,
  Subscription,
  VISIBILITY_OPTIONS,
  bool,
  isVisibleIn,
  num,
} from "./js/vosu.js";
import { MODE_MANIA, MODE_STANDARD, MODE_TAIKO } from "./js/judgements.js";
import { HitErrorStream } from "./js/hitErrors.js";

const POINTERS = ["/state/number", "/play/mode/number", "/beatmap/stats/hitWindow", "/play/mods/rate"];
const [STATE, MODE, HIT_WINDOW, RATE] = POINTERS.keys();

// Timing windows per ruleset, tightest first, paired with the judgement tone they award.
const WINDOWS = {
  [MODE_STANDARD]: [
    ["great", "kool"],
    ["ok", "cool"],
    ["meh", "good"],
  ],
  [MODE_TAIKO]: [
    ["great", "kool"],
    ["ok", "cool"],
  ],
  [MODE_MANIA]: [
    ["perfect", "kool"],
    ["great", "cool"],
    ["good", "good"],
    ["ok", "ok"],
    ["meh", "miss"],
  ],
};
const FALLBACK_RANGE_MS = 150;
const AVERAGE_SPAN = 16;
const LINE_POOL = 64;

const root = document.querySelector("[data-root]");
const hitsLayer = root.querySelector("[data-hits]");
const averageMarker = root.querySelector("[data-average]");
const callouts = root.querySelector("[data-callouts]");
const earlyCallout = root.querySelector("[data-early]");
const lateCallout = root.querySelector("[data-late]");

const settings = {
  visibility: "gameplay",
  showEarlyLate: true,
  earlyColor: "#1ec8d2",
  lateColor: "#e5383f",
  earlyLateThreshold: "auto",
  hitLifetime: 3,
};

const lines = Array.from({ length: LINE_POOL }, () => {
  const line = document.createElement("i");
  line.className = "hit";
  hitsLayer.append(line);
  return { node: line, animation: null };
});
let nextLine = 0;

let state = -1;
let mode = -1;
let windows = [];
let rangeMs = FALLBACK_RANGE_MS;
let recent = [];
let calloutAnimation = null;
let lastValues = null;

function resolveWindows(hitWindow) {
  const table = WINDOWS[mode] ?? [];
  windows = [];
  for (const [name, tone] of table) {
    const ms = hitWindow?.[name];
    if (Number.isFinite(ms) && ms > 0) windows.push({ ms, tone });
  }
  rangeMs = windows.length > 0 ? windows[windows.length - 1].ms : FALLBACK_RANGE_MS;
}

function toneFor(error) {
  const magnitude = Math.abs(error);
  for (const window of windows) if (magnitude <= window.ms) return window.tone;
  return "fail";
}

/** Fraction of the half-bar, clamped so far-off hits stay pinned to the ends. */
function position(error) {
  return Math.max(-1, Math.min(1, error / rangeMs));
}

function clearHits() {
  for (const line of lines) {
    line.animation?.cancel();
    line.animation = null;
  }
  recent = [];
  averageMarker.style.transform = "translateX(0)";
  calloutAnimation?.cancel();
}

function plot(error, animateCallout) {
  const line = lines[nextLine];
  nextLine = (nextLine + 1) % LINE_POOL;
  line.node.style.left = `${50 + position(error) * 50}%`;
  line.node.dataset.tone = toneFor(error);
  line.animation?.cancel();
  line.animation = line.node.animate([{ opacity: 1 }, { opacity: 0.75, offset: 0.2 }, { opacity: 0 }], {
    duration: settings.hitLifetime * 1000,
    fill: "forwards",
  });

  recent.push(error);
  if (recent.length > AVERAGE_SPAN) recent.shift();

  if (animateCallout) showCallout(error);
}

function placeAverage() {
  if (recent.length === 0) return;
  let sum = 0;
  for (const error of recent) sum += error;
  averageMarker.style.transform = `translateX(${position(sum / recent.length) * 50}cqw)`;
}

function threshold() {
  const manual = Number.parseFloat(settings.earlyLateThreshold);
  if (Number.isFinite(manual) && manual >= 0) return manual;
  return windows.length > 0 ? windows[0].ms : 0;
}

function showCallout(error) {
  if (!settings.showEarlyLate) return;
  calloutAnimation?.cancel();
  calloutAnimation = null;
  if (Math.abs(error) <= threshold()) return;
  // Without columns to anchor to, each callout pops up under its own side label.
  const target = error < 0 ? earlyCallout : lateCallout;
  calloutAnimation = target.animate(
    [
      { opacity: 0, transform: "translateY(4px) scale(1.12)" },
      { opacity: 1, transform: "translateY(0) scale(1)", offset: 0.12 },
      { opacity: 1, offset: 0.7 },
      { opacity: 0 },
    ],
    { duration: 650, fill: "forwards" },
  );
}

function update(values, changed) {
  lastValues = values;
  const nextState = values[STATE] ?? -1;
  if (nextState !== state) {
    state = nextState;
    root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));
  }
  const nextMode = values[MODE] ?? 0;
  if (nextMode !== mode || changed.has(HIT_WINDOW)) {
    mode = nextMode;
    resolveWindows(values[HIT_WINDOW]);
  }
}

/**
 * Hit errors are gameplay milliseconds, but vosu's windows are already divided by the clock rate
 * (real milliseconds); bring the errors onto the same scale before judging them.
 */
function realMs(error) {
  const rate = lastValues?.[RATE] > 0 ? lastValues[RATE] : 1;
  return error / rate;
}

/** Hits that already happened (after connecting or a retry): redraw what could still be visible. */
function showSnapshot(errors) {
  clearHits();
  for (let i = Math.max(0, errors.length - AVERAGE_SPAN); i < errors.length; i++) {
    if (Number.isFinite(errors[i])) plot(realMs(errors[i]), false);
  }
  placeAverage();
}

function showNew(errors) {
  const live = state === STATE_PLAYING;
  errors.forEach((error, i) => {
    if (Number.isFinite(error)) plot(realMs(error), live && i === errors.length - 1);
  });
  placeAverage();
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  settings.showEarlyLate = bool(incoming.showEarlyLate, settings.showEarlyLate);
  if (typeof incoming.earlyColor === "string") settings.earlyColor = incoming.earlyColor;
  if (typeof incoming.lateColor === "string") settings.lateColor = incoming.lateColor;
  if (typeof incoming.earlyLateThreshold === "string" || typeof incoming.earlyLateThreshold === "number") {
    settings.earlyLateThreshold = String(incoming.earlyLateThreshold).trim() || "auto";
  }
  settings.hitLifetime = num(incoming.hitLifetime, settings.hitLifetime, 0.25, 30);
  root.style.setProperty("--early", settings.earlyColor);
  root.style.setProperty("--late", settings.lateColor);
  callouts.hidden = !settings.showEarlyLate;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));
  if (lastValues) update(lastValues, new Set());
}

new Subscription(POINTERS, update);
new HitErrorStream(showSnapshot, showNew);
new SettingsChannel(applySettings);
