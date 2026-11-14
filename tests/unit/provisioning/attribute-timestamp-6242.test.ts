import { describe, it, expect } from 'vite-plus/test';
import { isoTimestampAttribute } from '../../../src/provisioning/attribute-timestamp.js';

// go-to-k/cdkd#6242: the timestamp text a recorded attribute carries.
describe('isoTimestampAttribute', () => {
  it('drops a zero millisecond fraction (CloudFormation shows none)', () => {
    expect(isoTimestampAttribute(new Date('2026-11-14T07:49:04Z'))).toBe('2026-11-14T07:49:04Z');
  });
  it('keeps a non-zero fraction', () => {
    expect(isoTimestampAttribute(new Date('2026-11-14T07:53:01.825Z'))).toBe(
      '2026-11-14T07:53:01.825Z'
    );
  });
  it('is undefined for a missing or invalid date', () => {
    expect(isoTimestampAttribute(undefined)).toBeUndefined();
    expect(isoTimestampAttribute(null)).toBeUndefined();
    expect(isoTimestampAttribute(new Date('nope'))).toBeUndefined();
  });
});
