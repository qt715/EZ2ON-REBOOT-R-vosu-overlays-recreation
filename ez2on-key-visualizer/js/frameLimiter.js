// Caps how often animation frames draw. Draws stay on a fixed grid so the long-run rate equals
// the limit exactly; for limits that do not divide the refresh rate, that means alternating
// frame counts (e.g. 2 and 3 frames on 144 Hz for 60 fps) rather than a lower even rate.

// Gaps longer than this are idle periods, not the host's frame interval.
const IDLE_GAP_MS = 100;

export class FrameLimiter {
  constructor() {
    /** Draws per second; 0 draws on every frame. */
    this.fps = 0;
    this._lastDrawAt = Number.NEGATIVE_INFINITY;
    this._lastFrameAt = Number.NEGATIVE_INFINITY;
    this._hostInterval = Number.POSITIVE_INFINITY;
  }

  /** Whether the animation frame at `timestamp` should draw. Call once per frame. */
  shouldDraw(timestamp) {
    const delta = timestamp - this._lastFrameAt;
    this._lastFrameAt = timestamp;
    if (delta > 0 && delta < IDLE_GAP_MS) {
      // Shortest recent frame interval; rises slowly so a lower refresh rate is picked up, while
      // occasional late frames do not inflate it.
      this._hostInterval =
        delta < this._hostInterval || !Number.isFinite(this._hostInterval)
          ? delta
          : this._hostInterval + (delta - this._hostInterval) * 0.02;
    }
    if (!(this.fps > 0)) return true;
    const interval = 1000 / this.fps;
    const hostInterval = Number.isFinite(this._hostInterval) ? this._hostInterval : interval;
    // Half a host frame of slack: without it, a limit equal to the refresh rate would drop
    // frames to timestamp jitter.
    const slack = Math.min(hostInterval, interval) / 2;
    const since = timestamp - this._lastDrawAt;
    if (since < interval - slack) return false;
    const lateness = since - interval;
    // Up to one host frame late is the grid rounding onto frame boundaries; keep the grid.
    // Later than that (missed frames, idle) restarts it here, so the backlog is never caught up
    // with back-to-back draws.
    this._lastDrawAt = lateness < hostInterval && lateness < interval ? this._lastDrawAt + interval : timestamp;
    return true;
  }
}
