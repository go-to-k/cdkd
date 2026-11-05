/**
 * Deploy-time property-coverage runtime helpers (PR5).
 *
 * Distinct from `property-coverage.test.ts` (the offline / Issue #391 test
 * layer that enforces every provider declares `handledProperties` /
 * `unhandledByDesign` consistently with the CFn schema fixture). This file
 * exercises the runtime helpers:
 *   - `getPropertyCoverage` (lookup)
 *   - `findSdkUnwiredProperties` (per-resource SDK-unwired detection)
 *   - `findActionableSdkUnwired` (SDK-unwired properties minus the override allow-set)
 *   - `findAcceptedSdkUnwired` / `withoutSdkUnwiredProperties` /
 *     `withoutAcceptedSdkUnwiredProperties` (the #2750 record- and diff-side
 *     narrowings: what the SDK route actually writes)
 *   - `withoutUnwrittenSdkUnwiredProperties` / `findUnwrittenCreateOnlyDrops`
 *     (go-to-k/cdkd#2790: the record's COMPARISON side, and the create-only
 *     drops a flag-less deploy cannot apply without a replacement)
 *   - `unsupportedPropertyIssueUrl` (1-click GitHub issue link)
 *
 * The throw-based `ProviderRegistry.validateResourceProperties` tests were
 * removed when #614 reversed the SDK-unwired policy: the method now
 * auto-routes via Cloud Control API + info-logs instead of throwing. The
 * info-/warn-log shape is covered by
 * `provider-registry-report-sdk-unwired.test.ts`; the routing decisions
 * are covered by `provider-registry-cc-routing.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  PROPERTY_COVERAGE_BY_TYPE,
  findAcceptedSdkUnwired,
  findActionableSdkUnwired,
  findSdkUnwiredProperties,
  getPropertyCoverage,
  unsupportedPropertyIssueUrl,
  findUnwrittenCreateOnlyDrops,
  withoutAcceptedSdkUnwiredProperties,
  withoutSdkUnwiredProperties,
  withoutUnwrittenSdkUnwiredProperties,
} from '../../../src/provisioning/property-coverage.js';

describe('getPropertyCoverage', () => {
  it('returns a record for a Tier 1 SDK-provider type', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    expect(cov).toBeDefined();
    expect(cov!.handled.size).toBeGreaterThan(0);
  });

  it('returns undefined for an unknown type', () => {
    expect(getPropertyCoverage('AWS::Made::Up')).toBeUndefined();
  });

  it('returns undefined for a Custom:: type (no SDK-provider write-side drop)', () => {
    expect(getPropertyCoverage('Custom::Foo')).toBeUndefined();
  });
});

describe('findSdkUnwiredProperties', () => {
  it('returns [] when the resource type has no coverage record (Tier 2 / Custom / unknown)', () => {
    expect(findSdkUnwiredProperties('AWS::Made::Up', { Foo: 'bar' })).toEqual([]);
  });

  it('returns [] when properties is undefined or empty', () => {
    expect(findSdkUnwiredProperties('AWS::Lambda::Function', undefined)).toEqual([]);
    expect(findSdkUnwiredProperties('AWS::Lambda::Function', {})).toEqual([]);
  });

  it('returns [] when every property is handled', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const handledKey = Array.from(cov.handled)[0];
    if (!handledKey) throw new Error('Lambda Function should declare at least one handled property');
    expect(
      findSdkUnwiredProperties('AWS::Lambda::Function', { [handledKey]: 'x' })
    ).toEqual([]);
  });

  it('flags an SDK-unwired property with its rationale', () => {
    const cov = getPropertyCoverage('AWS::RDS::DBCluster');
    if (!cov) throw new Error('AWS::RDS::DBCluster should have a coverage record');
    const dropKey = Array.from(cov.sdkUnwired.keys())[0];
    if (!dropKey) throw new Error('AWS::RDS::DBCluster should declare an SDK-unwired property');
    const drops = findSdkUnwiredProperties('AWS::RDS::DBCluster', { [dropKey]: 'x' });
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual({
      property: dropKey,
      rationale: cov.sdkUnwired.get(dropKey),
    });
  });

  it('passes through properties NOT in the CFn schema (escape hatch / typo tolerance)', () => {
    expect(
      findSdkUnwiredProperties('AWS::Lambda::Function', {
        SomeFakeUnknownProperty: 'x',
      })
    ).toEqual([]);
  });

  it('sorts results alphabetically by property name', () => {
    const cov = getPropertyCoverage('AWS::RDS::DBCluster');
    if (!cov) throw new Error('AWS::RDS::DBCluster should have a coverage record');
    if (cov.sdkUnwired.size < 2) {
      throw new Error('AWS::RDS::DBCluster should declare ≥2 SDK-unwired properties');
    }
    const keys = Array.from(cov.sdkUnwired.keys());
    const reversed = [...keys].reverse();
    const props = Object.fromEntries(reversed.map((k) => [k, 'x']));
    const drops = findSdkUnwiredProperties('AWS::RDS::DBCluster', props);
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    expect(drops.map((d) => d.property)).toEqual(sortedKeys);
  });
});

describe('unsupportedPropertyIssueUrl', () => {
  it('URL-encodes the resource type + property in the title', () => {
    const url = unsupportedPropertyIssueUrl('AWS::Lambda::Function', 'LoggingConfig');
    expect(url).toContain('github.com/go-to-k/cdkd/issues/new');
    expect(url).toContain('labels=resource-support');
    expect(url).toContain('AWS%3A%3ALambda%3A%3AFunction.LoggingConfig');
  });
});

describe('PROPERTY_COVERAGE_BY_TYPE shape', () => {
  it('contains at least one Tier 1 SDK-provider type', () => {
    expect(PROPERTY_COVERAGE_BY_TYPE.size).toBeGreaterThan(0);
  });
});

/**
 * Find a (type, property, rationale) triple from the generated coverage map
 * so the tests below stay declarative against whichever SDK-unwired type the
 * generator surfaces today. Throws if every Tier 1 type is fully handled —
 * at that point the runtime reject path has no exercise input and these
 * tests would silently no-op, masking regressions. Today the generated map
 * carries 469 SDK-unwired entries, so this is far from triggering; the
 * throw exists so the tests fail loudly when (eventually) every gap is
 * closed and a different test shape is required.
 */
