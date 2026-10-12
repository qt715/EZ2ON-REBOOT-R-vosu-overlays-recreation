import { Subscription } from "./vosu.js";

const ARRAY = "/play/hitErrorArray";
// vosu accepts at most 256 pointers per subscription.
const WINDOW = 256;
// Open the next window while this many indices of the current one are still unused.
const ROLL_MARGIN = 64;

/**
 * Hit errors as they are appended, without re-receiving the whole array.
 *
 * Subscribing to `/play/hitErrorArray` resends every error on every hit, so a long map costs
 * megabytes per second (tens of kilobytes per hit), all parsed on the main thread that vosulay's
 * overlays share. Instead this subscribes to a sliding window of individual indices; indices that
 * do not exist yet are simply absent until they are appended. The whole array is fetched once,
 * only to find where it ends after (re)connecting or when a retry resets it.
 */
export class HitErrorStream {
  /**
   * @param {(errors: number[]) => void} onSnapshot errors that already happened (replaces all)
   * @param {(errors: number[]) => void} onAppend new errors, oldest first
   */
  constructor(onSnapshot, onAppend) {
    this.onSnapshot = onSnapshot;
    this.onAppend = onAppend;
    this.length = 0; // errors delivered so far
    this.window = null;
    this.windowStart = 0;
    this.nextWindow = null;
    this.sync = null;
    this.pending = new Map();
    // Recently delivered values by index; overlapping windows both report each new index.
    this.delivered = new Map();
    this.resync();
  }

  resync() {
    this.closeWindows();
    this.sync?.close();
    this.sync = new Subscription([ARRAY], (values) => {
      const errors = Array.isArray(values[0]) ? values[0] : [];
      this.sync.close();
      this.sync = null;
      this.length = errors.length;
      this.pending.clear();
      this.delivered.clear();
      for (let i = Math.max(0, errors.length - 2 * WINDOW); i < errors.length; i++) this.delivered.set(i, errors[i]);
      this.onSnapshot(errors);
      this.window = this.openWindow();
    });
  }

  closeWindows() {
    this.window?.subscription.close();
    this.nextWindow?.subscription.close();
    this.window = null;
    this.nextWindow = null;
  }

  /**
   * Watches the last delivered index (the anchor) plus the next ones. Indices that do not exist
   * yet produce no frames, so without the anchor a retry back to an empty or shorter array would
   * go unnoticed until the new attempt outgrew the old one; the anchor's removal or change
   * reports the reset.
   */
  openWindow() {
    const start = Math.max(0, this.length - 1);
    const pointers = Array.from({ length: WINDOW }, (_, i) => `${ARRAY}/${start + i}`);
    const window = { start, subscription: null };
    window.subscription = new Subscription(pointers, (values, changed) => this.receive(window, values, changed));
    return window;
  }

  receive(window, values, changed) {
    for (const i of changed) {
      const index = window.start + i;
      const value = values[i];
      if (index < this.length) {
        if (value === this.delivered.get(index)) continue;
        // An error already delivered changed or vanished: the attempt restarted. Start over
        // from a fresh snapshot.
        this.resync();
        return;
      }
      if (typeof value === "number") this.pending.set(index, value);
    }

    const appended = [];
    while (this.pending.has(this.length)) {
      const value = this.pending.get(this.length);
      appended.push(value);
      this.pending.delete(this.length);
      this.delivered.set(this.length, value);
      this.delivered.delete(this.length - 2 * WINDOW);
      this.length++;
    }
    if (appended.length > 0) this.onAppend(appended);

    // Roll forward before the current window runs out; overlapping windows deduplicate through
    // `pending` and `delivered`, so no error is lost or delivered twice.
    if (window === this.window && this.length >= window.start + WINDOW - ROLL_MARGIN && !this.nextWindow) {
      this.nextWindow = this.openWindow();
    } else if (window === this.nextWindow) {
      this.window.subscription.close();
      this.window = this.nextWindow;
      this.nextWindow = null;
    }
  }
}
