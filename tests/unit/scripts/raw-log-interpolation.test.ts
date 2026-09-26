import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import {
  compare,
  countRawLogInterpolations,
  measure,
} from '../../../scripts/check-raw-log-interpolation.js';

const BASELINE = JSON.parse(
  readFileSync(join(import.meta.dirname, '../../raw-log-interpolation-baseline.json'), 'utf8')
) as Record<string, number>;

describe('check-raw-log-interpolation (go-to-k/cdkd#3479)', () => {
  it.each([
    ['logger.info(`a ${x}`)', 1],
    ['this.logger.warn("a " + x)', 1],
    ['getLogger().error(`a` + (c ? `b ${x}` : ""))', 1],
    ['opts.logger.debug("a" + safeMsg`b ${x}`)', 0],
    ['logger.info(safeMsg`a ${x}` + (c ? safeMsg`b ${y}` : "c"))', 0],
    ['logger.info("a" + "b")', 0],
    ['logger.info(msg)', 0],
    ['console.info(`a ${x}`)', 0],
    ['logger.info(other`a ${x}`)', 1],
  ])('%s -> %i', (source, expected) => {
    expect(countRawLogInterpolations(source)).toBe(expected);
  });

  it('fails a file that gained a raw site and only warns on one that lost some', () => {
    expect(compare({ a: 2, b: 1 }, { a: 2, b: 1 })).toEqual({ gained: [], stale: [] });
    expect(compare({ a: 3 }, { a: 2 }).gained).toEqual([expect.stringContaining('safeMsg')]);
    expect(compare({}, { a: 2 })).toEqual({
      gained: [],
      stale: [expect.stringContaining('--update')],
    });
  });

  it('compares per file, so a drop in one file cannot mask a gain in another', () => {
    const { gained, stale } = compare({ a: 1, b: 3 }, { a: 2, b: 2 });
    expect(gained).toEqual([expect.stringMatching(/^b: /)]);
    expect(stale).toEqual([expect.stringMatching(/^a: /)]);
    expect(compare({ c: 1 }, {}).gained).toEqual([expect.stringMatching(/^c: 1 .*baseline 0/)]);
  });

  it('measures a real file on disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raw-log-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'nested', 'x.ts'), 'logger.info(`${x}`);\n');
      writeFileSync(join(dir, 'clean.ts'), 'logger.info(safeMsg`${x}`);\n');
      const counts = measure(dir);
      expect(Object.values(counts)).toEqual([1]);
      expect(Object.keys(counts)[0]).toMatch(/nested\/x\.ts$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('no file exceeds the committed baseline, over a tree that is really there', () => {
    const actual = measure();
    const total = Object.values(actual).reduce((a, b) => a + b, 0);
    const baselineTotal = Object.values(BASELINE).reduce((a, b) => a + b, 0);
    // A scan that found nothing would pass the gain check vacuously.
    expect(Object.keys(actual).length).toBeGreaterThan(Object.keys(BASELINE).length / 2);
    expect(total).toBeGreaterThan(baselineTotal / 2);
    expect(compare(actual, BASELINE).gained).toEqual([]);
  });
});