function pickSdkUnwiredFixture(): {
  resourceType: string;
  property: string;
  rationale: string;
} {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const first = cov.sdkUnwired.entries().next();
    if (!first.done) {
      const [property, rationale] = first.value;
      return { resourceType, property, rationale };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no SDK-unwired entries — every Tier 1 ' +
      'type is fully handled. Update these tests to exercise the reject path ' +
      'against a synthetic fixture instead of the generated map.'
  );
}

/**
 * Find a (type, propA, propB) triple where the type has ≥2 SDK-unwired
 * entries — used by tests that need to verify per-property granularity.
 * Throws (rather than silently skipping) so a regression in the generated
 * map fails the suite loudly. Today many Tier 1 types satisfy this (e.g.
 * AWS::Lambda::Function has 15 SDK-unwired entries), so the throw is the
 * safe default.
 */
function pickSdkUnwiredPair(): { resourceType: string; propA: string; propB: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.sdkUnwired.size >= 2) {
      const sorted = Array.from(cov.sdkUnwired.keys()).sort((x, y) => x.localeCompare(y));
      return { resourceType, propA: sorted[0]!, propB: sorted[1]! };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no type with ≥2 SDK-unwired entries — ' +
      'these tests assume at least one type with multiple gaps. Update them ' +
      'to use a synthetic fixture instead of the generated map.'
  );
}

