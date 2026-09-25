/**
 * Issue [#2718](https://github.com/go-to-k/cdkd/issues/2718) — the deploy-time
 * warn for a top-level template property cdkd's committed CFn schema snapshot
 * does not know about.
 *
 * The failure class: `ProviderRegistry.getProviderFor` decides SDK-vs-Cloud-
 * Control from `property-coverage.generated.ts`, built offline from
 * `tests/fixtures/cfn-schemas/*.json`, with no runtime `DescribeType` on that
 * path. So a property AWS publishes AFTER the snapshot produces no
 * `silentDrop` entry. Issue #3713 routes such a key through Cloud Control;
 * the warn covers what stays on the SDK route (read-only keys, unroutable
 * types, keys unchanged since an SDK-route deploy).
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
  findActionableSilentDrops,
  findRoutableUnrecognizedProperties,
  findUnrecognizedProperties,
  PROPERTY_COVERAGE_BY_TYPE,
  UNRECOGNIZED_PROPERTY_RATIONALE,
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
    // Routable only: an unrecognized key must be able to move the resource.
    if (cov.ccRouteUnavailable) continue;
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
  return { registry, info, warn, debug };
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
    // A MIXED bag too: `resolveValue` dispatches on `'Fn::If' in obj`, so the
    // whole bag is still resolved as an intrinsic. An earlier revision used a
    // SOLE-KEY rule here on the belief that the resolver did — it does not
    // (that rule governs only UNKNOWN intrinsic keys), so this case pins the
    // corrected behaviour: the intrinsic key is never reported, the real
    // unknown beside it still is.
    expect(
      findUnrecognizedProperties(fx.resourceType, { 'Fn::If': ['C', {}, {}], [UNKNOWN_PROP]: 1 })
    ).toEqual([UNKNOWN_PROP]);
    // `Ref` sits in the same position and takes the same path.
    expect(findUnrecognizedProperties(fx.resourceType, { Ref: 'X' })).toEqual([]);
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

/** A routable Tier 1 type with a read-only property in its schema snapshot. */
function pickReadOnlyFixture(): { resourceType: string; readOnlyProperty: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.ccRouteUnavailable) continue;
    const ro = [...cov.readOnly].find((p) => !cov.handled.has(p) && !cov.silentDrop.has(p));
    if (ro !== undefined) return { resourceType, readOnlyProperty: ro };
  }
  throw new Error('No routable Tier 1 type declares a read-only property — update this picker.');
}

/** A Tier 1 type whose SDK provider declares `disableCcApiFallback`. */
function pickUnroutableType(): string {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.ccRouteUnavailable) return resourceType;
  }
  throw new Error('No Tier 1 type is ccRouteUnavailable — update this picker.');
}

