/**
 * Deploy-time property-coverage runtime helpers (PR5).
 *
 * Distinct from `property-coverage.test.ts` (the offline / Issue #391 test
 * layer that enforces every provider declares `handledProperties` /
 * `unhandledByDesign` consistently with the CFn schema fixture). This file
 * exercises the runtime helpers:
 *   - `getPropertyCoverage` (lookup)
 *   - `findSilentDropProperties` (per-resource silent-drop detection)
 *   - `findActionableSilentDrops` (silent drops minus the override allow-set)
 *   - `findAcceptedSilentDrops` / `withoutSilentDropProperties` /
 *     `withoutAcceptedSilentDropProperties` (the #2750 record- and diff-side
 *     narrowings: what the SDK route actually writes)
 *   - `unsupportedPropertyIssueUrl` (1-click GitHub issue link)
 *
 * The throw-based `ProviderRegistry.validateResourceProperties` tests were
 * removed when #614 reversed the silent-drop policy: the method now
 * auto-routes via Cloud Control API + info-logs instead of throwing. The
 * info-/warn-log shape is covered by
 * `provider-registry-report-silent-drops.test.ts`; the routing decisions
 * are covered by `provider-registry-cc-routing.test.ts`.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  PROPERTY_COVERAGE_BY_TYPE,
  findAcceptedSilentDrops,
  findActionableSilentDrops,
  findSilentDropProperties,
  getPropertyCoverage,
  unsupportedPropertyIssueUrl,
  withoutAcceptedSilentDropProperties,
  withoutSilentDropProperties,
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

describe('findSilentDropProperties', () => {
  it('returns [] when the resource type has no coverage record (Tier 2 / Custom / unknown)', () => {
    expect(findSilentDropProperties('AWS::Made::Up', { Foo: 'bar' })).toEqual([]);
  });

  it('returns [] when properties is undefined or empty', () => {
    expect(findSilentDropProperties('AWS::Lambda::Function', undefined)).toEqual([]);
    expect(findSilentDropProperties('AWS::Lambda::Function', {})).toEqual([]);
  });

  it('returns [] when every property is handled', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const handledKey = Array.from(cov.handled)[0];
    if (!handledKey) throw new Error('Lambda Function should declare at least one handled property');
    expect(
      findSilentDropProperties('AWS::Lambda::Function', { [handledKey]: 'x' })
    ).toEqual([]);
  });

  it('flags a silent-drop property with its rationale', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const dropKey = Array.from(cov.silentDrop.keys())[0];
    if (!dropKey) return; // No silent drops left — provider has caught up.
    const drops = findSilentDropProperties('AWS::Lambda::Function', { [dropKey]: 'x' });
    expect(drops).toHaveLength(1);
    expect(drops[0]).toEqual({
      property: dropKey,
      rationale: cov.silentDrop.get(dropKey),
    });
  });

  it('passes through properties NOT in the CFn schema (escape hatch / typo tolerance)', () => {
    expect(
      findSilentDropProperties('AWS::Lambda::Function', {
        SomeFakeUnknownProperty: 'x',
      })
    ).toEqual([]);
  });

  it('sorts results alphabetically by property name', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    if (cov.silentDrop.size < 2) {
      throw new Error('AWS::Lambda::Function should declare ≥2 silent-drop properties');
    }
    const keys = Array.from(cov.silentDrop.keys());
    const reversed = [...keys].reverse();
    const props = Object.fromEntries(reversed.map((k) => [k, 'x']));
    const drops = findSilentDropProperties('AWS::Lambda::Function', props);
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
 * so the tests below stay declarative against whichever silent-drop type the
 * generator surfaces today. Throws if every Tier 1 type is fully handled —
 * at that point the runtime reject path has no exercise input and these
 * tests would silently no-op, masking regressions. Today the generated map
 * carries 469 silent-drop entries, so this is far from triggering; the
 * throw exists so the tests fail loudly when (eventually) every gap is
 * closed and a different test shape is required.
 */