describe('findActionableSdkUnwired (#614)', () => {
  it('returns the full set when allowedKeys is empty', () => {
    const fx = pickSdkUnwiredFixture();
    const drops = findActionableSdkUnwired(
      fx.resourceType,
      { [fx.property]: 'x' },
      new Set()
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]?.property).toBe(fx.property);
  });

  it('filters out drops whose <Type>:<Prop> key is in allowedKeys', () => {
    const fx = pickSdkUnwiredFixture();
    const drops = findActionableSdkUnwired(
      fx.resourceType,
      { [fx.property]: 'x' },
      new Set([`${fx.resourceType}:${fx.property}`])
    );
    expect(drops).toEqual([]);
  });

  it('only filters by the exact <Type>:<Prop> token — siblings remain', () => {
    const pair = pickSdkUnwiredPair();
    const drops = findActionableSdkUnwired(
      pair.resourceType,
      { [pair.propA]: 'x', [pair.propB]: 'y' },
      new Set([`${pair.resourceType}:${pair.propA}`])
    );
    expect(drops.map((d) => d.property)).toEqual([pair.propB]);
  });

  it('preserves alphabetical sort from findSdkUnwiredProperties', () => {
    const pair = pickSdkUnwiredPair();
    const drops = findActionableSdkUnwired(
      pair.resourceType,
      { [pair.propB]: 'x', [pair.propA]: 'y' },
      new Set()
    );
    expect(drops.map((d) => d.property)).toEqual([pair.propA, pair.propB]);
  });
});

describe('findAcceptedSdkUnwired (#2750)', () => {
  it('returns [] when nothing is allow-listed — the resource auto-routes to CC', () => {
    const fx = pickSdkUnwiredFixture();
    expect(findAcceptedSdkUnwired(fx.resourceType, { [fx.property]: 'x' }, new Set())).toEqual([]);
  });

  it('names the drop the user opted into when it is the only one', () => {
    const fx = pickSdkUnwiredFixture();
    expect(
      findAcceptedSdkUnwired(
        fx.resourceType,
        { [fx.property]: 'x' },
        new Set([`${fx.resourceType}:${fx.property}`])
      )
    ).toEqual([fx.property]);
  });

  /**
   * The load-bearing case, and the one a per-property reading gets wrong: the
   * allow set is per `<Type>:<Prop>` while the ROUTE is per resource. One
   * un-allowed drop sends the whole resource through Cloud Control, which
   * forwards the full property map — so the allow-listed sibling reaches AWS
   * after all and must NOT be treated as dropped.
   */
  it('returns [] for a MIXED bag — one un-allowed drop routes the whole resource to CC', () => {
    const pair = pickSdkUnwiredPair();
    expect(
      findAcceptedSdkUnwired(
        pair.resourceType,
        { [pair.propA]: 'x', [pair.propB]: 'y' },
        new Set([`${pair.resourceType}:${pair.propA}`])
      )
    ).toEqual([]);
  });

  it('names both when both are allow-listed', () => {
    const pair = pickSdkUnwiredPair();
    expect(
      findAcceptedSdkUnwired(
        pair.resourceType,
        { [pair.propA]: 'x', [pair.propB]: 'y' },
        new Set([`${pair.resourceType}:${pair.propA}`, `${pair.resourceType}:${pair.propB}`])
      )
    ).toEqual([pair.propA, pair.propB]);
  });

  it('is the complement of findActionableSdkUnwired on every allow-set shape', () => {
    const pair = pickSdkUnwiredPair();
    const props = { [pair.propA]: 'x', [pair.propB]: 'y' };
    const bothAllowed = new Set([
      `${pair.resourceType}:${pair.propA}`,
      `${pair.resourceType}:${pair.propB}`,
    ]);
    for (const allowed of [new Set<string>(), new Set([`${pair.resourceType}:${pair.propA}`]), bothAllowed]) {
      const actionable = findActionableSdkUnwired(pair.resourceType, props, allowed);
      const accepted = findAcceptedSdkUnwired(pair.resourceType, props, allowed);
      // Exactly one of the two is non-empty: a bag with drops either takes the
      // SDK route (everything accepted) or the CC route (nothing accepted).
      expect(actionable.length === 0 || accepted.length === 0).toBe(true);
    }
  });
});