describe('findRoutableUnrecognizedProperties (issue #3713)', () => {
  const fx = pickRoutableFixture();
  const none = new Set<string>();

  it('routes an unknown key on a new resource (no record)', () => {
    expect(findRoutableUnrecognizedProperties(fx.resourceType, { [UNKNOWN_PROP]: 1 }, none)).toEqual(
      [UNKNOWN_PROP]
    );
  });

  it('routes an unknown key ADDED to, or CHANGED against, the record', () => {
    const props = { [UNKNOWN_PROP]: { a: 1 } };
    expect(findRoutableUnrecognizedProperties(fx.resourceType, props, none, {})).toEqual([
      UNKNOWN_PROP,
    ]);
    expect(
      findRoutableUnrecognizedProperties(fx.resourceType, props, none, { [UNKNOWN_PROP]: { a: 2 } })
    ).toEqual([UNKNOWN_PROP]);
  });

  it('does NOT route an unknown key the record holds with a deep-equal value', () => {
    // Key order differs on purpose: the baseline is a structural comparison.
    expect(
      findRoutableUnrecognizedProperties(
        fx.resourceType,
        { [UNKNOWN_PROP]: { a: 1, b: [1, 2] } },
        none,
        { [UNKNOWN_PROP]: { b: [1, 2], a: 1 } }
      )
    ).toEqual([]);
  });

  it('does NOT route a read-only key — CloudFormation ignores one', () => {
    const ro = pickReadOnlyFixture();
    expect(
      findRoutableUnrecognizedProperties(ro.resourceType, { [ro.readOnlyProperty]: 'x' }, none)
    ).toEqual([]);
    // Control: the same type still routes a genuinely unknown key.
    expect(
      findRoutableUnrecognizedProperties(ro.resourceType, { [UNKNOWN_PROP]: 'x' }, none)
    ).toEqual([UNKNOWN_PROP]);
  });

  it('does NOT route on a type Cloud Control cannot take over', () => {
    expect(
      findRoutableUnrecognizedProperties(pickUnroutableType(), { [UNKNOWN_PROP]: 1 }, none)
    ).toEqual([]);
  });

  it('does NOT route an allow-listed key, an intrinsic key, or on a non-Tier-1 type', () => {
    expect(
      findRoutableUnrecognizedProperties(
        fx.resourceType,
        { [UNKNOWN_PROP]: 1 },
        new Set([`${fx.resourceType}:${UNKNOWN_PROP}`])
      )
    ).toEqual([]);
    expect(
      findRoutableUnrecognizedProperties(fx.resourceType, { 'Fn::If': ['C', {}, {}] }, none)
    ).toEqual([]);
    expect(
      findRoutableUnrecognizedProperties('AWS::Definitely::NotATier1Type', { [UNKNOWN_PROP]: 1 }, none)
    ).toEqual([]);
  });

  it('joins findActionableSilentDrops with its own rationale, sorted with the drops', () => {
    expect(
      findActionableSilentDrops(
        fx.resourceType,
        { [fx.silentDropProperty]: 1, [UNKNOWN_PROP]: 1 },
        none
      ).map((d) => d.property)
    ).toEqual([fx.silentDropProperty, UNKNOWN_PROP].sort((a, b) => a.localeCompare(b)));
    expect(
      findActionableSilentDrops(fx.resourceType, { [UNKNOWN_PROP]: 1 }, none)[0]?.rationale
    ).toBe(UNRECOGNIZED_PROPERTY_RATIONALE);
  });
});

