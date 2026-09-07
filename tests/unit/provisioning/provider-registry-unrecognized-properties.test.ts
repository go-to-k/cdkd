/**
 * Issue [#2718](https://github.com/go-to-k/cdkd/issues/2718) — the deploy-time
 * warn for a top-level template property cdkd's committed CFn schema snapshot
 * does not know about.
 *
 * The failure class: `ProviderRegistry.getProviderFor` decides SDK-vs-Cloud-
 * Control from `property-coverage.generated.ts`, built offline from
 * `tests/fixtures/cfn-schemas/*.json`, with no runtime `DescribeType` on that
 * path. So a property AWS publishes AFTER the snapshot produces no
 * `silentDrop` entry, does not auto-route to CC, and never reaches AWS while
 * the deploy reports success. The scheduled refresh job is the fix; this warn
 * is what protects a user deploying BETWEEN cycles.
 *
 * The suite is built around the fact that makes the warn safe — an SDK
 * provider writes only what it declares in `handledProperties`, so an
 * unrecognized top-level property is dropped under every reading (a
 * post-snapshot AWS addition, a typo, a read-only attribute, or a deliberate
 * `addPropertyOverride`). Every case below is
 * therefore about the ROUTE (does this resource actually take the SDK path?)
 * rather than about guessing intent, because intent is not decidable here and
 * the code does not try.
 *
 * Fixtures are picked OFF THE REAL generated table rather than hand-written:
 * a hand-written type name silently stops discriminating the day the table
 * changes, which is precisely the staleness class this issue is about.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
} from '../../../src/provisioning/provider-registry.js';
import {
  findUnrecognizedProperties,
  PROPERTY_COVERAGE_BY_TYPE,
} from '../../../src/provisioning/property-coverage.js';

/** A property name no CFn schema will ever carry. */
const UNKNOWN_PROP = 'CdkdTotallyNewPropertyFromTheFuture';

/**
 * A Tier 1 type with at least one silent-drop entry AND at least one handled
 * property, so one type can serve every control in this file.
 */
function pickRoutableFixture(): {
  resourceType: string;
  handledProperty: string;
  silentDropProperty: string;
} {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const drop = cov.silentDrop.entries().next();
    const handled = cov.handled.values().next();
    if (!drop.done && !handled.done) {
      return {
        resourceType,
        handledProperty: handled.value,
        silentDropProperty: drop.value[0],
      };
    }
  }
  throw new Error(
    'No Tier 1 type carries both a handled and a silent-drop property — the ' +
      'generated coverage table changed shape; update this fixture picker.'
  );
}

function makeRegistry() {
  const registry = new ProviderRegistry();
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  (
    registry as unknown as {
      logger: {
        info: typeof info;
        warn: typeof warn;
        debug: typeof debug;
        error: typeof error;
      };
    }
  ).logger = { info, warn, debug, error };
  return { registry, info, warn };
}

/** Every warn line mentioning the unknown property. */
function unknownWarns(warn: ReturnType<typeof vi.fn>): string[] {
  return warn.mock.calls.map((c) => String(c[0])).filter((line) => line.includes(UNKNOWN_PROP));
}