function pickSilentDropFixture(): {
  resourceType: string;
  property: string;
  rationale: string;
} {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const first = cov.silentDrop.entries().next();
    if (!first.done) {
      const [property, rationale] = first.value;
      return { resourceType, property, rationale };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no silent-drop entries — every Tier 1 ' +
      'type is fully handled. Update these tests to exercise the reject path ' +
      'against a synthetic fixture instead of the generated map.'
  );
}

/**
 * Find a (type, propA, propB) triple where the type has ≥2 silent-drop
 * entries — used by tests that need to verify per-property granularity.
 * Throws (rather than silently skipping) so a regression in the generated
 * map fails the suite loudly. Today many Tier 1 types satisfy this (e.g.
 * AWS::Lambda::Function has 15 silent-drop entries), so the throw is the
 * safe default.
 */
function pickSilentDropPair(): { resourceType: string; propA: string; propB: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.silentDrop.size >= 2) {
      const sorted = Array.from(cov.silentDrop.keys()).sort((x, y) => x.localeCompare(y));
      return { resourceType, propA: sorted[0]!, propB: sorted[1]! };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no type with ≥2 silent-drop entries — ' +
      'these tests assume at least one type with multiple gaps. Update them ' +
      'to use a synthetic fixture instead of the generated map.'
  );
}

describe('findActionableSilentDrops (#614)', () => {
  it('returns the full set when allowedKeys is empty', () => {
    const fx = pickSilentDropFixture();
    const drops = findActionableSilentDrops(
      fx.resourceType,
      { [fx.property]: 'x' },
      new Set()
    );
    expect(drops).toHaveLength(1);
    expect(drops[0]?.property).toBe(fx.property);
  });

  it('filters out drops whose <Type>:<Prop> key is in allowedKeys', () => {
    const fx = pickSilentDropFixture();
    const drops = findActionableSilentDrops(
      fx.resourceType,
      { [fx.property]: 'x' },
      new Set([`${fx.resourceType}:${fx.property}`])
    );
    expect(drops).toEqual([]);
  });

  it('only filters by the exact <Type>:<Prop> token — siblings remain', () => {
    const pair = pickSilentDropPair();
    const drops = findActionableSilentDrops(
      pair.resourceType,
      { [pair.propA]: 'x', [pair.propB]: 'y' },
      new Set([`${pair.resourceType}:${pair.propA}`])
    );
    expect(drops.map((d) => d.property)).toEqual([pair.propB]);
  });

  it('preserves alphabetical sort from findSilentDropProperties', () => {
    const pair = pickSilentDropPair();
    const drops = findActionableSilentDrops(
      pair.resourceType,
      { [pair.propB]: 'x', [pair.propA]: 'y' },
      new Set()
    );
    expect(drops.map((d) => d.property)).toEqual([pair.propA, pair.propB]);
  });
});

