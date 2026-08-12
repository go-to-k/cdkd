/**
 * Pre-flight mutually-exclusive-property check (issue #1634).
 *
 * The two behaviors worth stating up front, because every other case is a
 * variation on them:
 *
 * - Two UNCONDITIONALLY declared keys of one rule are refused.
 * - A key behind an UNRESOLVED intrinsic is `unknown`, never `declared` —
 *   pre-flight runs before intrinsic resolution and an `Fn::If` arm can
 *   resolve to `AWS::NoValue`, so counting it would refuse a VALID template
 *   with no escape hatch.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vite-plus/test';
import {
  MUTUALLY_EXCLUSIVE_PROPERTIES,
  buildMutuallyExclusiveMessage,
  findMutuallyExclusiveViolations,
} from '../../../src/provisioning/mutually-exclusive-properties.js';
import { narrowRouteDestinations } from '../../../src/provisioning/providers/ec2-provider.js';

const ROUTE = 'AWS::EC2::Route';

function violationProperties(
  properties: Record<string, unknown> | undefined,
  resourceType = ROUTE
): string[][] {
  return findMutuallyExclusiveViolations(resourceType, properties).map((v) => v.declared);
}

describe('findMutuallyExclusiveViolations', () => {
  it('refuses two unconditionally declared destinations', () => {
    expect(
      violationProperties({
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.0.0.0/8',
        DestinationIpv6CidrBlock: '::/0',
      })
    ).toEqual([['DestinationCidrBlock', 'DestinationIpv6CidrBlock']]);
  });

  it('reports all three when all three are declared, in rule order', () => {
    // The order is load-bearing: `declared[0]` is what the provider's `||`
    // chain sends, and the message names it as the key that reaches AWS.
    // Declared here in REVERSE of the rule order so a test that merely echoed
    // the input's key order would fail.
    expect(
      violationProperties({
        DestinationPrefixListId: 'pl-1',
        DestinationIpv6CidrBlock: '::/0',
        DestinationCidrBlock: '10.0.0.0/8',
      })
    ).toEqual([
      ['DestinationCidrBlock', 'DestinationIpv6CidrBlock', 'DestinationPrefixListId'],
    ]);
  });

  it('accepts exactly one destination', () => {
    expect(violationProperties({ RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/8' })).toEqual(
      []
    );
    expect(violationProperties({ RouteTableId: 'rtb-1', DestinationPrefixListId: 'pl-1' })).toEqual([]);
  });

  it('accepts a resource declaring none of the rule properties', () => {
    expect(violationProperties({ RouteTableId: 'rtb-1', GatewayId: 'igw-1' })).toEqual([]);
  });

  it('returns [] for a type with no rules, and for an absent property bag', () => {
    expect(
      violationProperties(
        { DestinationCidrBlock: '10.0.0.0/8', DestinationIpv6CidrBlock: '::/0' },
        'AWS::S3::Bucket'
      )
    ).toEqual([]);
    expect(violationProperties(undefined)).toEqual([]);
  });

  describe('presence predicate', () => {
    it.each([
      ['empty string', ''],
      ['zero', 0],
      ['null', null],
      ['undefined', undefined],
      ['false', false],
    ])('does not count a %s value as declared', (_label, falsy) => {
      // Matches `narrowRouteDestinations`' `Boolean(...)` narrowing in
      // ec2-provider.ts: the provider's `||` chain skips these, so counting
      // them here would refuse a template the provider itself accepts.
      expect(
        violationProperties({
          DestinationCidrBlock: '10.0.0.0/8',
          DestinationIpv6CidrBlock: falsy,
        })
      ).toEqual([]);
    });

    it('counts a truthy non-string value such as an array', () => {
      // NOT a fence for the `Array.isArray` arm of `isUnresolvedIntrinsic`:
      // an array's own keys are '0' / '1' / ..., so it fails the Ref / Fn::
      // test regardless and this case passes with the arm removed. The arm is
      // documented in-code as belt-and-braces for exactly that reason.
      expect(
        violationProperties({
          DestinationCidrBlock: '10.0.0.0/8',
          DestinationIpv6CidrBlock: ['::/0'],
        })
      ).toEqual([['DestinationCidrBlock', 'DestinationIpv6CidrBlock']]);
    });

    it('counts a multi-key object — only a SINGLE-key Fn::*/Ref object is an intrinsic', () => {
      expect(
        violationProperties({
          DestinationCidrBlock: '10.0.0.0/8',
          DestinationIpv6CidrBlock: { 'Fn::If': ['C', 'a', 'b'], Extra: 1 },
        })
      ).toEqual([['DestinationCidrBlock', 'DestinationIpv6CidrBlock']]);
    });
  });

  describe('unresolved intrinsics', () => {
    it('does not refuse two keys that are BOTH behind an Fn::If', () => {
      // The canonical valid template: each arm yields AWS::NoValue for the
      // other branch, so exactly one destination survives resolution.
      expect(
        violationProperties({
          RouteTableId: 'rtb-1',
          DestinationCidrBlock: { 'Fn::If': ['IsV4', '10.0.0.0/8', { Ref: 'AWS::NoValue' }] },
          DestinationIpv6CidrBlock: { 'Fn::If': ['IsV4', { Ref: 'AWS::NoValue' }, '::/0'] },
        })
      ).toEqual([]);
    });

    it('does not refuse one literal alongside one Fn::If', () => {
      expect(
        violationProperties({
          DestinationCidrBlock: '10.0.0.0/8',
          DestinationIpv6CidrBlock: { 'Fn::If': ['C', { Ref: 'AWS::NoValue' }, '::/0'] },
        })
      ).toEqual([]);
    });

    it.each([['Ref', { Ref: 'SomeParam' }], ['Fn::Sub', { 'Fn::Sub': '${X}' }]])(
      'treats a %s value as unknown rather than declared',
      (_label, intrinsic) => {
        expect(
          violationProperties({
            DestinationCidrBlock: '10.0.0.0/8',
            DestinationIpv6CidrBlock: intrinsic,
          })
        ).toEqual([]);
      }
    );

    it('still refuses TWO literals when a third key is behind an Fn::If', () => {
      // Two unconditional keys are invalid whatever the third resolves to,
      // and the report names only the keys actually proven present.
      expect(
        violationProperties({
          DestinationCidrBlock: '10.0.0.0/8',
          DestinationIpv6CidrBlock: '::/0',
          DestinationPrefixListId: { 'Fn::If': ['C', 'pl-1', { Ref: 'AWS::NoValue' }] },
        })
      ).toEqual([['DestinationCidrBlock', 'DestinationIpv6CidrBlock']]);
    });
  });
});

