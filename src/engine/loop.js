// Deterministic fixed-step loop with render interpolation.
// Fixed sim step keeps physics + bullet patterns reproducible for self-play replays.

export class Loop {
  constructor({ update, render, step = 1 / 120, maxSub = 8 }) {
    this.update = update;
    this.render = render;
    this.step = step;
    this.maxSub = maxSub;
    this._acc = 0;
    this._last = 0;
    this._raf = 0;
    this._running = false;
    this.time = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this._tick = this._tick.bind(this);
    this._paused = false;
    this._autoPaused = false;
    this._onVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) {
        this.setPaused(true);
        this._autoPaused = true;
      } else if (this._autoPaused) {
        this.setPaused(false);
        this._autoPaused = false;
      }
    };
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', this._onVisibility);
    }
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._last = performance.now() / 1000;
    this._raf = requestAnimationFrame(this._tick);
  }

  stop() {
    this._running = false;
    cancelAnimationFrame(this._raf);
    if (typeof document !== 'undefined' && typeof document.removeEventListener === 'function') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
  }

  setPaused(p) {
    const next = !!p;
    if (next === this._paused) return;
    this._paused = next;
    if (!next) this._last = performance.now() / 1000;
  }

  _tick() {
    if (!this._running) return;
    const now = performance.now() / 1000;
    let frame = now - this._last;
    if (this._paused) frame = 0;
    this._last = now;
    if (frame > 0.25) frame = 0.25; // clamp spiral-of-death

    this._acc += frame;
    let sub = 0;
    while (this._acc >= this.step && sub < this.maxSub) {
      this.update(this.step, this.time);
      this.time += this.step;
      this._acc -= this.step;
      sub++;
    }
    const alpha = this._acc / this.step;
    this.render(alpha);

    // rolling FPS
    this._fpsAcc += frame;
    this._fpsFrames++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsFrames = 0;
    }
    this._raf = requestAnimationFrame(this._tick);
  }
}