/**
 * The same, restricted to a drop that is NOT create-only. The two `without*`
 * helpers deliberately KEEP a create-only drop (#2750), so
 * a case asserting removal must not be handed one — `pickSdkUnwiredFixture`'s
 * first entry happens to be `AWS::ApiGateway::Deployment.DeploymentCanarySettings`,
 * which is exactly that.
 */
function pickPlainSdkUnwiredFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    for (const property of cov.sdkUnwired.keys()) {
      if (!cov.createOnlyDrops.has(property)) return { resourceType, property };
    }
  }
  throw new Error('every SDK-unwired property is create-only — use a synthetic fixture');
}

/** A type with two SDK-unwired properties, NEITHER of them create-only. */
function pickPlainSdkUnwiredPair(): { resourceType: string; propA: string; propB: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const plain = [...cov.sdkUnwired.keys()]
      .filter((k) => !cov.createOnlyDrops.has(k))
      .sort((a, b) => a.localeCompare(b));
    if (plain.length >= 2) return { resourceType, propA: plain[0]!, propB: plain[1]! };
  }
  throw new Error('no type has two non-create-only SDK-unwired properties — use a synthetic fixture');
}

/**
 * A (type, property) pair whose SDK-unwired property is ALSO create-only, and whose type
 * has at least one drop that is NOT — so the exclusion and its control can be
 * driven off the same type. Throws rather than skipping: with no such pair the
 * cases below would pass having exercised nothing, which is exactly how the
 * first cut of this fence family shipped vacuous.
 */
function pickCreateOnlyDropFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.createOnlyDrops.size === 0) continue;
    if (cov.sdkUnwired.size <= cov.createOnlyDrops.size) continue;
    const property = [...cov.createOnlyDrops].sort((a, b) => a.localeCompare(b))[0]!;
    return { resourceType, property };
  }
  throw new Error(
    'No type has both a create-only SDK-unwired property and a plain one — the #2750 ' +
      'create-only exclusion cannot be exercised against the generated map. ' +
      'Use a synthetic fixture instead.'
  );
}

describe('withoutSdkUnwiredProperties (#2750, the RECORD side)', () => {
  it('removes every SDK-unwired key regardless of any allow set', () => {
    const pair = pickPlainSdkUnwiredPair();
    const written = withoutSdkUnwiredProperties(pair.resourceType, {
      [pair.propA]: 'x',
      [pair.propB]: 'y',
      SomeFakeUnknownProperty: 'kept',
    });
    expect(written).toEqual({ SomeFakeUnknownProperty: 'kept' });
  });

  it('returns the SAME object when the type has no coverage record', () => {
    const props = { Foo: 'bar' };
    expect(withoutSdkUnwiredProperties('AWS::Made::Up', props)).toBe(props);
  });

  it('returns the SAME object when the bag carries no SDK-unwired property', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const handledKey = Array.from(cov.handled)[0]!;
    const props = { [handledKey]: 'x' };
    expect(withoutSdkUnwiredProperties('AWS::Lambda::Function', props)).toBe(props);
  });

  it('does not mutate the input bag', () => {
    const fx = pickPlainSdkUnwiredFixture();
    const props = { [fx.property]: 'x' };
    withoutSdkUnwiredProperties(fx.resourceType, props);
    expect(props).toEqual({ [fx.property]: 'x' });
  });

  /**
   * The one exclusion, and it is what stops the WRITTEN record being
   * destructive: removing a CREATE-ONLY drop makes it read as an ADDITION on
   * the next flag-ful deploy, which classifies as a REPLACEMENT of a resource
   * nobody touched. The COMPARISON side decides per deploy instead
   * (`withoutUnwrittenSdkUnwiredProperties`, go-to-k/cdkd#2790).
   */
  it('KEEPS a create-only SDK-unwired property', () => {
    const fx = pickCreateOnlyDropFixture();
    const props = { [fx.property]: 'x' };
    expect(withoutSdkUnwiredProperties(fx.resourceType, props)).toBe(props);
  });

  it('still removes a NON-create-only drop on the same type', () => {
    // The control: without it the row above passes under an implementation
    // that stopped narrowing altogether.
    const fx = pickCreateOnlyDropFixture();
    const plain = [...PROPERTY_COVERAGE_BY_TYPE.get(fx.resourceType)!.sdkUnwired.keys()].find(
      (p) => !PROPERTY_COVERAGE_BY_TYPE.get(fx.resourceType)!.createOnlyDrops.has(p)
    );
    if (plain === undefined) {
      throw new Error(
        `${fx.resourceType} has only create-only SDK-unwired properties — pick a type with both, ` +
          'or this control asserts nothing.'
      );
    }
    expect(
      withoutSdkUnwiredProperties(fx.resourceType, { [fx.property]: 'x', [plain]: 'y' })
    ).toEqual({ [fx.property]: 'x' });
  });
});

