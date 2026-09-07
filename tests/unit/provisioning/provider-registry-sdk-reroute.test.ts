/**
 * The `'sdk-coverage'` sticky-CC exemption: a resource recorded as
 * `provisionedBy: 'cc-api'` returning to its SDK provider (issue
 * [#2719](https://github.com/go-to-k/cdkd/issues/2719)).
 *
 * These cases pin the CONDITIONS, which is where the design lives. The flip is
 * per-RESOURCE, never per type: type coverage is neither necessary (a
 * partially backfilled type can safely flip a resource that only uses covered
 * properties) nor sufficient (a fully backfilled one must still not flip a
 * resource carrying a property the provider does not handle).
 *
 * The type under test is the real table's first `'sdk-coverage'` member rather
 * than a synthetic one, because the table is the contract: a test against an
 * injected fixture would keep passing after a careless edit to the shipped
 * entry, which is the only edit that can actually hurt a user.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  ProviderRegistry,
  STICKY_CC_MIGRATION_EXEMPT,
  wouldReturnToSdkProvider,
} from '../../../src/provisioning/provider-registry.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

function stubSdkProvider(): ResourceProvider {
  return {
    create: () => Promise.resolve({ physicalId: 'phys' }),
    update: () => Promise.resolve({ physicalId: 'phys' }),
    delete: () => Promise.resolve(),
    getAttribute: () => Promise.resolve(undefined),
  } as unknown as ResourceProvider;
}

/** The shipped table's first `'sdk-coverage'` member. */
function sdkCoverageType(): string {
  for (const [type, entry] of STICKY_CC_MIGRATION_EXEMPT) {
    if (entry.mode === 'sdk-coverage') return type;
  }
  throw new Error(
    'STICKY_CC_MIGRATION_EXEMPT has no sdk-coverage member, so every case in this file ' +
      'would be vacuous. If the last one was deliberately removed, delete this file with it.',
  );
}

/** The shipped table's first `'cc-broken'` member. */
function ccBrokenType(): string {
  for (const [type, entry] of STICKY_CC_MIGRATION_EXEMPT) {
    if (entry.mode === 'cc-broken') return type;
  }
  throw new Error('STICKY_CC_MIGRATION_EXEMPT has no cc-broken member');
}

/**
 * A property that the sdk-coverage type's provider would SILENTLY DROP.
 *
 * By construction the type has none -- that is why it was admitted -- so the
 * "dirty bag" cases need a property from the SAME type's schema that is not in
 * its handled set. Deriving one from the coverage map keeps the case honest:
 * if the type ever gains a real silent drop, this picks it up instead of
 * asserting against a name nobody maintains.
 */
function dirtyBagFor(resourceType: string): Record<string, unknown> {
  const cov = PROPERTY_COVERAGE_BY_TYPE.get(resourceType);
  expect(cov, `${resourceType} has no coverage record`).toBeDefined();
  const firstDrop = cov!.silentDrop.keys().next();
  if (!firstDrop.done) return { [firstDrop.value]: 'x' };
  // No real silent drop (the expected state). Fall back to a type whose map
  // DOES have one, and assert through `wouldReturnToSdkProvider` on that type
  // instead -- see the dedicated case below.
  return {};
}