describe('ProviderRegistry routes an unrecognized property via Cloud Control (issue #3713)', () => {
  const fx = pickRoutableFixture();

  /** A registry with a stub SDK provider registered for `resourceType`. */
  function registryWithSdk(resourceType: string) {
    const made = makeRegistry();
    made.registry.register(resourceType, {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    } as never);
    return made;
  }

  it('auto-routes a new resource carrying one, naming it in the plan reason', () => {
    const { registry } = registryWithSdk(fx.resourceType);
    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: { [UNKNOWN_PROP]: 1 },
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.ccRouteReason).toEqual({ properties: [UNKNOWN_PROP] });
  });

  it('keeps an existing SDK resource on the SDK route while the key is unchanged', () => {
    const { registry } = registryWithSdk(fx.resourceType);
    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: { [UNKNOWN_PROP]: 1 },
      provisionedBy: 'sdk',
      previousProperties: { [UNKNOWN_PROP]: 1 },
    });
    expect(decision.provisionedBy).toBe('sdk');
  });

  it('routes an existing SDK resource once the key changes', () => {
    const { registry } = registryWithSdk(fx.resourceType);
    const decision = registry.getProviderFor({
      resourceType: fx.resourceType,
      properties: { [UNKNOWN_PROP]: 2 },
      provisionedBy: 'sdk',
      previousProperties: { [UNKNOWN_PROP]: 1 },
    });
    expect(decision.provisionedBy).toBe('cc-api');
  });

  it('keeps a read-only key and an unroutable type on the SDK route, without throwing', () => {
    const ro = pickReadOnlyFixture();
    const a = registryWithSdk(ro.resourceType);
    expect(
      a.registry.getProviderFor({
        resourceType: ro.resourceType,
        properties: { [ro.readOnlyProperty]: 'x' },
      }).provisionedBy
    ).toBe('sdk');
    const unroutable = pickUnroutableType();
    const b = registryWithSdk(unroutable);
    expect(
      b.registry.getProviderFor({ resourceType: unroutable, properties: { [UNKNOWN_PROP]: 1 } })
        .provisionedBy
    ).toBe('sdk');
  });

  it('logs the route at info and names the key as unrecognized, with no drop warn', () => {
    const { registry, info, warn } = makeRegistry();
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    const lines = info.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('routing via Cloud Control API');
    expect(lines[0]).toContain(`${UNKNOWN_PROP} is not in cdkd's CFn schema snapshot`);
    expect(lines[0]).toContain(`--prefer-sdk-route ${fx.resourceType}:${UNKNOWN_PROP}`);
    expect(unknownWarns(warn)).toEqual([]);
  });

  it('still routes when an override names a different property', () => {
    const { registry, info, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:SomeOtherProperty`]);
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    expect(info.mock.calls.map((c) => String(c[0])).join('\n')).toContain(UNKNOWN_PROP);
    expect(unknownWarns(warn)).toEqual([]);
  });

  /**
   * `AWS::Scheduler::Schedule`-style `'cc-broken'` exemptions return a
   * `cc-api` record to the SDK provider, so the resource's route is re-derived
   * from the bag — and an unrecognized key then routes it, as a silent drop
   * does, rather than being dropped on the SDK route.
   */
  it('routes a cc-broken sticky-exempt type carrying one, rather than warning', () => {
    const ccBrokenTypes = [...STICKY_CC_MIGRATION_EXEMPT]
      .filter(([, entry]) => entry.mode === 'cc-broken')
      .map(([type]) => type);
    expect(ccBrokenTypes.length).toBeGreaterThanOrEqual(1);
    for (const exemptType of ccBrokenTypes) {
      expect(PROPERTY_COVERAGE_BY_TYPE.get(exemptType)?.ccRouteUnavailable).toBe(false);
      const { registry, debug, warn } = makeRegistry();
      registry.validateResourceProperties([
        {
          logicalId: 'MyResource',
          resourceType: exemptType,
          properties: { [UNKNOWN_PROP]: 1 },
          provisionedBy: 'cc-api',
        },
      ]);
      expect(unknownWarns(warn), exemptType).toEqual([]);
      // A `cc-api` record demotes the route line to debug (sticky continuation).
      expect(debug.mock.calls.map((c) => String(c[0])).join('\n'), exemptType).toContain(
        UNKNOWN_PROP
      );
    }
  });
});

describe('ProviderRegistry warns about unrecognized properties left on the SDK route (issues #2718, #3713)', () => {
  const fx = pickRoutableFixture();

  it('warns for an UNCHANGED key on an existing resource, naming why it stays', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [UNKNOWN_PROP]: 1 },
        provisionedBy: 'sdk',
        previousProperties: { [UNKNOWN_PROP]: 1 },
      },
    ]);
    const lines = unknownWarns(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('MyResource');
    expect(lines[0]).toContain(fx.resourceType);
    expect(lines[0]).toContain('will NOT reach AWS');
    expect(lines[0]).toContain(`${UNKNOWN_PROP} is not in cdkd's CFn schema snapshot and unchanged`);
    expect(lines[0]).toContain('the value has never reached AWS');
    expect(lines[0]).toContain('rejects a misspelled one');
    expect(lines[0]).toContain(`--prefer-sdk-route ${fx.resourceType}:${UNKNOWN_PROP}`);
  });

  it('warns for a READ-ONLY key, naming it as an attribute', () => {
    const ro = pickReadOnlyFixture();
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: ro.resourceType,
        properties: { [ro.readOnlyProperty]: 'x' },
      },
    ]);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${ro.readOnlyProperty} is read-only`);
    expect(lines[0]).toContain('CloudFormation ignores it too');
    expect(lines[0]).not.toContain('never reached AWS');
  });

  it('warns on a type Cloud Control cannot take, with the report link for that property', () => {
    const unroutable = pickUnroutableType();
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: unroutable, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    const lines = unknownWarns(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cannot be routed via Cloud Control API');
    expect(lines[0]).toContain(encodeURIComponent(`Support property ${unroutable}.${UNKNOWN_PROP}`));
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

  it('stays silent when a silent drop auto-routes the resource to Cloud Control', () => {
    const { registry, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [fx.silentDropProperty]: 1, [UNKNOWN_PROP]: 1 },
        provisionedBy: 'sdk',
        previousProperties: { [UNKNOWN_PROP]: 1 },
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
        previousProperties: { [UNKNOWN_PROP]: 1 },
      },
    ]);
    expect(unknownWarns(warn)).toEqual([]);
  });

  it('is suppressed by --prefer-sdk-route for that exact key', () => {
    const { registry, warn, info } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${UNKNOWN_PROP}`]);
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    expect(unknownWarns(warn)).toEqual([]);
    // And the allow-listed key does not route either.
    expect(info).not.toHaveBeenCalled();
  });

  it('emits ONE aggregated line per resource, with plural agreement', () => {
    const { registry, warn } = makeRegistry();
    const bag = { [UNKNOWN_PROP]: 1, [`${UNKNOWN_PROP}Two`]: 2 };
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: bag,
        provisionedBy: 'sdk',
        previousProperties: bag,
      },
    ]);
    const lines = unknownWarns(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`${UNKNOWN_PROP}Two`);
    expect(lines[0]).toContain('are not in');
    expect(lines[0]).toContain('the values have never reached AWS');
  });

  it('still warns when the only silent drop is allow-listed and the key is unchanged', () => {
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.silentDropProperty}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [fx.silentDropProperty]: 1, [UNKNOWN_PROP]: 1 },
        provisionedBy: 'sdk',
        previousProperties: { [UNKNOWN_PROP]: 1 },
      },
    ]);
    expect(unknownWarns(warn)).toHaveLength(1);
  });

  it('never throws for an unrecognized property on any route', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        { logicalId: 'A', resourceType: fx.resourceType, properties: { [UNKNOWN_PROP]: 1 } },
        { logicalId: 'B', resourceType: pickUnroutableType(), properties: { [UNKNOWN_PROP]: 1 } },
      ])
    ).not.toThrow();
  });
});