describe('withoutAcceptedSdkUnwiredProperties (#2750, the DESIRED side)', () => {
  it('removes the opted-into drop', () => {
    const fx = pickPlainSdkUnwiredFixture();
    expect(
      withoutAcceptedSdkUnwiredProperties(
        fx.resourceType,
        { [fx.property]: 'x', SomeFakeUnknownProperty: 'kept' },
        new Set([`${fx.resourceType}:${fx.property}`]),
        // Recorded unchanged, so the unknown key does not route (#3713).
        { SomeFakeUnknownProperty: 'kept' }
      )
    ).toEqual({ SomeFakeUnknownProperty: 'kept' });
  });

  /**
   * Issue #3713: an unrecognized key absent from the record routes the
   * resource through Cloud Control, which writes the accepted drop too — so
   * narrowing it would hide a real difference, exactly like an un-allowed drop.
   */
  it('keeps the opted-into drop when an unrecognized key routes the resource', () => {
    const fx = pickPlainSdkUnwiredFixture();
    const props = { [fx.property]: 'x', SomeFakeUnknownProperty: 'new' };
    const allow = new Set([`${fx.resourceType}:${fx.property}`]);
    expect(withoutAcceptedSdkUnwiredProperties(fx.resourceType, props, allow)).toBe(props);
    expect(
      withoutAcceptedSdkUnwiredProperties(fx.resourceType, props, allow, {
        SomeFakeUnknownProperty: 'old',
      })
    ).toBe(props);
  });

  /**
   * The discriminator against the record-side helper: with no flag the drop
   * auto-routes the resource through Cloud Control, which DOES write the
   * property, so narrowing it here would hide a real difference.
   */
  it('keeps a drop the user did NOT opt into', () => {
    const fx = pickPlainSdkUnwiredFixture();
    const props = { [fx.property]: 'x' };
    expect(withoutAcceptedSdkUnwiredProperties(fx.resourceType, props, new Set())).toBe(props);
  });

  it('keeps BOTH drops of a mixed bag — the resource takes the CC route', () => {
    const pair = pickPlainSdkUnwiredPair();
    const props = { [pair.propA]: 'x', [pair.propB]: 'y' };
    expect(
      withoutAcceptedSdkUnwiredProperties(
        pair.resourceType,
        props,
        new Set([`${pair.resourceType}:${pair.propA}`])
      )
    ).toBe(props);
  });

  it('does not mutate the input bag', () => {
    const fx = pickPlainSdkUnwiredFixture();
    const props = { [fx.property]: 'x' };
    withoutAcceptedSdkUnwiredProperties(
      fx.resourceType,
      props,
      new Set([`${fx.resourceType}:${fx.property}`])
    );
    expect(props).toEqual({ [fx.property]: 'x' });
  });

  it('KEEPS a create-only drop even when it is opted into', () => {
    // The desired side's half of the same exclusion: narrowing only one side
    // is what manufactures the difference, so both must decline together.
    const fx = pickCreateOnlyDropFixture();
    const props = { [fx.property]: 'x' };
    expect(
      withoutAcceptedSdkUnwiredProperties(
        fx.resourceType,
        props,
        new Set([`${fx.resourceType}:${fx.property}`])
      )
    ).toBe(props);
  });
});