describe('buildMutuallyExclusiveMessage', () => {
  const [violation] = findMutuallyExclusiveViolations(ROUTE, {
    DestinationCidrBlock: '10.0.0.0/8',
    DestinationIpv6CidrBlock: '::/0',
  });

  it('names the resource, the declared keys, and the rationale', () => {
    const message = buildMutuallyExclusiveMessage('MyRoute', violation!);
    expect(message).toContain('MyRoute');
    expect(message).toContain(ROUTE);
    expect(message).toContain('DestinationCidrBlock and DestinationIpv6CidrBlock');
    expect(message).toContain('exactly one destination per route');
  });

  it('names the key that would reach AWS so the remedy is a safe edit', () => {
    const message = buildMutuallyExclusiveMessage('MyRoute', violation!);
    expect(message).toContain('Only DestinationCidrBlock would reach AWS');
    expect(message).toContain('removing DestinationIpv6CidrBlock');
  });

  it('omits the winner note for a rule that does not declare firstDeclaredWins', () => {
    const message = buildMutuallyExclusiveMessage('R', {
      resourceType: 'AWS::Example::Thing',
      rule: { properties: ['A', 'B'], rationale: 'Pick one.' },
      declared: ['A', 'B'],
      winnerCertain: true,
    });
    expect(message).not.toContain('would reach AWS');
    expect(message).toContain('Declare at most one of: A / B');
  });

  it('omits the winner note when a HIGHER-precedence key is behind an intrinsic', () => {
    // `DestinationCidrBlock` outranks both declared keys and may resolve to a
    // real value, in which case it — not `declared[0]` — is what reaches AWS.
    // Naming a winner here would be a confident falsehood.
    const [uncertain] = findMutuallyExclusiveViolations(ROUTE, {
      DestinationCidrBlock: { 'Fn::If': ['C', '10.0.0.0/8', { Ref: 'AWS::NoValue' }] },
      DestinationIpv6CidrBlock: '::/0',
      DestinationPrefixListId: 'pl-1',
    });
    expect(uncertain!.declared).toEqual(['DestinationIpv6CidrBlock', 'DestinationPrefixListId']);
    expect(uncertain!.winnerCertain).toBe(false);
    const message = buildMutuallyExclusiveMessage('MyRoute', uncertain!);
    expect(message).not.toContain('would reach AWS');
    // The remedy is unaffected — only the winner claim is dropped.
    expect(message).toContain('Declare at most one of');
  });

  it('keeps the winner note when the only skipped higher key is ABSENT, not intrinsic', () => {
    // Absence is settled knowledge, so `declared[0]` really is the winner —
    // this is what stops the fix above from suppressing the note everywhere.
    const [certain] = findMutuallyExclusiveViolations(ROUTE, {
      DestinationIpv6CidrBlock: '::/0',
      DestinationPrefixListId: 'pl-1',
    });
    expect(certain!.winnerCertain).toBe(true);
    expect(buildMutuallyExclusiveMessage('MyRoute', certain!)).toContain(
      'Only DestinationIpv6CidrBlock would reach AWS'
    );
  });
});

