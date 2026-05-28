// Input manager — keyboard/mouse/gamepad. Pointer aim drives the twin-stick feel.

export class Input {
  constructor(target) {
    this.target = target;
    this.keys = new Set();
    this.pointer = { x: 0, y: 0, nx: 0, ny: 0, down: false };
    this.gamepadIndex = null;

    addEventListener('keydown', (e) => this.keys.add(e.code));
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    target.addEventListener('pointermove', (e) => {
      const r = target.getBoundingClientRect();
      this.pointer.x = e.clientX - r.left;
      this.pointer.y = e.clientY - r.top;
      this.pointer.nx = (this.pointer.x / r.width) * 2 - 1;
      this.pointer.ny = -((this.pointer.y / r.height) * 2 - 1);
    });
    target.addEventListener('pointerdown', () => (this.pointer.down = true));
    addEventListener('pointerup', () => (this.pointer.down = false));
    addEventListener('gamepadconnected', (e) => (this.gamepadIndex = e.gamepad.index));
    addEventListener('gamepaddisconnected', () => (this.gamepadIndex = null));
  }

  down(code) { return this.keys.has(code); }

  axis() {
    let x = 0, y = 0;
    if (this.down('KeyA') || this.down('ArrowLeft')) x -= 1;
    if (this.down('KeyD') || this.down('ArrowRight')) x += 1;
    if (this.down('KeyW') || this.down('ArrowUp')) y += 1;
    if (this.down('KeyS') || this.down('ArrowDown')) y -= 1;
    const gp = this.gamepadIndex != null ? navigator.getGamepads()[this.gamepadIndex] : null;
    if (gp) {
      if (Math.abs(gp.axes[0]) > 0.15) x = gp.axes[0];
      if (Math.abs(gp.axes[1]) > 0.15) y = -gp.axes[1];
    }
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }
}