describe('findAcceptedSilentDrops (#2750)', () => {
  it('returns [] when nothing is allow-listed — the resource auto-routes to CC', () => {
    const fx = pickSilentDropFixture();
    expect(findAcceptedSilentDrops(fx.resourceType, { [fx.property]: 'x' }, new Set())).toEqual([]);
  });

  it('names the drop the user opted into when it is the only one', () => {
    const fx = pickSilentDropFixture();
    expect(
      findAcceptedSilentDrops(
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
    const pair = pickSilentDropPair();
    expect(
      findAcceptedSilentDrops(
        pair.resourceType,
        { [pair.propA]: 'x', [pair.propB]: 'y' },
        new Set([`${pair.resourceType}:${pair.propA}`])
      )
    ).toEqual([]);
  });

  it('names both when both are allow-listed', () => {
    const pair = pickSilentDropPair();
    expect(
      findAcceptedSilentDrops(
        pair.resourceType,
        { [pair.propA]: 'x', [pair.propB]: 'y' },
        new Set([`${pair.resourceType}:${pair.propA}`, `${pair.resourceType}:${pair.propB}`])
      )
    ).toEqual([pair.propA, pair.propB]);
  });

  it('is the complement of findActionableSilentDrops on every allow-set shape', () => {
    const pair = pickSilentDropPair();
    const props = { [pair.propA]: 'x', [pair.propB]: 'y' };
    const bothAllowed = new Set([
      `${pair.resourceType}:${pair.propA}`,
      `${pair.resourceType}:${pair.propB}`,
    ]);
    for (const allowed of [new Set<string>(), new Set([`${pair.resourceType}:${pair.propA}`]), bothAllowed]) {
      const actionable = findActionableSilentDrops(pair.resourceType, props, allowed);
      const accepted = findAcceptedSilentDrops(pair.resourceType, props, allowed);
      // Exactly one of the two is non-empty: a bag with drops either takes the
      // SDK route (everything accepted) or the CC route (nothing accepted).
      expect(actionable.length === 0 || accepted.length === 0).toBe(true);
    }
  });
});

/**
 * The same, restricted to a drop that is NOT create-only. The two `without*`
 * helpers deliberately KEEP a create-only drop (#2750 / go-to-k/cdkd#2790), so
 * a case asserting removal must not be handed one — `pickSilentDropFixture`'s
 * first entry happens to be `AWS::ApiGateway::Deployment.DeploymentCanarySettings`,
 * which is exactly that.
 */
function pickPlainSilentDropFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    for (const property of cov.silentDrop.keys()) {
      if (!cov.createOnlyDrops.has(property)) return { resourceType, property };
    }
  }
  throw new Error('every silent drop is create-only — use a synthetic fixture');
}

/** A type with two silent drops, NEITHER of them create-only. */
function pickPlainSilentDropPair(): { resourceType: string; propA: string; propB: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const plain = [...cov.silentDrop.keys()]
      .filter((k) => !cov.createOnlyDrops.has(k))
      .sort((a, b) => a.localeCompare(b));
    if (plain.length >= 2) return { resourceType, propA: plain[0]!, propB: plain[1]! };
  }
  throw new Error('no type has two non-create-only silent drops — use a synthetic fixture');
}

/**
 * A (type, property) pair whose silent drop is ALSO create-only, and whose type
 * has at least one drop that is NOT — so the exclusion and its control can be
 * driven off the same type. Throws rather than skipping: with no such pair the
 * cases below would pass having exercised nothing, which is exactly how the
 * first cut of this fence family shipped vacuous.
 */
function pickCreateOnlyDropFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.createOnlyDrops.size === 0) continue;
    if (cov.silentDrop.size <= cov.createOnlyDrops.size) continue;
    const property = [...cov.createOnlyDrops].sort((a, b) => a.localeCompare(b))[0]!;
    return { resourceType, property };
  }
  throw new Error(
    'No type has both a create-only silent drop and a plain one — the #2750 ' +
      'create-only exclusion cannot be exercised against the generated map. ' +
      'Use a synthetic fixture instead.'
  );
}