describe('the baseline comparison (issue #3713)', () => {
  const fx = pickRoutableFixture();
  const none = new Set<string>();

  it('ignores a prototype difference — a null-prototype desired bag is still unchanged', () => {
    const desiredValue = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    expect(
      findRoutableUnrecognizedProperties(
        fx.resourceType,
        { [UNKNOWN_PROP]: desiredValue },
        none,
        { [UNKNOWN_PROP]: { a: 1 } }
      )
    ).toEqual([]);
  });

  it('treats a recorded dynamic-reference secret as unchanged, since it cannot be compared', () => {
    const recorded = { [UNKNOWN_PROP]: 'prefix-{{resolve:secretsmanager:s:SecretString:k}}' };
    expect(
      findRoutableUnrecognizedProperties(
        fx.resourceType,
        { [UNKNOWN_PROP]: 'prefix-the-resolved-secret' },
        none,
        recorded
      )
    ).toEqual([]);
    // Control: without the expression, the same difference routes.
    expect(
      findRoutableUnrecognizedProperties(
        fx.resourceType,
        { [UNKNOWN_PROP]: 'prefix-the-resolved-secret' },
        none,
        { [UNKNOWN_PROP]: 'prefix-other' }
      )
    ).toEqual([UNKNOWN_PROP]);
  });
});