describe('unrecognized keys and the narrowings (issue #3713)', () => {
  const UNKNOWN = 'CdkdTotallyNewPropertyFromTheFuture';

  /**
   * The record-side narrowing stays FIXTURE-ONLY. Removing an unrecognized key
   * from an SDK record would make it read as an ADDITION next deploy — and its
   * create-only status is unknown offline, so that could classify as a
   * REPLACEMENT of a resource nobody touched. It also erases the baseline the
   * route compares against.
   */
  it('withoutSdkUnwiredProperties KEEPS an unrecognized key', () => {
    const fx = pickPlainSdkUnwiredFixture();
    const props = { [fx.property]: 'x', [UNKNOWN]: 'kept' };
    expect(withoutSdkUnwiredProperties(fx.resourceType, props)).toEqual({ [UNKNOWN]: 'kept' });
  });

  it('actionable and accepted stay complements over a mixed bag with an unrecognized key', () => {
    const fx = pickPlainSdkUnwiredFixture();
    const allow = new Set([`${fx.resourceType}:${fx.property}`]);
    const bag = { [fx.property]: 'x', [UNKNOWN]: 'v' };
    // Routes (unknown key absent from the record): actionable non-empty, accepted empty.
    expect(findActionableSdkUnwired(fx.resourceType, bag, allow, {}).map((d) => d.property)).toEqual(
      [UNKNOWN]
    );
    expect(findAcceptedSdkUnwired(fx.resourceType, bag, allow, {})).toEqual([]);
    // Stays (recorded unchanged): actionable empty, accepted = the allowed drop.
    expect(findActionableSdkUnwired(fx.resourceType, bag, allow, { [UNKNOWN]: 'v' })).toEqual([]);
    expect(findAcceptedSdkUnwired(fx.resourceType, bag, allow, { [UNKNOWN]: 'v' })).toEqual([
      fx.property,
    ]);
  });
});

/**
 * go-to-k/cdkd#2790. `AWS::EC2::Subnet` is the pair
 * `tests/integration/sdk-to-cc-autoroute/` deploys: `AvailabilityZoneId` is a
 * CREATE-ONLY SDK-unwired property. The unit cases pair it with the still-unwired
 * `AssignIpv6AddressOnCreation` as a plain property.
 */
