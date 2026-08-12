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
  findViolationsForRules,
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

    it('still refuses TWO literals when a LOWER-ranked key is behind an Fn::If', () => {
      // Two unconditional keys are invalid whatever the third resolves to,
      // and the report names only the keys actually proven present.
      const [violation] = findMutuallyExclusiveViolations(ROUTE, {
        DestinationCidrBlock: '10.0.0.0/8',
        DestinationIpv6CidrBlock: '::/0',
        DestinationPrefixListId: { 'Fn::If': ['C', 'pl-1', { Ref: 'AWS::NoValue' }] },
      });
      expect(violation!.declared).toEqual(['DestinationCidrBlock', 'DestinationIpv6CidrBlock']);
      // FENCE for the "higher-precedence ONLY" bound of `winnerCertain`: the
      // intrinsic here ranks BELOW `declared[0]`, so it cannot outrank the
      // winner and the claim stands. Widening the scan to all rule properties
      // would flip this to false — which is otherwise invisible.
      expect(violation!.winnerCertain).toBe(true);
      expect(buildMutuallyExclusiveMessage('R', violation!)).toContain(
        'Only DestinationCidrBlock would reach AWS'
      );
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

  it('renders all THREE keys with the right separators', () => {
    // The 2-key cases cannot distinguish `join(' and ')` from `join(' / ')`
    // in either clause; with three declared keys the separators diverge.
    const [three] = findMutuallyExclusiveViolations(ROUTE, {
      DestinationCidrBlock: '10.0.0.0/8',
      DestinationIpv6CidrBlock: '::/0',
      DestinationPrefixListId: 'pl-1',
    });
    const message = buildMutuallyExclusiveMessage('MyRoute', three!);
    expect(message).toContain(
      'declares DestinationCidrBlock and DestinationIpv6CidrBlock and DestinationPrefixListId'
    );
    expect(message).toContain('removing DestinationIpv6CidrBlock / DestinationPrefixListId');
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

describe('findViolationsForRules (multi-rule paths the shipped table cannot reach)', () => {
  const RULES = [
    { properties: ['A', 'B'], rationale: 'Pick one of A/B.' },
    { properties: ['C', 'D'], rationale: 'Pick one of C/D.' },
  ];

  it('reports ONE violation per violated rule, skipping satisfied ones', () => {
    const violations = findViolationsForRules('AWS::Example::Thing', RULES, {
      A: 1,
      B: 2,
      C: 3, // C alone — rule 2 is satisfied.
    });
    expect(violations.map((v) => v.declared)).toEqual([['A', 'B']]);
  });

  it('reports BOTH rules when both are violated', () => {
    const violations = findViolationsForRules('AWS::Example::Thing', RULES, {
      A: 1,
      B: 2,
      C: 3,
      D: 4,
    });
    expect(violations.map((v) => v.declared)).toEqual([
      ['A', 'B'],
      ['C', 'D'],
    ]);
    expect(violations.every((v) => v.resourceType === 'AWS::Example::Thing')).toBe(true);
  });

  it('continues past a satisfied FIRST rule to reach a violated later one', () => {
    // Pins the `continue` (not `return`) in the rule loop: with an early
    // return, a satisfied rule 1 would hide the violation in rule 2.
    const violations = findViolationsForRules('AWS::Example::Thing', RULES, { A: 1, C: 3, D: 4 });
    expect(violations.map((v) => v.declared)).toEqual([['C', 'D']]);
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

  function loadSchema(resourceType: string): { properties: string[] } {
    const fixture = join(fixturesDir, `${resourceType.replace(/::/g, '-')}.json`);
    if (!existsSync(fixture)) {
      throw new Error(
        `No CFn schema fixture for ${resourceType} (expected ${fixture}). Capture one with ` +
          `\`node scripts/refresh-cfn-schemas.mjs --only-missing\` so this rule's property ` +
          `names stay pinned to the real schema.`
      );
    }
    return JSON.parse(readFileSync(fixture, 'utf8')) as { properties: string[] };
  }

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

  it('matches the provider destination list EXACTLY, order and membership', () => {
    // The schema-fixture check below catches a RENAME but not a REORDER or an
    // ADDITION in `ROUTE_DESTINATION_KEYS` (ec2-provider.ts, module-private) —
    // either of which silently invalidates `firstDeclaredWins`, since the
    // winner is defined by the provider's `||` chain order.
    //
    // The probe bag is seeded from the type's WHOLE CFn schema, NOT from the
    // rule table: seeding from the table cannot detect a provider-side
    // ADDITION, because a 4th destination key would never appear in the bag
    // and `declared` would still equal the table. With every schema property
    // truthy, `narrowRouteDestinations` returns exactly the provider's
    // destination keys in the provider's own order.
    const schema = loadSchema(ROUTE);
    const everyPropertyTruthy = Object.fromEntries(schema.properties.map((p) => [p, 'x']));
    expect(narrowRouteDestinations(everyPropertyTruthy).declared).toEqual(
      MUTUALLY_EXCLUSIVE_PROPERTIES.get(ROUTE)![0]!.properties
    );
  });

  it('names only properties that exist in the type CFn schema fixture', () => {
    // A rule keyed on a misspelled or removed property is DEAD — it can never
    // fire, and nothing else would notice. This is the fence for the fact that
    // the Route key list is duplicated from `ROUTE_DESTINATION_KEYS` in
    // ec2-provider.ts (module-private there).
    for (const [resourceType, rules] of MUTUALLY_EXCLUSIVE_PROPERTIES) {
      const schema = loadSchema(resourceType);
      for (const rule of rules) {
        for (const property of rule.properties) {
          expect(schema.properties, `${resourceType}.${property}`).toContain(property);
        }
      }
    }
  });
});