describe("sticky-CC exemption: 'sdk-coverage' mode", () => {
  const TYPE = sdkCoverageType();

  it('returns a cc-api-recorded resource to its SDK provider when both bags are clean', () => {
    const registry = new ProviderRegistry();
    const sdk = stubSdkProvider();
    registry.register(TYPE, sdk);

    const decision = registry.getProviderFor({
      resourceType: TYPE,
      properties: { DisplayName: 'after' },
      previousProperties: { DisplayName: 'before' },
      provisionedBy: 'cc-api',
    });

    expect(decision.provider).toBe(sdk);
    expect(decision.provisionedBy).toBe('sdk');
    // The marker is what the pre-flight report and the diff annotation read;
    // without it the flip is invisible to the user.
    expect(decision.sdkMigration).toBe(true);
  });

  it('does NOT set sdkMigration for a resource that was already on the SDK path', () => {
    // Otherwise the "returning to the SDK provider" line would fire on every
    // ordinary deploy of an exempt type -- a transition marker that marks
    // non-transitions is worse than none.
    const registry = new ProviderRegistry();
    registry.register(TYPE, stubSdkProvider());
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      properties: { DisplayName: 'after' },
      previousProperties: { DisplayName: 'before' },
      provisionedBy: 'sdk',
    });
    expect(decision.provisionedBy).toBe('sdk');
    expect(decision.sdkMigration).toBeUndefined();
  });

  it('stays on Cloud Control when the call carries NO properties', () => {
    // The destroy / rollback-delete / observed-capture contract. A call with
    // no template bag cannot establish anything about the resource, so it must
    // not flip -- this single rule is what makes `cdkd destroy`, the rollback
    // executor and the legacy `getProvider()` conservative without any of them
    // needing a special case.
    const registry = new ProviderRegistry();
    registry.register(TYPE, stubSdkProvider());
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      provisionedBy: 'cc-api',
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.sdkMigration).toBeUndefined();
  });

  it('stays on Cloud Control with NO desired bag even when the recorded one IS passed', () => {
    // The no-properties gate on its own. The obvious spelling of this case
    // passes BOTH bags as undefined, and a mutation probe showed that proves
    // nothing: with both absent, disabling the desired-bag gate still leaves
    // the recorded-bag gate to refuse, so the resource stays on Cloud Control
    // for the wrong reason and the case survives. A confluence point -- each
    // gate needs an input where it is the ONLY one that can fire.
    const registry = new ProviderRegistry();
    registry.register(TYPE, stubSdkProvider());
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      previousProperties: { DisplayName: 'before' },
      provisionedBy: 'cc-api',
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.sdkMigration).toBeUndefined();
  });

  it('stays on Cloud Control when the RECORDED bag was not passed', () => {
    // Absent means UNKNOWN, not empty. A caller holding a state record but not
    // passing its bag is indistinguishable here from one with no record, and
    // guessing "clean" would reopen the removal-deploy hole through the one
    // door the predicate exists to close.
    const registry = new ProviderRegistry();
    registry.register(TYPE, stubSdkProvider());
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      properties: { DisplayName: 'after' },
      provisionedBy: 'cc-api',
    });
    expect(decision.provisionedBy).toBe('cc-api');
  });

  it('stays on Cloud Control when forceCcApi is set (--pin-cc-api / --recreate-via-cc-api)', () => {
    const registry = new ProviderRegistry();
    registry.register(TYPE, stubSdkProvider());
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      properties: { DisplayName: 'after' },
      previousProperties: { DisplayName: 'before' },
      provisionedBy: 'cc-api',
      forceCcApi: true,
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.sdkMigration).toBeUndefined();
  });
});

describe("sticky-CC exemption: 'cc-broken' mode is unchanged", () => {
  const TYPE = ccBrokenType();

  it('diverts to the SDK provider even with no properties at all', () => {
    // The asymmetry that matters: for a broken CC handler there is no property
    // bag that would make staying on Cloud Control correct, so the escape is
    // unconditional where 'sdk-coverage' is conditional.
    const registry = new ProviderRegistry();
    const sdk = stubSdkProvider();
    registry.register(TYPE, sdk);
    const decision = registry.getProviderFor({ resourceType: TYPE, provisionedBy: 'cc-api' });
    expect(decision.provider).toBe(sdk);
    expect(decision.provisionedBy).toBe('sdk');
  });

  it('ignores forceCcApi — a pin must not re-pin to a handler that cannot manage the type', () => {
    const registry = new ProviderRegistry();
    const sdk = stubSdkProvider();
    registry.register(TYPE, sdk);
    const decision = registry.getProviderFor({
      resourceType: TYPE,
      provisionedBy: 'cc-api',
      forceCcApi: true,
    });
    expect(decision.provider).toBe(sdk);
    expect(decision.provisionedBy).toBe('sdk');
  });
});

describe('a non-exempt type is untouched by any of this', () => {
  it('stays sticky on Cloud Control with both bags clean and no pin', () => {
    const registry = new ProviderRegistry();
    const type = 'AWS::CloudFormation::WaitConditionHandle';
    expect(
      STICKY_CC_MIGRATION_EXEMPT.has(type),
      'this control needs a type that is NOT in the exemption table',
    ).toBe(false);
    registry.register(type, stubSdkProvider());
    const decision = registry.getProviderFor({
      resourceType: type,
      properties: {},
      previousProperties: {},
      provisionedBy: 'cc-api',
    });
    expect(decision.provisionedBy).toBe('cc-api');
    expect(decision.sdkMigration).toBeUndefined();
  });
});

