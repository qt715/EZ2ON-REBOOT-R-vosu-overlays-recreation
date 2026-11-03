// Rolling draw-interval statistics behind the debug frame rate readout.

const WINDOW_MS = 10_000;
// The window at 1000 fps, the highest frame rate limit; older frames are dropped beyond it.
const CAPACITY = 10_000;

export class FrameStats {
  constructor() {
    this._at = new Float64Array(CAPACITY);
    this._interval = new Float64Array(CAPACITY);
    this._scratch = new Float64Array(CAPACITY);
    this._head = 0;
    this._size = 0;
    this._previous = Number.NaN;
  }

  clear() {
    this._head = 0;
    this._size = 0;
    this._previous = Number.NaN;
  }

  /**
   * Records a draw at `timestamp`. Pass `continuous = false` when the draw loop was idle before
   * this draw: the gap since the previous draw is then a pause, not a frame interval.
   */
  frame(timestamp, continuous) {
    const previous = this._previous;
    this._previous = timestamp;
    if (!continuous || !(timestamp > previous)) return;
    let slot;
    if (this._size === CAPACITY) {
      slot = this._head;
      this._head = (this._head + 1) % CAPACITY;
    } else {
      slot = (this._head + this._size++) % CAPACITY;
    }
    this._at[slot] = timestamp;
    this._interval[slot] = timestamp - previous;
  }

  /**
   * Frame rates over the draws in the `WINDOW_MS` before `now`, or null without any. `p95` and
   * `p99` are the 95th and 99th percentile frame times as frame rates: 95% (99%) of frames came
   * at least that fast.
   */
  summary(now, out = { avg: 0, p95: 0, p99: 0 }) {
    const oldest = now - WINDOW_MS;
    while (this._size > 0 && this._at[this._head] < oldest) {
      this._head = (this._head + 1) % CAPACITY;
      this._size--;
    }
    const n = this._size;
    if (n === 0) return null;
    const sorted = this._scratch.subarray(0, n);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const interval = this._interval[(this._head + i) % CAPACITY];
      sorted[i] = interval;
      total += interval;
    }
    sorted.sort();
    out.avg = (1000 * n) / total;
    out.p95 = 1000 / sorted[Math.ceil(0.95 * n) - 1];
    out.p99 = 1000 / sorted[Math.ceil(0.99 * n) - 1];
    return out;
  }
}
