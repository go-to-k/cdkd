import { describe, it, expect, afterEach } from 'vite-plus/test';
import { parseCfnTimestamp } from '../../../src/utils/cfn-timestamp.js';

const ORIGINAL_TZ = process.env.TZ;

describe('parseCfnTimestamp (issue #5311)', () => {
  afterEach(() => {
    if (ORIGINAL_TZ === undefined) delete process.env.TZ;
    else process.env.TZ = ORIGINAL_TZ;
  });

  // Every row is asserted under a zone EAST and WEST of UTC: `new Date()` reads
  // an offset-less date-time in the host's zone, so a UTC-only run cannot
  // tell the fix from the bug.
  const ROWS: Array<[string, string]> = [
    // Offset-less date-times: read as UTC, as CloudFormation does.
    ['2026-01-01T00:00:00', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T00:00', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T12:34:56.789', '2026-01-01T12:34:56.789Z'],
    ['2026-01-01t00:00:00', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01 00:00:00', '2026-01-01T00:00:00.000Z'],
    // Already unambiguous: unchanged.
    ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01T09:00:00+09:00', '2026-01-01T00:00:00.000Z'],
    ['2025-12-31T19:00:00-05:00', '2026-01-01T00:00:00.000Z'],
    ['2026-01-01', '2026-01-01T00:00:00.000Z'],
  ];

  for (const tz of ['Asia/Tokyo', 'America/New_York', 'UTC']) {
    it(`reads each row as the same instant under TZ=${tz}`, () => {
      process.env.TZ = tz;
      expect(ROWS.map(([input]) => parseCfnTimestamp(input).toISOString())).toEqual(
        ROWS.map(([, iso]) => iso)
      );
    });
  }

  it('leaves an unparsable string an Invalid Date for the caller to reject', () => {
    expect(Number.isNaN(parseCfnTimestamp('garbage').getTime())).toBe(true);
    expect(Number.isNaN(parseCfnTimestamp('2026-01-01T00:00:00ZZ').getTime())).toBe(true);
  });
});
