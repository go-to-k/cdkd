import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyDefaultNameForFallback,
  fallbackNamePathFor,
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
  schemaMinLength?: number;
  schemaPattern?: string;
  apiMaxLength?: number;
  /** A prefix the API refuses a name to start with (a security group's `sg-`). */
  apiForbiddenPrefix?: string;
  /** Why `schemaPattern` is matched unanchored: the registry's pattern is narrower than the API. */
  schemaPatternUnanchored?: string;
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
      expect(fallbackNamePathFor(type)?.join('.'), type).toBe(limit.nameProperty);
      expect(Number.isFinite(limitOf(limit)), type).toBe(true);
    }
  });

  // A directory bucket's name ends with its zone id: the longest kind, a Local
  // Zone's (go-to-k/cdkd#5095).
  const ZONE = 'usw2-lax1-az1';
  const ccProps = (type: string): Record<string, unknown> =>
    type === 'AWS::S3Express::DirectoryBucket'
      ? { LocationName: ZONE }
      : type === 'AWS::Glue::Connection'
        ? { ConnectionInput: { ConnectionType: 'JDBC' } }
        : {};
  /** The value at a dotted `nameProperty` (a Glue connection's `ConnectionInput.Name`). */
  const at = (bag: Record<string, unknown>, path: string): unknown =>
    path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], bag);
  // go-to-k/cdkd#5095: a legacy stack's SDK provider sends the bare logical
  // id of these, byte for byte, however long.
  const BARE_LOGICAL_ID = [
    'AWS::CodeBuild::Project',
    'AWS::EC2::SecurityGroup',
    'AWS::CloudTrail::Trail',
    'AWS::Glue::Job',
    'AWS::Glue::Crawler',
    'AWS::Glue::Connection',
    'AWS::Glue::Trigger',
    'AWS::KinesisFirehose::DeliveryStream',
  ];
  // go-to-k/cdkd#5095: on a legacy stack the Cloud Control handler still names these.
  const LEGACY_CC_UNNAMED = [
    'AWS::AutoScaling::AutoScalingGroup',
    'AWS::DynamoDB::GlobalTable',
    'AWS::ECS::TaskDefinition',
    'AWS::Lambda::NetworkConnector',
    'AWS::Pipes::Pipe',
    'AWS::Scheduler::Schedule',
    'AWS::S3Vectors::VectorBucket',
    // CodeBuild has no Cloud Control handlers; its old rule still names it.
    ...BARE_LOGICAL_ID.filter((t) => t !== 'AWS::CodeBuild::Project'),
  ];
  const fits = (name: string, limit: Limit): void => {
    expect(name.length).toBeLessThanOrEqual(limitOf(limit));
    expect(name.length).toBeGreaterThanOrEqual(limit.schemaMinLength ?? 1);
    if (limit.apiForbiddenPrefix !== undefined) {
      expect(name.toLowerCase().startsWith(limit.apiForbiddenPrefix)).toBe(false);
    }
    if (limit.schemaPattern !== undefined) {
      // `\Z` is the schema's end anchor where ECMAScript has `$`.
      // Anchored: an unanchored schema pattern (Firehose's) would match any
      // name holding one valid character.
      const pattern = limit.schemaPattern.replace(/\\Z/g, '$');
      expect(name).toMatch(
        new RegExp(limit.schemaPatternUnanchored === undefined ? `^(?:${pattern})$` : pattern)
      );
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
      fits(at(props, limit.nameProperty) as string, limit);
    });

    it.each(types)('%s, SDK provider', (type, limit) => {
      const name = scoped(() => generatedNameFor(type, LOGICAL_ID, { zoneId: ZONE }));
      if (stackInstanceId === undefined && BARE_LOGICAL_ID.includes(type)) {
        expect(name).toBe(LOGICAL_ID);
        return;
      }
      fits(name, limit);
    });
  });

  // A stack name may start with `sg-`; EC2 refuses a group name that does
  // (go-to-k/cdkd#5095). Both routes drop the hyphen, in any case.
  it.each(['sg-app', 'SG-app', 'Sg-app'])('a security group of stack %s', (stackName) => {
    const scoped = <T>(fn: () => T): T =>
      withStackScope({ stackName, stackInstanceId: ID, nameGenerations: new Map() }, fn);
    const type = 'AWS::EC2::SecurityGroup';
    const sdk = scoped(() => generatedNameFor(type, 'Group'));
    expect(sdk).toMatch(new RegExp(`^${stackName.slice(0, 2)}app-Group-[0-9a-f]{12}$`));
    expect(scoped(() => applyDefaultNameForFallback('Group', type, {}))['GroupName']).toBe(sdk);
    fits(sdk, fixture.types[type]!);
  });

  it('a security group of a 128-character sg- stack: cut to 255, then the hyphen dropped', () => {
    const stackName = `sg-${'a'.repeat(125)}`;
    const name = withStackScope({ stackName, stackInstanceId: ID, nameGenerations: new Map() }, () =>
      generatedNameFor('AWS::EC2::SecurityGroup', LOGICAL_ID)
    );
    expect(name).toMatch(/^sga+-ResourceX+-[0-9a-f]{12}$/);
    expect(name.length).toBe(254);
    fits(name, fixture.types['AWS::EC2::SecurityGroup']!);
  });
});
