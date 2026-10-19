import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  fallbackNamePropertyFor,
  fallbackNameRuleTypes,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';

/**
 * go-to-k/cdkd#5064: every name `applyDefaultNameForFallback` generates fits
 * its type's name property -- under the 13-character stack-instance suffix
 * and the legacy scheme alike -- for the longest stack name CloudFormation
 * allows and a long logical id. The limits are read from
 * `tests/fixtures/generated-name-limits.json` (copied from AWS's public
 * CloudFormation schema bundle, plus the service API limit where the schema
 * is silent or bounds only an ARN form).
 */
interface Limit {
  nameProperty: string;
  schemaMaxLength?: number;
  schemaPattern?: string;
  apiMaxLength?: number;
}
const fixture = JSON.parse(
  readFileSync(new URL('../../fixtures/generated-name-limits.json', import.meta.url), 'utf8')
) as { types: Record<string, Limit> };
const types = Object.entries(fixture.types);

/** A pattern's own bound on a NAME: `^[class]{m,N}$` (an ARN alternative excluded). */
function patternMax(pattern: string | undefined): number | undefined {
  if (pattern === undefined) return undefined;
  const alternatives = pattern.split('|').filter((a) => !a.includes('arn:'));
  const bounds = alternatives.map((a) => /^\^?\[[^\]]+\]\{\d+,(\d+)\}\$?$/.exec(a)?.[1]);
  return bounds.every((b) => b !== undefined) && bounds.length > 0
    ? Math.min(...bounds.map(Number))
    : undefined;
}

const limitOf = (l: Limit): number => {
  const bounds = [l.schemaMaxLength, l.apiMaxLength, patternMax(l.schemaPattern)].filter(
    (b): b is number => b !== undefined
  );
  return Math.min(...bounds);
};

// The longest stack name CloudFormation accepts, and a long logical id.
const STACK = `S${'a'.repeat(127)}`;
const LOGICAL_ID = `Resource${'X'.repeat(200)}`;
const ID = '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

describe('generated names fit their name property (#5064)', () => {
  it('covers every type cdkd generates a Cloud Control name for, each with a limit', () => {
    expect(types.length).toBeGreaterThanOrEqual(40);
    // Both ways: a type added to the rules without a limit here fails.
    expect(types.map(([type]) => type).sort()).toEqual(fallbackNameRuleTypes().sort());
    for (const [type, limit] of types) {
      expect(fallbackNamePropertyFor(type), type).toBe(limit.nameProperty);
      expect(Number.isFinite(limitOf(limit)), type).toBe(true);
    }
  });

  describe.each([
    ['a v13 stack (suffixed)', ID],
    ['a legacy stack', undefined],
  ])('%s', (_label, stackInstanceId) => {
    it.each(types)('%s', (type, limit) => {
      const props = withStackScope({ stackName: STACK, stackInstanceId }, () =>
        applyDefaultNameForFallback(LOGICAL_ID, type, {})
      );
      const name = props[limit.nameProperty] as string;
      expect(name.length).toBeLessThanOrEqual(limitOf(limit));
      if (limit.schemaPattern !== undefined) {
        // `\Z` is the schema's end anchor where ECMAScript has `$`.
        expect(name).toMatch(new RegExp(limit.schemaPattern.replace(/\\Z/g, '$')));
      }
    });
  });
});
