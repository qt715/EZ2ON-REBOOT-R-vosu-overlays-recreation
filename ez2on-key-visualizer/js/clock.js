// Gameplay clock for the draw loop, adapted from rt-beatmap-renderer's PlaybackClock: samples
// arrive with delivery jitter, so the clock advances on its own at the playback rate and eases
// toward each sample instead of jumping.

const AHEAD_TIME_CONSTANT_MS = 25;
const BEHIND_TIME_CONSTANT_MS = 500;
const SNAP_THRESHOLD_MS = 150;
const BURST_WINDOW_MS = 0.5;
// Without samples for this long the game stopped advancing (pause, fail, loading): stop extrapolating.
const STALL_AFTER_MS = 120;

export class PlaybackClock {
  constructor(nowMs = () => performance.now()) {
    this._nowMs = nowMs;
    this.playbackRate = 1;
    this.isPlaying = false;
    this._timeMs = 0;
    this._anchorMs = nowMs();
    this._lastSampleMs = Number.NEGATIVE_INFINITY;
    this._lastArrivalMs = Number.NEGATIVE_INFINITY;
    this._burstBaseTimeMs = 0;
    this._burstBaseAnchorMs = 0;
    this._burstElapsedMs = 0;
  }

  update(currentTime, playbackRate, isPlaying) {
    const at = this._nowMs();
    const rate = Number.isFinite(playbackRate) && playbackRate > 0 ? playbackRate : this.playbackRate;
    const transition = isPlaying !== this.isPlaying || rate !== this.playbackRate;
    this._lastArrivalMs = at;

    if (!Number.isFinite(currentTime)) {
      this._timeMs = this._estimateAt(at);
      this._lastSampleMs = Number.NEGATIVE_INFINITY;
    } else if (!isPlaying || transition) {
      this._timeMs = currentTime;
      this._lastSampleMs = Number.NEGATIVE_INFINITY;
    } else {
      if (at - this._lastSampleMs >= BURST_WINDOW_MS) {
        this._burstBaseTimeMs = this._estimateAt(at);
        this._burstBaseAnchorMs = at;
        this._burstElapsedMs = Math.max(0, at - this._lastSampleMs);
      }
      const estimate = this._burstBaseTimeMs + (at - this._burstBaseAnchorMs) * rate;
      const error = currentTime - estimate;
      if (Math.abs(error) > SNAP_THRESHOLD_MS) {
        this._timeMs = currentTime;
      } else {
        const tau = error > 0 ? AHEAD_TIME_CONSTANT_MS : BEHIND_TIME_CONSTANT_MS;
        this._timeMs = estimate + error * (1 - Math.exp(-this._burstElapsedMs / tau));
      }
      this._lastSampleMs = at;
    }

    this._anchorMs = at;
    this.playbackRate = rate;
    this.isPlaying = isPlaying;
  }

  now() {
    return this._estimateAt(this._nowMs());
  }

  /** True while samples keep arriving during play, i.e. the picture is moving. */
  isAdvancing() {
    return this.isPlaying && this._nowMs() - this._lastArrivalMs < STALL_AFTER_MS;
  }

  _estimateAt(at) {
    if (!this.isPlaying) return this._timeMs;
    const elapsed = Math.min(at - this._anchorMs, STALL_AFTER_MS);
    return this._timeMs + elapsed * this.playbackRate;
  }
}