describe('findUnrecognizedProperties (issue #2718)', () => {
  const fx = pickRoutableFixture();

  it('reports a property the type’s schema snapshot does not carry', () => {
    expect(findUnrecognizedProperties(fx.resourceType, { [UNKNOWN_PROP]: 1 })).toEqual([
      UNKNOWN_PROP,
    ]);
  });

  it('does NOT report a handled property (the provider writes it)', () => {
    expect(findUnrecognizedProperties(fx.resourceType, { [fx.handledProperty]: 1 })).toEqual([]);
  });

  it('does NOT report a silent-drop property (the #614 auto-route owns that case)', () => {
    expect(findUnrecognizedProperties(fx.resourceType, { [fx.silentDropProperty]: 1 })).toEqual([]);
  });

  it('returns [] for a type with no coverage record — Cloud Control forwards everything', () => {
    expect(findUnrecognizedProperties('AWS::Definitely::NotATier1Type', { [UNKNOWN_PROP]: 1 })).toEqual(
      []
    );
  });

  it('does NOT report a whole-bag intrinsic — the one false warn it could emit', () => {
    // `Properties: { 'Fn::If': [...] }` is legal CloudFormation (and what
    // `CfnInclude` / a raw `addOverride` can produce). The resolver expands it
    // into real properties later, so calling `Fn::If` "not in the schema"
    // would be a warn about something that is not a property at all.
    expect(
      findUnrecognizedProperties(fx.resourceType, { 'Fn::If': ['C', {}, {}] })
    ).toEqual([]);
    // But a MIXED bag is NOT the intrinsic form: the resolver only treats a
    // single-key object as an intrinsic, so here `Fn::If` stays a literal key
    // the provider drops — the warn is correct, and suppressing it by a bare
    // prefix test would have hidden a real drop.
    expect(
      findUnrecognizedProperties(fx.resourceType, { 'Fn::If': ['C', {}, {}], [UNKNOWN_PROP]: 1 })
    ).toEqual([UNKNOWN_PROP, 'Fn::If']);
  });

  it('returns [] for undefined properties', () => {
    expect(findUnrecognizedProperties(fx.resourceType, undefined)).toEqual([]);
  });

  it('sorts and reports every unrecognized property, not just the first', () => {
    expect(
      findUnrecognizedProperties(fx.resourceType, { ZzzUnknownProp: 1, AaaUnknownProp: 2 })
    ).toEqual(['AaaUnknownProp', 'ZzzUnknownProp']);
  });

  /**
   * The mutation this issue's acceptance clause asks for, at the runtime layer:
   * a property MISSING from the snapshot is exactly a property absent from the
   * baked-in coverage record, and it must be visible rather than silent. The
   * control twin is the assertion above it — the SAME property, present in the
   * record, stays silent — so a helper that reported everything would fail
   * there rather than passing both.
   */
  it('a property present in the record and one absent from it get OPPOSITE verdicts', () => {
    const present = findUnrecognizedProperties(fx.resourceType, {
      [fx.handledProperty]: 1,
    });
    const absent = findUnrecognizedProperties(fx.resourceType, { [UNKNOWN_PROP]: 1 });
    expect(present).toEqual([]);
    expect(absent).toEqual([UNKNOWN_PROP]);
  });
});

