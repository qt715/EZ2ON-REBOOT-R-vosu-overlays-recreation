// Press history reconstructed from vosu `keys.all` samples. Times are gameplay milliseconds.

// A tap seen only as a count change (both edges fell between samples) is drawn this long.
const UNSEEN_TAP_MS = 30;

export class Lane {
  constructor() {
    this.starts = [];
    this.ends = []; // NaN while held
    this.head = 0; // first segment still visible
    this.count = 0;
    this.pressedAt = null;
    this.releasedAt = null;
    this.isPressed = false;
  }

  get open() {
    const last = this.ends.length - 1;
    return last >= this.head && Number.isNaN(this.ends[last]);
  }

  closeOpen(time) {
    const last = this.ends.length - 1;
    if (last >= this.head && Number.isNaN(this.ends[last])) {
      this.ends[last] = Math.max(this.starts[last], time);
    }
  }

  push(start, end) {
    this.starts.push(start);
    this.ends.push(end);
  }

  /** Drops segments that ended before `time`; compacts occasionally instead of every frame. */
  prune(time) {
    while (this.head < this.ends.length && this.ends[this.head] < time) this.head++;
    if (this.head > 256) {
      this.starts.splice(0, this.head);
      this.ends.splice(0, this.head);
      this.head = 0;
    }
  }
}

export class PressHistory {
  constructor() {
    this.lanes = [];
  }

  clear() {
    this.lanes = [];
  }

  /**
   * @param keys vosu `keys.all` array
   * @param offset ms added to edge timestamps so presses line up with note times
   * @param now current (offset-adjusted) gameplay time, used for edges vosu could not timestamp
   */
  ingest(keys, offset, now) {
    if (keys.length !== this.lanes.length) {
      this.lanes = keys.map((key) => {
        const lane = new Lane();
        lane.count = key.count;
        lane.pressedAt = key.pressedAt;
        lane.releasedAt = key.releasedAt;
        lane.isPressed = key.isPressed;
        if (key.isPressed && key.pressedAt != null) lane.push(key.pressedAt + offset, Number.NaN);
        return lane;
      });
      return;
    }
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const lane = this.lanes[i];
      if (key.count < lane.count) {
        // Retry or rewind: the counter restarted.
        this.lanes[i] = new Lane();
        Object.assign(this.lanes[i], {
          count: key.count,
          pressedAt: key.pressedAt,
          releasedAt: key.releasedAt,
          isPressed: key.isPressed,
        });
        continue;
      }
      const newPressEdge = key.pressedAt != null && key.pressedAt !== lane.pressedAt;
      const newReleaseEdge = key.releasedAt != null && key.releasedAt !== lane.releasedAt;

      if (newPressEdge) {
        const start = key.pressedAt + offset;
        lane.closeOpen(newReleaseEdge && key.releasedAt < key.pressedAt ? key.releasedAt + offset : start);
        const released = !key.isPressed;
        const end = released
          ? newReleaseEdge && key.releasedAt >= key.pressedAt
            ? key.releasedAt + offset
            : start + UNSEEN_TAP_MS
          : Number.NaN;
        lane.push(start, end);
      } else if (key.count > lane.count) {
        // The count moved but the press edge was not sampled: a whole tap fell between samples.
        const at = newReleaseEdge ? key.releasedAt + offset : now;
        lane.closeOpen(at - UNSEEN_TAP_MS);
        lane.push(at - UNSEEN_TAP_MS, at);
      } else if (newReleaseEdge || (!key.isPressed && lane.isPressed)) {
        lane.closeOpen(newReleaseEdge ? key.releasedAt + offset : now);
      }

      lane.count = key.count;
      lane.pressedAt = key.pressedAt;
      lane.releasedAt = key.releasedAt;
      lane.isPressed = key.isPressed;
    }
  }
}
