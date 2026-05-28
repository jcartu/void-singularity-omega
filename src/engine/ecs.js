// Minimal ECS. Intentionally tiny — the gameplay-worker lane extends it.
// Entities are integer ids; components are plain objects in typed stores.

export class ECS {
  constructor() {
    this._next = 1;
    this.entities = new Set();
    this.stores = new Map(); // name -> Map<entityId, component>
    this.systems = [];
  }

  create() {
    const id = this._next++;
    this.entities.add(id);
    return id;
  }

  destroy(id) {
    this.entities.delete(id);
    for (const store of this.stores.values()) store.delete(id);
  }

  store(name) {
    let s = this.stores.get(name);
    if (!s) { s = new Map(); this.stores.set(name, s); }
    return s;
  }

  add(id, name, component) { this.store(name).set(id, component); return component; }
  get(id, name) { return this.stores.get(name)?.get(id); }
  has(id, name) { return this.stores.get(name)?.has(id) ?? false; }
  remove(id, name) { this.stores.get(name)?.delete(id); }

  /** Iterate entities possessing ALL named components. */
  *query(...names) {
    const stores = names.map((n) => this.store(n));
    const smallest = stores.reduce((a, b) => (a.size <= b.size ? a : b));
    outer: for (const id of smallest.keys()) {
      const comps = [];
      for (const s of stores) {
        const c = s.get(id);
        if (c === undefined) continue outer;
        comps.push(c);
      }
      yield [id, ...comps];
    }
  }

  addSystem(fn) { this.systems.push(fn); return fn; }
  run(dt, t) { for (const sys of this.systems) sys(this, dt, t); }
}
