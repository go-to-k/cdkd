import { describe, it, expect } from 'vite-plus/test';
import { calculateResourceDrift } from '../../../src/analyzer/drift-calculator.js';
import { stripCcApiAwsManagedFields } from '../../../src/analyzer/cc-api-strip.js';
import {
  readOnlyUncomparedDriftPaths,
  stripDerivedEchoMembers,
} from '../../../src/cli/commands/drift/baseline-keys.js';
import { withoutSiblingOwned } from '../../../src/provisioning/iam-sibling-managed-policies.js';
import { sgRuleOwnershipIdentity } from '../../../src/provisioning/sg-sibling-rules.js';
import {
  deepEqualUnordered,
  withAbsentDefaultKeys,
} from '../../../src/cli/commands/drift/revert-payload.js';

/**
 * go-to-k/cdkd#6854 (lane D): the boundary of each comparison step the drift
 * command applies outside `src/analyzer/drift-*.ts`, as pairs that must NOT
 * compare equal beside the ones that must. The rule inventory, with the AWS
 * behavior behind each rule, is
 * `docs/design/6854-d-drift-cc-normalization-rules.md`.
 */

/** The changed paths `calculateResourceDrift` reports for a baseline / live pair. */
function driftPaths(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  options?: Parameters<typeof calculateResourceDrift>[2]
): string[] {
  return calculateResourceDrift(baseline, aws, options).map((d) => d.path);
}

describe('deepEqualUnordered: key order only (go-to-k/cdkd#6854)', () => {
  it('equates objects whose keys differ only in order, at any depth', () => {
    expect(deepEqualUnordered({ a: 1, b: { c: [1, { d: 2, e: 3 }] } }, { b: { c: [1, { e: 3, d: 2 }] }, a: 1 })).toBe(
      true
    );
  });

  it.each<[string, unknown, unknown]>([
    ['list order', [1, 2], [2, 1]],
    ['list length', [1], [1, 1]],
    ['null against absent', null, undefined],
    ['an undefined member against no member', { a: undefined }, {}],
    ['a number against its string', 1, '1'],
    ['a boolean against its string', true, 'true'],
    ['an empty list against an empty object', [], {}],
    ['an empty string against absent', '', undefined],
    ['case', 'MyRole', 'myrole'],
    ['NaN against NaN', Number.NaN, Number.NaN],
    ['two different Dates', new Date(0), new Date(1)],
    ['two equal Dates (non-plain, never proven equal)', new Date(0), new Date(0)],
    ['a missing key against an extra key', { a: 1 }, { b: 1 }],
  ])('does not equate %s', (_label, a, b) => {
    expect(deepEqualUnordered(a, b)).toBe(false);
    expect(deepEqualUnordered(b, a)).toBe(false);
  });
});

describe('withAbsentDefaultKeys: compares, never equates (go-to-k/cdkd#6854)', () => {
  it('adds only a listed key the baseline lacks and AWS holds, so it is compared', () => {
    const out = withAbsentDefaultKeys({ A: 1 }, { A: 1, B: 'x', C: 'y' }, ['B']);
    expect(Object.prototype.hasOwnProperty.call(out, 'B')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(out, 'C')).toBe(false);
    expect(driftPaths(out, { A: 1, B: 'x', C: 'y' })).toEqual(['B']);
  });

  it('leaves a baseline that holds the key, or a live side without it, by identity', () => {
    const holds = { A: 1, B: 'declared' };
    expect(withAbsentDefaultKeys(holds, { B: 'live' }, ['B'])).toBe(holds);
    const lacks = { A: 1 };
    expect(withAbsentDefaultKeys(lacks, { A: 1 }, ['B'])).toBe(lacks);
  });
});

describe('stripDerivedEchoMembers: only the echo beside its source (go-to-k/cdkd#6854)', () => {
  const TYPE = 'AWS::SecretsManager::RotationSchedule';
  const compare = (baseline: Record<string, unknown>, aws: Record<string, unknown>) =>
    driftPaths(stripDerivedEchoMembers(TYPE, baseline), stripDerivedEchoMembers(TYPE, aws));

  it('a changed echo beside an unchanged expression is not drift (Secrets Manager derives it)', () => {
    expect(
      compare(
        { RotationRules: { ScheduleExpression: 'rate(7 days)', AutomaticallyAfterDays: 7 } },
        { RotationRules: { ScheduleExpression: 'rate(7 days)', AutomaticallyAfterDays: 6 } }
      )
    ).toEqual([]);
  });

  it('a changed expression is drift though the echo is stripped', () => {
    expect(
      compare(
        { RotationRules: { ScheduleExpression: 'rate(7 days)', AutomaticallyAfterDays: 7 } },
        { RotationRules: { ScheduleExpression: 'rate(14 days)', AutomaticallyAfterDays: 14 } }
      )
    ).toEqual(['RotationRules.ScheduleExpression']);
  });

  it('AutomaticallyAfterDays set alone is configuration and stays compared', () => {
    expect(
      compare({ RotationRules: { AutomaticallyAfterDays: 7 } }, { RotationRules: { AutomaticallyAfterDays: 14 } })
    ).toEqual(['RotationRules.AutomaticallyAfterDays']);
  });

  it('a null expression does not license the strip', () => {
    const bag = { RotationRules: { ScheduleExpression: null, AutomaticallyAfterDays: 7 } };
    expect(stripDerivedEchoMembers(TYPE, bag)).toBe(bag);
  });
});

