import { describe, expect, it } from 'vite-plus/test';
import {
  OMEGA,
  REACH,
  createBands,
  scatter,
  seeded,
  step,
  strike,
} from '../../../docs-site/key-visual/bands.js';
import { parseHex } from '../../../docs-site/key-visual/color.js';

// The key visual's motion is plain state: bands that slide along the route,
// pulled home by critically damped springs.

const settle = (bands: ReturnType<typeof createBands>, from = 0, limit = 10_000): number => {
  let now = from;
  while (step(bands, now, 16)) {
    now += 16;
    if (now - from > limit) throw new Error('bands never came to rest');
  }
  return now - from;
};

describe('scatter', () => {
  it('composes the same opening every time', () => {
    const a = createBands(40);
    const b = createBands(40);
    scatter(a, 20, 600);
    scatter(b, 20, 600);
    expect([...a.offset]).toEqual([...b.offset]);
  });

  it('sets every band back toward the tail, in runs that share a set-back', () => {
    const bands = createBands(60);
    scatter(bands, 30, 500);
    const offsets = [...bands.offset];
    expect(offsets.every((offset) => offset <= -150 && offset >= -500)).toBe(true);
    const runs = offsets.filter((offset, i) => i === 0 || offset !== offsets[i - 1]).length;
    expect(runs).toBeLessThan(offsets.length);
    expect(runs).toBeGreaterThan(offsets.length / 4);
  });

  it('releases the route lane first and the outer bands last', () => {
    const bands = createBands(21);
    scatter(bands, 10, 400, 9);
    expect(bands.holdUntil[10]).toBe(0);
    expect(bands.holdUntil[0]).toBe(90);
    expect(bands.holdUntil[20]).toBe(90);
  });
});

describe('step', () => {
  it('brings every band home and then reports rest', () => {
    const bands = createBands(30);
    scatter(bands, 15, 700);
    const took = settle(bands);
    expect([...bands.offset].every((offset) => offset === 0)).toBe(true);
    expect([...bands.velocity].every((velocity) => velocity === 0)).toBe(true);
    // Critically damped at OMEGA: the opening is over in well under 3 s.
    expect(took).toBeLessThan(3000);
    expect(step(bands, took + 16, 16)).toBe(false);
  });

  it('holds a band until its release time', () => {
    const bands = createBands(1);
    bands.offset[0] = -100;
    bands.holdUntil[0] = 500;
    expect(step(bands, 100, 16)).toBe(true);
    expect(bands.offset[0]).toBe(-100);
    step(bands, 520, 16);
    expect(bands.offset[0]).toBeGreaterThan(-100);
  });

  it('never overshoots home from rest (critical damping)', () => {
    const bands = createBands(1);
    bands.offset[0] = -300;
    for (let now = 0; now < 4000; now += 16) {
      step(bands, now, 16);
      expect(bands.offset[0]).toBeLessThanOrEqual(0);
    }
    expect(OMEGA).toBeGreaterThan(0);
  });
});

describe('strike', () => {
  it('pushes the bands under the pointer, stepping down to nothing at the radius', () => {
    const bands = createBands(20);
    strike(bands, 10, 2, 3);
    expect(bands.velocity[10]).toBe(2);
    expect(bands.velocity[11]).toBeCloseTo(1.5);
    expect(bands.velocity[9]).toBeCloseTo(1.5);
    expect(bands.velocity[13]).toBeCloseTo(0.5);
    expect(bands.velocity[14]).toBe(0);
    expect(bands.velocity[6]).toBe(0);
  });

  it('ignores bands past either end, and caps how far a band slides forward', () => {
    const bands = createBands(3);
    strike(bands, 0, 50, 5);
    settle(bands);
    strike(bands, 1, 500, 0);
    let peak = 0;
    for (let now = 0; now < 2000; now += 16) {
      step(bands, now, 16);
      peak = Math.max(peak, bands.offset[1]!);
    }
    expect(peak).toBe(REACH);
  });
});

describe('seeded', () => {
  it('is deterministic per seed', () => {
    const a = seeded(34);
    const b = seeded(34);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(seeded(1)()).not.toBe(seeded(2)());
  });
});

describe('parseHex', () => {
  it('reads #rgb and #rrggbb, and refuses anything else', () => {
    expect(parseHex('#ff8a1f')).toEqual([1, 138 / 255, 31 / 255]);
    expect(parseHex(' #fff ')).toEqual([1, 1, 1]);
    expect(() => parseHex('rgb(0 0 0)')).toThrow(/not a hex color/);
  });
});
