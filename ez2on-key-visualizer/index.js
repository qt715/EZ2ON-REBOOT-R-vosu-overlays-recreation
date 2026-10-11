import {
  STATE_PLAYING,
  SettingsChannel,
  Subscription,
  VISIBILITY_OPTIONS,
  bool,
  isVisibleIn,
  num,
} from "./js/vosu.js";
import { PlaybackClock } from "./js/clock.js";
import { PressHistory } from "./js/presses.js";
import { buildColumns, lowerBound } from "./js/beatmap.js";
import {
  DEFAULT_MODE_HIT_COLORS,
  MAX_SETTING_KEYS,
  defaultHitColors,
  defaultNoteColors,
  parseColorList,
} from "./js/colors.js";
import { InstanceBatch, STYLE_HOLD_BODY, STYLE_NOTE, STYLE_PRESS, createBackend } from "./js/renderer.js";

const POINTERS = [
  "/state/number",
  "/game/paused",
  "/beatmap/time/live",
  "/keys/all",
  "/play/mode/number",
  "/play/mods",
  // The path arrives in the same snapshot as everything else. `/files/beatmap/file` would serve
  // vosu's separately polled selection, which can still be the previous map right after a change.
  "/directPath/beatmapFile",
  "/settings/mania/scrollSpeed",
  "/settings/mania/scrollDirection/number",
  "/settings/audio/offset/universal",
  "/settings/keybinds",
  "/client",
];
const [
  STATE,
  PAUSED,
  LIVE,
  KEYS,
  MODE,
  MODS,
  BEATMAP_FILE,
  GAME_SPEED,
  GAME_DIRECTION,
  UNIVERSAL_OFFSET,
  KEYBINDS,
  CLIENT,
] = POINTERS.keys();

const MODE_STANDARD = 0;
const MODE_TAIKO = 1;
const MODE_CATCH = 2;
const MODE_MANIA = 3;

// osu! scroll speed (1-40, stable and lazer): a note travels the 402 units between the top of the
// 480-unit stage and the default hit position in 11485 / speed ms. The overlay height is the stage.
const SCROLL_MAX_TIME_RANGE_MS = 11485;
const SCROLL_TRAVEL_UNITS = 402;
const STAGE_UNITS = 480;
const REWIND_RESET_MS = 300;
const FADE_START = 0.45;
const CANVAS_ALIGN = 128;

const root = document.querySelector("[data-root]");
const keysRow = root.querySelector("[data-keys]");
let canvas = root.querySelector("[data-canvas]");

const settings = {
  visibility: "gameplay",
  scrollDirection: "auto",
  scrollSpeed: "auto",
  inputOffset: "auto",
  fade: true,
  showKeys: true,
  showNotes: true,
  maxLaneWidth: 64,
  // WebGPU presentation fails inside vosulay's CEF on NVIDIA/Linux (Dawn vkAllocateMemory
  // INVALID_EXTERNAL_HANDLE on every composite, GPU-process crash on teardown) and a single
  // instanced draw gains nothing from it, so WebGPU is opt-in.
  renderer: "webgl2",
  colorText: {},
};

const clock = new PlaybackClock();
const history = new PressHistory();
const batch = new InstanceBatch();
let backend = null;

let values = [];
let state = -1;
let mode = -1;
let rate = 1;
let lastLive = Number.NaN;
let laneCount = 0;
let keyNodes = [];
let keyStates = [];

let beatmapText = null;
let beatmapPath = null;
let beatmapRequest = 0;
let built = null; // { key, result } for the last map/mods combination
let columns = null; // note columns after mods, or null when notes are not drawn

let noteColors = [];
let hitColors = [];
let raf = 0;

// Geometry in device pixels, refreshed on resize and settings changes.
const view = { dpr: 1, cssWidth: 0, cssHeight: 0, width: 0, height: 0, laneLeft: 0, laneWidth: 0, gap: 0, keyBand: 0 };
const frameInfo = { width: 0, height: 0, nowY: 0, travel: 0, fadeStart: FADE_START, fade: true };