describe('wouldReturnToSdkProvider (the one implementation of the flip condition)', () => {
  it('agrees with the registry on the flip case', () => {
    expect(
      wouldReturnToSdkProvider({
        resourceType: sdkCoverageType(),
        desiredProperties: { DisplayName: 'a' },
        previousProperties: { DisplayName: 'b' },
      }),
    ).toBe(true);
  });

  it('is false for a non-exempt type', () => {
    expect(
      wouldReturnToSdkProvider({
        resourceType: 'AWS::S3::Bucket',
        desiredProperties: {},
        previousProperties: {},
      }),
    ).toBe(false);
  });

  it('is false when either bag is absent', () => {
    const resourceType = sdkCoverageType();
    expect(
      wouldReturnToSdkProvider({ resourceType, desiredProperties: { DisplayName: 'a' } }),
    ).toBe(false);
    expect(
      wouldReturnToSdkProvider({ resourceType, previousProperties: { DisplayName: 'b' } }),
    ).toBe(false);
  });

  it('is true for a cc-broken type regardless of bags', () => {
    expect(wouldReturnToSdkProvider({ resourceType: ccBrokenType() })).toBe(true);
  });

  it('is false when forceCcApi is set', () => {
    expect(
      wouldReturnToSdkProvider({
        resourceType: sdkCoverageType(),
        desiredProperties: { DisplayName: 'a' },
        previousProperties: { DisplayName: 'b' },
        forceCcApi: true,
      }),
    ).toBe(false);
  });
});

/**
 * The BOTH-BAGS condition, which is the whole safety property.
 *
 * These cases inject a synthetic exemption table. That is deliberate and it is
 * the only way to reach this code: a real `'sdk-coverage'` type has an empty
 * `silentDrop` map by construction -- that is the reason it was admitted -- so
 * `findActionableSilentDrops` returns [] for every bag and the loop cannot
 * discriminate. Measured against the shipped table alone, mutating the loop to
 * read the desired bag twice, or the recorded bag twice, left the entire suite
 * GREEN. The injection swaps DATA; every gate under test is the shipped code.
 */
describe('the removal deploy: BOTH bags are read, not just the desired one', () => {
  /** A type that really does have a silent-drop property, from the coverage map. */
  function dirtyType(): { resourceType: string; property: string } {
    for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
      const first = cov.silentDrop.keys().next();
      if (!first.done) return { resourceType, property: first.value };
    }
    throw new Error(
      'no type has a silent-drop property, so these cases cannot discriminate — if the ' +
        'backfill really closed every gap, delete this block rather than leaving it vacuous.',
    );
  }

  /** That type, pretended into the table as an `'sdk-coverage'` member. */
  function tableWith(resourceType: string) {
    return new Map([
      [
        resourceType,
        {
          mode: 'sdk-coverage' as const,
          physicalIdForm: 'synthetic entry for the both-bags cases in this file',
          issue: 'https://github.com/go-to-k/cdkd/issues/2719',
          integFixture: 'cc-to-sdk-reroute',
        },
      ],
    ]);
  }

  it('flips when BOTH bags are clean', () => {
    const { resourceType } = dirtyType();
    expect(
      wouldReturnToSdkProvider({
        resourceType,
        desiredProperties: {},
        previousProperties: {},
        exemptions: tableWith(resourceType),
      }),
    ).toBe(true);
  });

  it('refuses when the DESIRED bag carries a silent drop', () => {
    const { resourceType, property } = dirtyType();
    expect(
      wouldReturnToSdkProvider({
        resourceType,
        desiredProperties: { [property]: 'x' },
        previousProperties: {},
        exemptions: tableWith(resourceType),
      }),
    ).toBe(false);
  });

  it('refuses when only the RECORDED bag carries one — the removal deploy', () => {
    // Property P was applied under Cloud Control, then deleted from the
    // template. The desired bag is clean, so a desired-only condition would
    // route THIS deploy to the SDK provider, which cannot unset P — silently
    // skipping the removal, the exact bug the auto-route exists to prevent.
    // Under CC the same deploy patches P away, and the NEXT one flips.
    const { resourceType, property } = dirtyType();
    expect(
      wouldReturnToSdkProvider({
        resourceType,
        desiredProperties: {},
        previousProperties: { [property]: 'x' },
        exemptions: tableWith(resourceType),
      }),
    ).toBe(false);
  });

  it('flips again once the allow-list opts into that very drop', () => {
    // `--allow-unsupported-properties` means "force the SDK path and accept the
    // drop", so an allowed property must not block the flip. Pinned rather than
    // left implicit, because it is the one input that makes a dirty bag clean.
    const { resourceType, property } = dirtyType();
    expect(
      wouldReturnToSdkProvider({
        resourceType,
        desiredProperties: { [property]: 'x' },
        previousProperties: { [property]: 'x' },
        allowedUnsupportedProperties: new Set([`${resourceType}:${property}`]),
        exemptions: tableWith(resourceType),
      }),
    ).toBe(true);
  });
});
