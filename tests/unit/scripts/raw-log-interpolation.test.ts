import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

import {
  compare,
  countRawLogInterpolations,
  measure,
} from '../../../scripts/check-raw-log-interpolation.js';

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

  it('reports a file that gained or lost a raw site', () => {
    expect(compare({ a: 2, b: 1 }, { a: 2, b: 1 })).toEqual([]);
    expect(compare({ a: 3 }, { a: 2 })).toEqual([expect.stringContaining('safeMsg')]);
    expect(compare({}, { a: 2 })).toEqual([expect.stringContaining('--update')]);
  });

  it('agrees with the committed baseline', () => {
    const baseline = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../raw-log-interpolation-baseline.json'), 'utf8')
    ) as Record<string, number>;
    expect(compare(measure(), baseline)).toEqual([]);
  });
});