function direction() {
  if (settings.scrollDirection === "up" || settings.scrollDirection === "down") return settings.scrollDirection;
  return values[GAME_DIRECTION] === 0 ? "up" : "down";
}

function scrollSpeed() {
  const manual = Number.parseFloat(settings.scrollSpeed);
  if (Number.isFinite(manual)) return Math.min(40, Math.max(1, manual));
  const game = values[GAME_SPEED];
  return Number.isFinite(game) && game > 0 ? game : 20;
}

/**
 * Milliseconds added to vosu's edge timestamps (and the live clock) to line them up with note
 * times. lazer applies the universal audio offset in real time to the judgement clock, which the
 * sampled timestamps do not include, so it scales with the playback rate.
 */
function inputOffset() {
  const manual = Number.parseFloat(settings.inputOffset);
  if (Number.isFinite(manual)) return manual;
  if (values[CLIENT] !== "lazer") return 0;
  const universal = values[UNIVERSAL_OFFSET];
  return Number.isFinite(universal) ? universal * rate : 0;
}

function isPlaying() {
  return state === STATE_PLAYING && values[PAUSED] !== true;
}

function laneColors() {
  const n = laneCount;
  if (n === 0) return;
  if (mode === MODE_MANIA) {
    // Each stage of a two-stage layout (native maps above 10K, Dual Stages) uses its own key
    // count's scheme, like the game's stage skins.
    const stages = built?.result?.keyCount === n ? built.result.stages : n > MAX_SETTING_KEYS ? 2 : 1;
    noteColors = maniaColors("Note", n, stages, defaultNoteColors);
    hitColors = maniaColors("Hit", n, stages, defaultHitColors);
    return;
  }
  const key = mode === MODE_TAIKO ? "taiko" : mode === MODE_CATCH ? "catch" : "standard";
  hitColors = parseColorList(settings.colorText[`${key}HitColors`], DEFAULT_MODE_HIT_COLORS[key], n);
  noteColors = hitColors;
}

function maniaColors(kind, n, stages, defaults) {
  if (stages === 1 && n <= MAX_SETTING_KEYS) {
    return parseColorList(settings.colorText[`mania${kind}Colors${n}K`], defaults(n), n);
  }
  const left = Math.ceil(n / 2);
  return [...maniaColors(kind, left, 1, defaults), ...maniaColors(kind, n - left, 1, defaults)];
}

// lazer reports its ruleset actions as B1..Bn; stable reports K1 K2 M1 M2 (Kn in mania).
const LAZER_ACTIONS = {
  [MODE_STANDARD]: ["L", "R", "SMOKE"],
  [MODE_TAIKO]: ["KAT", "DON", "DON", "KAT"],
  [MODE_CATCH]: ["◀", "▶", "DASH"],
};

function keyLabels(keys) {
  const binds = values[KEYBINDS] ?? {};
  let configured = [];
  if (mode === MODE_MANIA) {
    const mania = binds.mania?.[`${keys.length}K`] ?? binds.mania?.[String(keys.length)];
    configured = Array.isArray(mania) ? mania : [];
  } else if (mode === MODE_STANDARD) {
    configured = [binds.osu?.k1, binds.osu?.k2];
  } else if (mode === MODE_TAIKO) {
    configured = [binds.taiko?.outerLeft, binds.taiko?.innerLeft, binds.taiko?.innerRight, binds.taiko?.outerRight];
  } else if (mode === MODE_CATCH) {
    configured = [binds.fruits?.k1, binds.fruits?.k2, binds.fruits?.Dash];
  }
  const lazer = keys.every((key) => /^B\d+$/.test(key.name));
  const semantic = mode === MODE_MANIA ? keys.map((_, i) => String(i + 1)) : lazer ? (LAZER_ACTIONS[mode] ?? []) : [];
  return keys.map((key, i) => configured[i] || semantic[i] || key.name);
}

function buildKeys(keys) {
  keysRow.replaceChildren();
  const labels = keyLabels(keys);
  keyNodes = keys.map((key, i) => {
    const node = document.createElement("div");
    node.className = "key";
    const label = document.createElement("span");
    label.className = "key-label";
    label.textContent = labels[i];
    const count = document.createElement("span");
    count.className = "key-count";
    count.textContent = key.count;
    node.append(label, count);
    keysRow.append(node);
    return node;
  });
  keyStates = keys.map(() => ({ down: false, count: -1 }));
  paintKeyColors();
}