describe('MUTUALLY_EXCLUSIVE_PROPERTIES table hygiene', () => {
  const fixturesDir = join(
    fileURLToPath(new URL('.', import.meta.url)),
    '..',
    '..',
    'fixtures',
    'cfn-schemas'
  );

  it('declares at least two distinct properties per rule', () => {
    for (const [resourceType, rules] of MUTUALLY_EXCLUSIVE_PROPERTIES) {
      for (const rule of rules) {
        expect(rule.properties.length, `${resourceType} rule`).toBeGreaterThan(1);
        expect(new Set(rule.properties).size, `${resourceType} rule has duplicates`).toBe(
          rule.properties.length
        );
        expect(rule.rationale.length, `${resourceType} rule rationale`).toBeGreaterThan(0);
      }
    }
  });

  it('matches the provider destination list EXACTLY, order included', () => {
    // The schema-fixture check below catches a RENAME but not a REORDER or an
    // ADDITION in `ROUTE_DESTINATION_KEYS` (ec2-provider.ts, module-private) —
    // either of which silently invalidates `firstDeclaredWins`, since the
    // winner is defined by the provider's `||` chain order. `declared` from
    // `narrowRouteDestinations` over an all-truthy bag IS that list, in that
    // order, so this pins both without needing the constant exported.
    const allTruthy = Object.fromEntries(
      (MUTUALLY_EXCLUSIVE_PROPERTIES.get(ROUTE)![0]!.properties as string[]).map((p) => [p, 'x'])
    );
    expect(narrowRouteDestinations(allTruthy).declared).toEqual(
      MUTUALLY_EXCLUSIVE_PROPERTIES.get(ROUTE)![0]!.properties
    );
  });

  it('names only properties that exist in the type CFn schema fixture', () => {
    // A rule keyed on a misspelled or removed property is DEAD — it can never
    // fire, and nothing else would notice. This is the fence for the fact that
    // the Route key list is duplicated from `ROUTE_DESTINATION_KEYS` in
    // ec2-provider.ts (module-private there).
    for (const [resourceType, rules] of MUTUALLY_EXCLUSIVE_PROPERTIES) {
      const fixture = join(fixturesDir, `${resourceType.replace(/::/g, '-')}.json`);
      if (!existsSync(fixture)) {
        throw new Error(
          `No CFn schema fixture for ${resourceType} (expected ${fixture}). Capture one with ` +
            `\`node scripts/refresh-cfn-schemas.mjs --only-missing\` so this rule's property ` +
            `names stay pinned to the real schema.`
        );
      }
      const schema = JSON.parse(readFileSync(fixture, 'utf8')) as { properties: string[] };
      for (const rule of rules) {
        for (const property of rule.properties) {
          expect(schema.properties, `${resourceType}.${property}`).toContain(property);
        }
      }
    }
  });
});