describe('ProviderRegistry warns about unrecognized properties on the SDK route (issue #2718)', () => {
  const fx = pickRoutableFixture();

  it('warns, naming the property, the consequence and a remedy', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    const lines = unknownWarns(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MyResource');
    expect(lines[0]).toContain(fx.resourceType);
    // The consequence, which is the whole point of the line.
    expect(lines[0]).toContain('will NOT reach AWS');
    // One reading spot-checked here; the full set has its own case below.
    expect(lines[0]).toContain('misspelled');
    // The 1-click report link and the suppression flag.
    expect(lines[0]).toContain('https://github.com/go-to-k/cdkd/issues/new');
    expect(lines[0]).toContain(`--allow-unsupported-properties ${fx.resourceType}:${UNKNOWN_PROP}`);
  });

  it('stays silent for a handled property', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [fx.handledProperty]: 1 },
      },
    ]);
    expect(unknownWarns(warn)).toEqual([]);
  });

  /**
   * The route control that matters most: when an actionable silent drop routes
   * the resource to Cloud Control, CC forwards the FULL property map, so the
   * unrecognized property DOES reach AWS and a warn would be false.
   */
  it('stays silent when a silent drop auto-routes the resource to Cloud Control', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [fx.silentDropProperty]: 1, [UNKNOWN_PROP]: 1 },
      },
    ]);
    expect(unknownWarns(warn)).toEqual([]);
  });

  it('stays silent for a resource already recorded as provisionedBy: cc-api (sticky route)', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [UNKNOWN_PROP]: 1 },
        provisionedBy: 'cc-api',
      },
    ]);
    expect(unknownWarns(warn)).toEqual([]);
  });

  /**
   * `AWS::Scheduler::Schedule` is in `STICKY_CC_MIGRATION_EXEMPT`, so a
   * cc-api state record re-routes it BACK to its SDK provider — where the drop
   * really happens. Pinning it keeps the warn's route test tied to
   * `getProviderFor`'s actual rule rather than to `provisionedBy` alone.
   */
  it('DOES warn for a sticky-exempt type even when state says cc-api', () => {
    // DERIVED from the exported set, not hardcoded: a hardcoded name goes
    // silently inert the day the set changes, and the guard would then be
    // asserting about a type that is no longer exempt. The floor keeps an
    // emptied set from making this case vacuous.
    expect(
      STICKY_CC_MIGRATION_EXEMPT.size,
      'STICKY_CC_MIGRATION_EXEMPT is empty — this case can no longer discriminate'
    ).toBeGreaterThanOrEqual(1);
    // EVERY member is exercised, not just the first: a `find` would leave a
    // newly added exempt type silently uncovered. And each must be in the
    // Tier 1 table — an exempt type that left it makes this path unreachable,
    // which is the loud failure the earlier hardcoded name gave us for free.
    for (const type of STICKY_CC_MIGRATION_EXEMPT) {
      expect(
        PROPERTY_COVERAGE_BY_TYPE.has(type),
        `${type} is STICKY_CC_MIGRATION_EXEMPT but not in the Tier 1 coverage ` +
          'table, so the sticky-exempt warn path is unreachable for it'
      ).toBe(true);
    }
    for (const exemptType of STICKY_CC_MIGRATION_EXEMPT) {
      const { registry, warn } = makeRegistry();
      registry.validateResourceProperties([
        {
          logicalId: 'MyResource',
          resourceType: exemptType,
          properties: { [UNKNOWN_PROP]: 1 },
          provisionedBy: 'cc-api',
        },
      ]);
      expect(unknownWarns(warn), `no warn for sticky-exempt ${exemptType}`).toHaveLength(1);
    }
  });

  it('is suppressed by --allow-unsupported-properties for that exact key', () => {
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${UNKNOWN_PROP}`]);
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    expect(unknownWarns(warn)).toEqual([]);
  });

  it('is NOT suppressed by an override naming a different property', () => {
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:SomeOtherProperty`]);
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    expect(unknownWarns(warn)).toHaveLength(1);
  });

  it('emits ONE aggregated line per resource, not one per property', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [UNKNOWN_PROP]: 1, [`${UNKNOWN_PROP}Two`]: 2 },
      },
    ]);
    const lines = unknownWarns(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${UNKNOWN_PROP}Two`);
    // Plural agreement, so the line reads correctly in both arities.
    expect(lines[0]).toContain('are not in');
  });


  /**
   * The gap that made `autoRouted: autoRouted.length > 0` mutable to
   * `drops.length > 0` with every test still green. When the ONLY silent drop
   * is allow-listed, the resource stays on the SDK route (that is what the
   * flag means), so an unrecognized property alongside it IS dropped and must
   * warn. Keyed on `drops` instead, the code would read "there were drops, so
   * we auto-routed" and go silent on a real drop.
   */
  it('still warns when the only silent drop is allow-listed (resource stays on SDK)', () => {
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.silentDropProperty}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [fx.silentDropProperty]: 1, [UNKNOWN_PROP]: 1 },
      },
    ]);
    expect(unknownWarns(warn)).toHaveLength(1);
  });

  it('uses singular agreement for one property', () => {
    // Without this, flipping `is`/`are` and `it`/`they` survives every other
    // assertion in the file.
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    const line = unknownWarns(warn)[0]!;
    expect(line).toContain(`${UNKNOWN_PROP} is not in`);
    expect(line).toContain('it will NOT reach AWS');
  });

  it('names all four readings, each with its own remedy', () => {
    // The code cannot tell these apart, so the line must not imply one. The
    // read-only arm matters most: the coverage generator excludes
    // `readOnlyProperties` from `silentDrop`, so a template setting an
    // ATTRIBUTE lands here and "AWS published it after our snapshot" is false.
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    const line = unknownWarns(warn)[0]!;
    expect(line).toContain('misspelled');
    expect(line).toContain('read-only attribute');
    expect(line).toContain("published after cdkd's");
    expect(line).toContain('addPropertyOverride');
  });

  it('links the report URL to the actual property, not a constant', () => {
    // `unsupportedPropertyIssueUrl(type, unrecognized[0]!)` was only fenced by
    // its HOST, so passing any constant survived.
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    expect(unknownWarns(warn)[0]!).toContain(
      encodeURIComponent(`Support property ${fx.resourceType}.${UNKNOWN_PROP}`)
    );
  });

  it('never throws for an unrecognized property — it is a warn, not a rejection', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'MyResource',
          resourceType: fx.resourceType,
          properties: { [UNKNOWN_PROP]: 1 },
        },
      ])
    ).not.toThrow();
  });
});