function paintKeyColors() {
  keyNodes.forEach((node, i) => {
    const [r, g, b] = hitColors[i] ?? [1, 1, 1];
    node.style.setProperty("--hit", `rgb(${r * 255} ${g * 255} ${b * 255})`);
  });
}

function updateKeys(keys) {
  for (let i = 0; i < keyNodes.length; i++) {
    const key = keys[i];
    const known = keyStates[i];
    if (key.isPressed !== known.down) {
      known.down = key.isPressed;
      keyNodes[i].classList.toggle("is-down", key.isPressed);
    }
    if (key.count !== known.count) {
      known.count = key.count;
      keyNodes[i].lastChild.textContent = key.count;
    }
  }
}

function measure() {
  const rect = root.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  view.cssWidth = rect.width;
  view.cssHeight = rect.height;
  view.width = Math.max(1, Math.round(rect.width * view.dpr));
  view.height = Math.max(1, Math.round(rect.height * view.dpr));
  // Dawn on NVIDIA/Linux (Chromium 150, CEF included) fails to present WebGPU canvases whose
  // backing size is not 128-pixel aligned; pad the backing store and let the overflow clip.
  const backingWidth = Math.ceil(view.width / CANVAS_ALIGN) * CANVAS_ALIGN;
  const backingHeight = Math.ceil(view.height / CANVAS_ALIGN) * CANVAS_ALIGN;
  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
    canvas.style.width = `${backingWidth / view.dpr}px`;
    canvas.style.height = `${backingHeight / view.dpr}px`;
  }
  const lanes = Math.max(1, laneCount);
  const laneCss = Math.min(settings.maxLaneWidth, rect.width / lanes);
  const leftCss = (rect.width - laneCss * lanes) / 2;
  const keyCss = settings.showKeys ? Math.round(Math.min(40, Math.max(24, laneCss * 0.62))) : 0;
  const gapCss = laneCss >= 30 ? 3 : 2;
  root.style.setProperty("--lanes", String(lanes));
  root.style.setProperty("--lane-w", `${laneCss}px`);
  root.style.setProperty("--keys-left", `${leftCss}px`);
  root.style.setProperty("--keys-width", `${laneCss * lanes}px`);
  root.style.setProperty("--key-h", `${keyCss}px`);
  root.style.setProperty("--gap", `${gapCss}px`);
  view.laneLeft = leftCss * view.dpr;
  view.laneWidth = laneCss * view.dpr;
  view.gap = gapCss * view.dpr;
  view.keyBand = keyCss > 0 ? (keyCss + 2) * view.dpr : 0;
}

function loadBeatmap(path) {
  beatmapPath = path;
  beatmapText = null;
  built = null;
  columns = null;
  if (!path) return;
  const request = ++beatmapRequest;
  const encoded = path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
  fetch(`/files/beatmap/${encoded}`)
    .then((response) => (response.ok ? response.text() : ""))
    .then((text) => {
      if (request !== beatmapRequest) return;
      beatmapText = text || null;
      resolveColumns();
      requestRender();
    })
    .catch(() => {});
}

function resolveColumns() {
  columns = null;
  if (mode !== MODE_MANIA || !beatmapText) return;
  const mods = values[MODS];
  const key = JSON.stringify([mods?.number, mods?.array]);
  if (built?.key !== key) {
    let result = null;
    try {
      result = buildColumns(beatmapText, mods);
    } catch (error) {
      console.warn("Could not build mania notes", error);
    }
    built = { key, result };
    laneColors();
    paintKeyColors();
  }
  // Safety net for layouts the conversion cannot predict (e.g. stable Co-op on a native map):
  // notes are only drawn when they fill exactly the lanes the game reports.
  if (built.result?.keyCount === laneCount) columns = built.result.columns;
}