describe('withoutSilentDropProperties (#2750, the RECORD side)', () => {
  it('removes every silent-drop key regardless of any allow set', () => {
    const pair = pickPlainSilentDropPair();
    const written = withoutSilentDropProperties(pair.resourceType, {
      [pair.propA]: 'x',
      [pair.propB]: 'y',
      SomeFakeUnknownProperty: 'kept',
    });
    expect(written).toEqual({ SomeFakeUnknownProperty: 'kept' });
  });

  it('returns the SAME object when the type has no coverage record', () => {
    const props = { Foo: 'bar' };
    expect(withoutSilentDropProperties('AWS::Made::Up', props)).toBe(props);
  });

  it('returns the SAME object when the bag carries no silent drop', () => {
    const cov = getPropertyCoverage('AWS::Lambda::Function');
    if (!cov) throw new Error('AWS::Lambda::Function should have a coverage record');
    const handledKey = Array.from(cov.handled)[0]!;
    const props = { [handledKey]: 'x' };
    expect(withoutSilentDropProperties('AWS::Lambda::Function', props)).toBe(props);
  });

  it('does not mutate the input bag', () => {
    const fx = pickPlainSilentDropFixture();
    const props = { [fx.property]: 'x' };
    withoutSilentDropProperties(fx.resourceType, props);
    expect(props).toEqual({ [fx.property]: 'x' });
  });

  /**
   * The one exclusion, and it is what stops the narrowing being destructive
   * rather than merely incomplete: removing a CREATE-ONLY drop makes it read as
   * an ADDITION on the next deploy, which classifies as a REPLACEMENT of a
   * resource nobody touched. go-to-k/cdkd#2790 carries the residual that leaves
   * (for those keys the property still does not reach AWS).
   */
  it('KEEPS a create-only silent drop', () => {
    const fx = pickCreateOnlyDropFixture();
    const props = { [fx.property]: 'x' };
    expect(withoutSilentDropProperties(fx.resourceType, props)).toBe(props);
  });

  it('still removes a NON-create-only drop on the same type', () => {
    // The control: without it the row above passes under an implementation
    // that stopped narrowing altogether.
    const fx = pickCreateOnlyDropFixture();
    const plain = [...PROPERTY_COVERAGE_BY_TYPE.get(fx.resourceType)!.silentDrop.keys()].find(
      (p) => !PROPERTY_COVERAGE_BY_TYPE.get(fx.resourceType)!.createOnlyDrops.has(p)
    );
    if (plain === undefined) {
      throw new Error(
        `${fx.resourceType} has only create-only silent drops — pick a type with both, ` +
          'or this control asserts nothing.'
      );
    }
    expect(
      withoutSilentDropProperties(fx.resourceType, { [fx.property]: 'x', [plain]: 'y' })
    ).toEqual({ [fx.property]: 'x' });
  });
});

describe('withoutAcceptedSilentDropProperties (#2750, the DESIRED side)', () => {
  it('removes the opted-into drop', () => {
    const fx = pickPlainSilentDropFixture();
    expect(
      withoutAcceptedSilentDropProperties(
        fx.resourceType,
        { [fx.property]: 'x', SomeFakeUnknownProperty: 'kept' },
        new Set([`${fx.resourceType}:${fx.property}`])
      )
    ).toEqual({ SomeFakeUnknownProperty: 'kept' });
  });

  /**
   * The discriminator against the record-side helper: with no flag the drop
   * auto-routes the resource through Cloud Control, which DOES write the
   * property, so narrowing it here would hide a real difference.
   */
  it('keeps a drop the user did NOT opt into', () => {
    const fx = pickPlainSilentDropFixture();
    const props = { [fx.property]: 'x' };
    expect(withoutAcceptedSilentDropProperties(fx.resourceType, props, new Set())).toBe(props);
  });

  it('keeps BOTH drops of a mixed bag — the resource takes the CC route', () => {
    const pair = pickPlainSilentDropPair();
    const props = { [pair.propA]: 'x', [pair.propB]: 'y' };
    expect(
      withoutAcceptedSilentDropProperties(
        pair.resourceType,
        props,
        new Set([`${pair.resourceType}:${pair.propA}`])
      )
    ).toBe(props);
  });

  it('does not mutate the input bag', () => {
    const fx = pickPlainSilentDropFixture();
    const props = { [fx.property]: 'x' };
    withoutAcceptedSilentDropProperties(
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
      withoutAcceptedSilentDropProperties(
        fx.resourceType,
        props,
        new Set([`${fx.resourceType}:${fx.property}`])
      )
    ).toBe(props);
  });
});