describe('stripCcApiAwsManagedFields: AWS side only, so it cannot equate (go-to-k/cdkd#6854)', () => {
  it('a stripped name the baseline holds is reported, never hidden', () => {
    // `CreatedAt` is a writable property of some types (AWS::IoT::Command).
    const baseline = { Name: 'n', CreatedAt: '2026-01-01' };
    const aws = stripCcApiAwsManagedFields('AWS::Any::Type', { Name: 'n', CreatedAt: '2026-02-02' });
    expect(driftPaths(baseline, aws)).toEqual(['CreatedAt']);
  });

  it('a nested stripped name an observed baseline holds is reported too', () => {
    const baseline = { Filter: { UpdatedAt: [{ Start: 'a' }], Name: 'n' } };
    const aws = stripCcApiAwsManagedFields('AWS::Any::Type', {
      Filter: { UpdatedAt: [{ Start: 'b' }], Name: 'n' },
    });
    expect(driftPaths(baseline, aws, { unionWalkObjects: true })).toEqual(['Filter.UpdatedAt']);
  });
});

describe('sibling-owned strips: what counts as the sibling\'s member (go-to-k/cdkd#6854)', () => {
  it('a UserToGroupAddition group matches the live group case-insensitively, and only that', () => {
    // IAM accepts AddUserToGroup with the group name in another case and
    // lists the group as stored (measured), and names are unique ignoring case.
    const owned = new Set(['admins']);
    expect(withoutSiblingOwned(['Admins', 'Admins2', 'Ops'], owned, undefined, 'Groups', true)).toEqual([
      'Admins2',
      'Ops',
    ]);
  });

  it('managed policy ARNs match exactly', () => {
    const arn = 'arn:aws:iam::123456789012:policy/MyPolicy';
    expect(withoutSiblingOwned([arn, arn.toLowerCase(), `${arn}2`], new Set([arn]), undefined, 'ManagedPolicyArns')).toEqual([
      arn.toLowerCase(),
      `${arn}2`,
    ]);
  });

  it('a member the template also declares stays compared', () => {
    expect(withoutSiblingOwned(['a', 'b'], new Set(['a']), { K: ['a'] }, 'K')).toEqual(['a', 'b']);
  });

  const rule = (over: Record<string, unknown>) => ({
    IpProtocol: 'tcp',
    FromPort: 443,
    ToPort: 443,
    CidrIp: '10.0.0.0/8',
    ...over,
  });

  it.each<[string, Record<string, unknown>]>([
    ['a protocol number', { IpProtocol: '6' }],
    ['a port as a string', { FromPort: '443', ToPort: '443' }],
    ['another Description (EC2 refuses a second rule differing only in it)', { Description: 'x' }],
  ])('an SG rule identity equates %s', (_label, over) => {
    expect(sgRuleOwnershipIdentity(rule(over), 'ingress')).toBe(sgRuleOwnershipIdentity(rule({}), 'ingress'));
  });

  it.each<[string, Record<string, unknown>]>([
    ['another port', { ToPort: 444 }],
    ['another protocol', { IpProtocol: 'udp' }],
    ['a CIDR spelled differently', { CidrIp: '10.0.0.1/8' }],
    ['another peer kind', { CidrIp: undefined, SourcePrefixListId: 'pl-1' }],
    ['all traffic against tcp', { IpProtocol: '-1', FromPort: -1, ToPort: -1 }],
  ])('an SG rule identity does not equate %s', (_label, over) => {
    expect(sgRuleOwnershipIdentity(rule(over), 'ingress')).not.toBe(sgRuleOwnershipIdentity(rule({}), 'ingress'));
  });
});

describe('readOnlyUncomparedDriftPaths: undeclared read-only positions only (go-to-k/cdkd#6854)', () => {
  it('skips an undeclared read-only leaf and nothing beside it', () => {
    const skipped = readOnlyUncomparedDriftPaths(['UpdateTime', 'Endpoint.Address'], { Endpoint: { Port: 1 } });
    expect(skipped).toEqual(['UpdateTime', 'Endpoint.Address']);
    expect(
      driftPaths(
        { Endpoint: { Port: 1, Address: 'a' }, UpdateTime: 't1' },
        { Endpoint: { Port: 2, Address: 'b' }, UpdateTime: 't2' },
        { ignorePaths: skipped }
      )
    ).toEqual(['Endpoint.Port']);
  });

  it('keeps a DECLARED read-only path compared', () => {
    expect(readOnlyUncomparedDriftPaths(['Endpoint.Address'], { Endpoint: { Address: 'a' } })).toEqual([]);
  });

  it('skips nothing when the schema could not be read', () => {
    expect(readOnlyUncomparedDriftPaths(undefined, {})).toEqual([]);
  });
});