function onFrame(next, changed) {
  values = next;

  if (changed.has(STATE)) {
    state = values[STATE] ?? -1;
    root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));
    if (state !== STATE_PLAYING) history.clear();
  }
  if (changed.has(MODS)) {
    const nextRate = Number(values[MODS]?.rate);
    rate = Number.isFinite(nextRate) && nextRate > 0 ? nextRate : 1;
    resolveColumns();
  }
  if (changed.has(BEATMAP_FILE) && values[BEATMAP_FILE] !== beatmapPath) loadBeatmap(values[BEATMAP_FILE]);

  const keys = Array.isArray(values[KEYS]) ? values[KEYS] : [];
  const nextMode = values[MODE] ?? 0;
  if (keys.length !== laneCount || nextMode !== mode) {
    laneCount = keys.length;
    mode = nextMode;
    history.clear();
    laneColors();
    buildKeys(keys);
    measure();
    resolveColumns();
  }

  if (changed.has(LIVE) || changed.has(PAUSED) || changed.has(STATE)) {
    const live = values[LIVE];
    if (Number.isFinite(live) && Number.isFinite(lastLive) && live < lastLive - REWIND_RESET_MS) history.clear();
    if (Number.isFinite(live)) lastLive = live;
    clock.update(live, rate, isPlaying());
  }

  if (changed.has(KEYS) && keys.length > 0) {
    if (state === STATE_PLAYING) history.ingest(keys, inputOffset(), clock.now() + inputOffset());
    updateKeys(keys);
  }
  requestRender();
}

function requestRender() {
  if (raf === 0 && backend) raf = requestAnimationFrame(renderFrame);
}

function renderFrame() {
  raf = 0;
  draw();
  if (clock.isAdvancing() && !root.classList.contains("is-hidden")) requestRender();
}

function pushSpan(t0, t1, now, lane, color, style, geometry) {
  const { ppm, nowY, sign, noteHeight, limit } = geometry;
  const age0 = (now - t0) * ppm;
  const age1 = (now - Math.min(t1, now)) * ppm;
  let near;
  let far;
  if (sign > 0) {
    near = nowY + age1 - noteHeight;
    far = nowY + age0;
    near = Math.max(near, nowY);
    if (near >= limit || far <= near) return;
    far = Math.min(far, limit);
  } else {
    far = nowY - age0;
    near = nowY - age1 + noteHeight;
    near = Math.min(near, nowY);
    if (near <= limit || far >= near) return;
    far = Math.max(far, limit);
  }
  const x = view.laneLeft + lane * view.laneWidth + view.gap / 2;
  const top = Math.min(near, far);
  batch.push(x, top, view.laneWidth - view.gap, Math.abs(far - near), color, style, geometry.outline);
}

const geometry = { ppm: 0, nowY: 0, sign: 1, noteHeight: 0, limit: 0, outline: 2 };

function draw() {
  batch.reset();
  const down = direction() === "down";
  root.dataset.direction = down ? "down" : "up";
  const offset = inputOffset();
  const now = clock.now() + offset;
  const ppm =
    (((view.cssHeight / STAGE_UNITS) * SCROLL_TRAVEL_UNITS * scrollSpeed()) / SCROLL_MAX_TIME_RANGE_MS / rate) *
    view.dpr;
  geometry.ppm = ppm;
  geometry.sign = down ? 1 : -1;
  geometry.nowY = down ? view.keyBand : view.height - view.keyBand;
  geometry.limit = down ? view.height : 0;
  geometry.noteHeight = Math.round(Math.min(26 * view.dpr, Math.max(7 * view.dpr, view.laneWidth * 0.3)));
  geometry.outline = Math.max(1, Math.round(2 * view.dpr));
  const travel = view.height - view.keyBand;
  const visibleMs = (travel + geometry.noteHeight) / ppm;
  const oldest = now - visibleMs;

  if (settings.showNotes && columns && state === STATE_PLAYING) {
    for (let lane = 0; lane < columns.length; lane++) {
      const { starts, ends, rawEnds } = columns[lane];
      const color = noteColors[lane];
      for (let i = lowerBound(ends, oldest); i < starts.length && starts[i] <= now; i++) {
        const start = starts[i];
        const end = rawEnds[i];
        if (end > start) {
          pushSpan(start, end, now, lane, color, STYLE_HOLD_BODY, geometry);
          if (end <= now) pushSpan(end, end, now, lane, color, STYLE_NOTE, geometry);
        }
        pushSpan(start, start, now, lane, color, STYLE_NOTE, geometry);
      }
    }
  }

  for (let lane = 0; lane < history.lanes.length; lane++) {
    const presses = history.lanes[lane];
    presses.prune(oldest);
    const color = hitColors[lane];
    for (let i = presses.head; i < presses.starts.length; i++) {
      const end = presses.ends[i];
      pushSpan(presses.starts[i], Number.isNaN(end) ? now : end, now, lane, color, STYLE_PRESS, geometry);
    }
  }

  frameInfo.width = canvas.width;
  frameInfo.height = canvas.height;
  frameInfo.nowY = geometry.nowY;
  frameInfo.travel = travel;
  frameInfo.fade = settings.fade;
  backend.draw(batch, frameInfo);
}

