import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  fallbackNamePropertyFor,
  fallbackNameRuleTypes,
  generatedNameFor,
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

  // A directory bucket's name ends with its zone id: the longest kind, a Local
  // Zone's (go-to-k/cdkd#5095).
  const ZONE = 'usw2-lax1-az1';
  const ccProps = (type: string): Record<string, unknown> =>
    type === 'AWS::S3Express::DirectoryBucket' ? { LocationName: ZONE } : {};
  // go-to-k/cdkd#5095: on a legacy stack the Cloud Control handler still names these.
  const LEGACY_CC_UNNAMED = [
    'AWS::AutoScaling::AutoScalingGroup',
    'AWS::DynamoDB::GlobalTable',
    'AWS::ECS::TaskDefinition',
    'AWS::Lambda::NetworkConnector',
    'AWS::Pipes::Pipe',
    'AWS::Scheduler::Schedule',
  ];
  const fits = (name: string, limit: Limit): void => {
    expect(name.length).toBeLessThanOrEqual(limitOf(limit));
    if (limit.schemaPattern !== undefined) {
      // `\Z` is the schema's end anchor where ECMAScript has `$`.
      expect(name).toMatch(new RegExp(limit.schemaPattern.replace(/\\Z/g, '$')));
    }
  };

  describe.each([
    ['a v13 stack (suffixed)', ID],
    ['a legacy stack', undefined],
  ])('%s', (_label, stackInstanceId) => {
    const scoped = <T>(fn: () => T): T =>
      withStackScope({ stackName: STACK, stackInstanceId, nameGenerations: new Map() }, fn);

    it.each(types)('%s, Cloud Control', (type, limit) => {
      const props = scoped(() => applyDefaultNameForFallback(LOGICAL_ID, type, ccProps(type)));
      if (stackInstanceId === undefined && LEGACY_CC_UNNAMED.includes(type)) {
        expect(props).toEqual(ccProps(type));
        return;
      }
      fits(props[limit.nameProperty] as string, limit);
    });

    it.each(types)('%s, SDK provider', (type, limit) => {
      const name = scoped(() => generatedNameFor(type, LOGICAL_ID, { zoneId: ZONE }));
      if (stackInstanceId === undefined && type === 'AWS::CodeBuild::Project') {
        // A legacy stack's project keeps the bare logical id, byte for byte,
        // however long (go-to-k/cdkd#5095).
        expect(name).toBe(LOGICAL_ID);
        return;
      }
      fits(name, limit);
    });
  });
});
