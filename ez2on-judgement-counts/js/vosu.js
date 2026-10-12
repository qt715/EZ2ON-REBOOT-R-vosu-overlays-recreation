// vosu API client shared by the EZ2ON overlays (each overlay folder carries its own copy so it
// stays self-contained when installed on its own).

function socketUrl(path) {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${location.host}${path}`;
}

function reconnectDelay(attempt) {
  return Math.min(5000, 250 * 2 ** attempt);
}

export function counterPath() {
  if (typeof window.COUNTER_PATH === "string" && window.COUNTER_PATH.length > 0) {
    return window.COUNTER_PATH;
  }
  return decodeURIComponent(location.pathname.replace(/\/(?:index\.html)?$/, ""));
}

/**
 * Selected-field subscription (`/websocket/v2/subscribe`). The server sends compact frames that
 * only carry changed pointers, so each callback receives the full reconstructed value array plus
 * the set of indices that changed in that frame.
 */
export class Subscription {
  /**
   * @param {string[]} pointers RFC 6901 pointers into the /json/v2 document
   * @param {(values: any[], changed: Set<number>, initial: boolean) => void} onFrame
   */
  constructor(pointers, onFrame) {
    this.pointers = pointers;
    this.onFrame = onFrame;
    this.values = new Array(pointers.length).fill(undefined);
    this.changed = new Set();
    this.revision = -1;
    this.socket = null;
    this.timer = 0;
    this.attempt = 0;
    this.connect();
  }

  connect() {
    const socket = new WebSocket(socketUrl("/websocket/v2/subscribe"));
    this.socket = socket;
    socket.onopen = () => {
      this.attempt = 0;
      this.revision = -1;
      socket.send(JSON.stringify(this.pointers));
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === "string") this.apply(event.data);
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.timer = setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    };
  }

  /** Stops the subscription for good: no further frames, no reconnect. */
  close() {
    clearTimeout(this.timer);
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  apply(payload) {
    let frame;
    try {
      frame = JSON.parse(payload);
    } catch {
      return;
    }
    if (!Array.isArray(frame) || (frame[0] !== 0 && frame[0] !== 1)) {
      if (Array.isArray(frame) && frame[0] === 2) console.warn("vosu subscription error", frame[1], frame[2]);
      return;
    }
    const revision = frame[1];
    if (!(revision > this.revision)) return;
    this.revision = revision;

    const changed = this.changed;
    changed.clear();
    if (frame[0] === 0) {
      this.values.fill(undefined);
      for (let i = 0; i < this.values.length; i++) changed.add(i);
    }
    for (const [index, value] of frame[2]) {
      if (index >= 0 && index < this.values.length) {
        this.values[index] = value;
        changed.add(index);
      }
    }
    if (frame[0] === 1 && Array.isArray(frame[3])) {
      for (const index of frame[3]) {
        this.values[index] = undefined;
        changed.add(index);
      }
    }
    // `initial` marks a full snapshot (first frame after connecting), not a live change.
    this.onFrame(this.values, changed, frame[0] === 0);
  }
}

/**
 * Counter settings over `/websocket/commands`; delivers the flat `{uniqueID: value}` object on
 * load and whenever the user saves settings.
 */
export class SettingsChannel {
  constructor(onSettings) {
    this.onSettings = onSettings;
    this.path = counterPath();
    this.attempt = 0;
    this.connect();
  }

  connect() {
    const encoded = encodeURIComponent(this.path);
    const socket = new WebSocket(socketUrl(`/websocket/commands?l=${encoded}`));
    socket.onopen = () => {
      this.attempt = 0;
      socket.send(`getSettings:${encoded}`);
    };
    socket.onmessage = (event) => {
      let envelope;
      try {
        envelope = JSON.parse(event.data);
      } catch {
        return;
      }
      if (
        envelope?.error == null &&
        (envelope.command === "getSettings" || envelope.command === "updateSettings") &&
        envelope.message &&
        typeof envelope.message === "object"
      ) {
        this.onSettings(envelope.message);
      }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      setTimeout(() => this.connect(), reconnectDelay(this.attempt++));
    };
  }
}

export const STATE_PLAYING = 2;
export const STATE_RESULTS = 7;

export function bool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

export function num(value, fallback, min = -Infinity, max = Infinity) {
  const n = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export const VISIBILITY_OPTIONS = Object.freeze(["gameplay", "gameplay + results", "always"]);

export function isVisibleIn(visibility, state) {
  if (visibility === "always") return true;
  if (visibility === "gameplay + results") return state === STATE_PLAYING || state === STATE_RESULTS;
  return state === STATE_PLAYING;
}

export function str(value, fallback) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}