describe('the record COMPARISON side and its create-only drops (#2790)', () => {
  const TYPE = 'AWS::EC2::Subnet';
  const CREATE_ONLY = 'AvailabilityZoneId';
  const PLAIN = 'AssignIpv6AddressOnCreation';
  const ALLOW = new Set([`${TYPE}:${CREATE_ONLY}`]);
  const NONE = new Set<string>();
  const WRITTEN = { VpcId: 'vpc-1', CidrBlock: '10.0.0.0/24' };
  const RECORD = { ...WRITTEN, [CREATE_ONLY]: 'use1-az1' };
  // What an SDK-route deploy that accepted the drop records beside it.
  const EVIDENCE = new Set([CREATE_ONLY]);
  const NO_EVIDENCE = new Set<string>();

  it('PREMISE: the fixture keys are classified as this block assumes', () => {
    const cov = getPropertyCoverage(TYPE);
    if (!cov) throw new Error(`${TYPE} lost its property-coverage record`);
    expect(cov.createOnlyDrops.has(CREATE_ONLY)).toBe(true);
    expect(cov.sdkUnwired.has(PLAIN)).toBe(true);
    expect(cov.createOnlyDrops.has(PLAIN)).toBe(false);
    for (const key of Object.keys(WRITTEN)) expect(cov.handled.has(key)).toBe(true);
  });

  describe('withoutUnwrittenSdkUnwiredProperties', () => {
    it('KEEPS a create-only drop this deploy still accepts, by reference', () => {
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, RECORD, RECORD, ALLOW, EVIDENCE)).toBe(RECORD);
    });

    it('removes a create-only drop once the deploy no longer accepts it', () => {
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, RECORD, RECORD, NONE, EVIDENCE)).toEqual(WRITTEN);
    });

    it('removes it when the template no longer declares it, allow set or not', () => {
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, RECORD, WRITTEN, ALLOW, EVIDENCE)).toEqual(WRITTEN);
    });

    it('removes it when a SIBLING drop is un-allowed, since the resource then routes', () => {
      const desired = { ...RECORD, [PLAIN]: true };
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, RECORD, desired, ALLOW, EVIDENCE)).toEqual(WRITTEN);
    });

    it('removes a plain drop even while it is allowed', () => {
      const record = { ...WRITTEN, [PLAIN]: true };
      const allow = new Set([`${TYPE}:${PLAIN}`]);
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, record, record, allow, EVIDENCE)).toEqual(WRITTEN);
    });

    /**
     * The B1 population: an imported record, a record with no `provisionedBy`
     * that Cloud Control created, or one an older binary wrote. Each holds the
     * key with no evidence it was dropped, so AWS is presumed to hold it.
     */
    it('KEEPS a create-only drop the record does not name, by reference', () => {
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, RECORD, RECORD, NONE, NO_EVIDENCE)).toBe(
        RECORD
      );
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, RECORD, WRITTEN, NONE, NO_EVIDENCE)).toBe(
        RECORD
      );
    });

    it('returns the input by reference when the record holds no drop', () => {
      expect(withoutUnwrittenSdkUnwiredProperties(TYPE, WRITTEN, RECORD, NONE, EVIDENCE)).toBe(WRITTEN);
    });
  });

  describe('findUnwrittenCreateOnlyDrops', () => {
    it('names a recorded create-only drop the template asks for unchanged, with no flag', () => {
      expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, RECORD, NONE, EVIDENCE)).toEqual([CREATE_ONLY]);
    });

    it('is empty when the record does not name the key (imported, legacy, older binary)', () => {
      expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, RECORD, NONE, NO_EVIDENCE)).toEqual([]);
      expect(
        findUnwrittenCreateOnlyDrops(TYPE, RECORD, RECORD, NONE, new Set(['SomethingElse']))
      ).toEqual([]);
    });

    it('is empty while the deploy accepts the drop', () => {
      expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, RECORD, ALLOW, EVIDENCE)).toEqual([]);
    });

    it('is empty when the template CHANGED the value: that replacement is a template edit', () => {
      const desired = { ...RECORD, [CREATE_ONLY]: 'use1-az2' };
      expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, desired, NONE, EVIDENCE)).toEqual([]);
    });

    it('is empty when the template no longer declares it', () => {
      expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, WRITTEN, NONE, EVIDENCE)).toEqual([]);
    });

    it('is empty when the record never held it (an ordinary addition)', () => {
      expect(findUnwrittenCreateOnlyDrops(TYPE, WRITTEN, RECORD, NONE, EVIDENCE)).toEqual([]);
    });

    it('never names a PLAIN drop: applying one needs no replacement', () => {
      const record = { ...WRITTEN, [PLAIN]: true };
      expect(findUnwrittenCreateOnlyDrops(TYPE, record, record, NONE, EVIDENCE)).toEqual([]);
    });

    it('names it when the allow set covers it but a sibling drop routes the resource', () => {
      const desired = { ...RECORD, [PLAIN]: true };
      expect(findUnwrittenCreateOnlyDrops(TYPE, RECORD, desired, ALLOW, EVIDENCE)).toEqual([CREATE_ONLY]);
    });

    it('counts a recorded dynamic-reference expression as unchanged: the refusal destroys nothing', () => {
      const record = { ...WRITTEN, [CREATE_ONLY]: '{{resolve:ssm:/az-id}}' };
      const desired = { ...WRITTEN, [CREATE_ONLY]: 'use1-az1' };
      expect(findUnwrittenCreateOnlyDrops(TYPE, record, desired, NONE, EVIDENCE)).toEqual([CREATE_ONLY]);
    });
  });
});