function applySettings(incoming) {
  if (VISIBILITY_OPTIONS.includes(incoming.visibility)) settings.visibility = incoming.visibility;
  if (["auto", "up", "down"].includes(incoming.scrollDirection)) settings.scrollDirection = incoming.scrollDirection;
  if (incoming.scrollSpeed != null) settings.scrollSpeed = String(incoming.scrollSpeed).trim() || "auto";
  if (incoming.inputOffset != null) settings.inputOffset = String(incoming.inputOffset).trim() || "auto";
  settings.fade = bool(incoming.fade, settings.fade);
  settings.showKeys = bool(incoming.showKeys, settings.showKeys);
  settings.showNotes = bool(incoming.showNotes, settings.showNotes);
  settings.maxLaneWidth = num(incoming.maxLaneWidth, settings.maxLaneWidth, 8, 400);
  if (["webgl2", "webgpu"].includes(incoming.renderer)) settings.renderer = incoming.renderer;
  for (const [key, value] of Object.entries(incoming)) {
    if (/HitColors|NoteColors/.test(key) && typeof value === "string") settings.colorText[key] = value;
  }
  keysRow.hidden = !settings.showKeys;
  root.classList.toggle("is-hidden", !isVisibleIn(settings.visibility, state));
  laneColors();
  paintKeyColors();
  measure();
  requestRender();
  ensureBackend();
}

let backendPreference = null;
// Set once WebGPU reports an error at runtime; the session then stays on WebGL2.
let webGpuFailed = false;

function wantedRenderer() {
  return webGpuFailed ? "webgl2" : settings.renderer;
}

async function ensureBackend() {
  const wanted = wantedRenderer();
  if (backendPreference === wanted) return;
  backendPreference = wanted;
  if (backend) {
    // A canvas keeps its first context type forever; switching backends needs a fresh canvas.
    backend.destroy();
    backend = null;
    const fresh = canvas.cloneNode(false);
    canvas.replaceWith(fresh);
    canvas = fresh;
  }
  try {
    const created = await createBackend(canvas, wanted);
    if (backendPreference !== wantedRenderer()) {
      created.backend.destroy();
      return;
    }
    canvas = created.canvas;
    backend = created.backend;
    root.dataset.renderer = backend.name;
    const device = created.backend.device;
    if (device) {
      // Some driver/Chromium combinations fail canvas presentation for particular canvas sizes
      // (Dawn "ImportMemory" on NVIDIA Linux) without throwing; any runtime error means WebGL2.
      device.addEventListener("uncapturederror", (event) => {
        if (backend !== created.backend || webGpuFailed) return;
        console.warn("WebGPU error, switching to WebGL2:", event.error?.message);
        webGpuFailed = true;
        ensureBackend();
      });
      device.lost.then((info) => {
        if (info.reason === "destroyed" || backend !== created.backend) return;
        backend = null;
        backendPreference = null;
        ensureBackend();
      });
    }
    measure();
    requestRender();
  } catch (error) {
    console.error(error);
  }
}

new ResizeObserver(() => {
  measure();
  requestRender();
}).observe(root);

measure();
ensureBackend();
new Subscription(POINTERS, onFrame);
new SettingsChannel(applySettings);
