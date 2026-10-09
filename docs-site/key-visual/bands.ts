// The key visual's moving part: the field is cut into bands that run with the
// route, and each band can slide along it. A band is a damped spring pulled
// back to its place; the opening releases them from a composed scatter, and
// a pointer strikes the ones under it. Pure state, no rendering, so the
// motion is testable on its own.

export interface Bands {
  /** Slide along the route, px; positive is toward the route's head. */
  offset: Float32Array;
  /** px per ms. */
  velocity: Float32Array;
  /** Scene time each band is held until, ms; held bands do not move. */
  holdUntil: Float32Array;
}

/** Spring rate, rad per ms: about 1.6 swings a second, critically damped. */
export const OMEGA = (2 * Math.PI * 1.6) / 1000;
/** No band slides further than this, px. */
export const REACH = 180;

export function createBands(count: number): Bands {
  return {
    offset: new Float32Array(count),
    velocity: new Float32Array(count),
    holdUntil: new Float32Array(count),
  };
}

/** mulberry32: the same sequence for the same seed. */
export function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The opening: every band set back along the route, in runs of one to four
 * bands that share a set-back, so the scatter has a rhythm rather than
 * noise. Bands are released from `centre` outward, `stagger` ms apart per
 * band, so the middle of the symbol arrives first.
 */
export function scatter(
  bands: Bands,
  centre: number,
  distance: number,
  stagger = 9,
  seed = 34
): void {
  const random = seeded(seed);
  const count = bands.offset.length;
  let run = 0;
  let setBack = 0;
  for (let i = 0; i < count; i += 1) {
    if (run === 0) {
      run = 1 + Math.floor(random() * 4);
      setBack = distance * (0.3 + 0.7 * random());
    }
    run -= 1;
    bands.offset[i] = -setBack;
    bands.velocity[i] = 0;
    bands.holdUntil[i] = Math.abs(i - centre) * stagger;
  }
}

/**
 * Pushes the bands around `index` along the route by `speed` (px per ms),
 * stepping down by whole bands to nothing at `radius`.
 */
export function strike(bands: Bands, index: number, speed: number, radius = 5): void {
  for (let d = -radius; d <= radius; d += 1) {
    const i = index + d;
    if (i < 0 || i >= bands.offset.length) continue;
    const share = 1 - Math.abs(d) / (radius + 1);
    bands.velocity[i] = bands.velocity[i]! + speed * share;
  }
}

/** Advances every free band by `dt` ms at scene time `now`; true while any moves. */
export function step(bands: Bands, now: number, dt: number): boolean {
  let moving = false;
  const slices = Math.max(1, Math.ceil(dt / 8));
  const h = dt / slices;
  for (let i = 0; i < bands.offset.length; i += 1) {
    if (now < bands.holdUntil[i]!) {
      moving = true;
      continue;
    }
    let x = bands.offset[i]!;
    let v = bands.velocity[i]!;
    for (let s = 0; s < slices; s += 1) {
      v += (-OMEGA * OMEGA * x - 2 * OMEGA * v) * h;
      x += v * h;
    }
    if (x > REACH) x = REACH;
    if (x < -REACH * 4) x = -REACH * 4;
    if (Math.abs(x) < 0.05 && Math.abs(v) < 1e-3) {
      x = 0;
      v = 0;
    } else {
      moving = true;
    }
    bands.offset[i] = x;
    bands.velocity[i] = v;
  }
  return moving;
}
