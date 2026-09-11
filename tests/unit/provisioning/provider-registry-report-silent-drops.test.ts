/**
 * Side-effect surface for #614 — `validateResourceProperties` (now an
 * alias for `reportSilentDropDecisions`) no longer throws. Each silent
 * drop emits either an info log (auto-route via CC API) or a warn log
 * (user opted into the silent drop via `--allow-unsupported-properties`).
 *
 * The tests capture log lines by swapping the registry's logger via
 * the global `getLogger` mock — same shape every other registry test
 * uses, so no fragile log-level wiring is needed here.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import { existsSync } from 'node:fs';
import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';

function pickSilentDropFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const first = cov.silentDrop.entries().next();
    if (!first.done) {
      const [property] = first.value;
      return { resourceType, property };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no silent-drop entries — every Tier 1 ' +
      'type is fully handled. Update this test to use a synthetic fixture.'
  );
}

/**
 * A type with TWO silent drops, so the mixed allow-set case below has a
 * SIBLING to leave un-allowed. Throws rather than skipping: with no such type
 * the case would pass having exercised nothing.
 */
function pickSilentDropPair(): { resourceType: string; propA: string; propB: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    if (cov.silentDrop.size >= 2) {
      const sorted = Array.from(cov.silentDrop.keys()).sort((x, y) => x.localeCompare(y));
      return { resourceType, propA: sorted[0]!, propB: sorted[1]! };
    }
  }
  throw new Error(
    'PROPERTY_COVERAGE_BY_TYPE has no type with ≥2 silent-drop entries — the ' +
      'mixed allow-set case needs one. Update it to use a synthetic fixture.'
  );
}

/**
 * Build a registry whose `.logger` field is a vi-mocked spy so the test
 * can inspect every `info` / `warn` line emitted by
 * `reportSilentDropDecisions` without touching the real logger.
 */
function makeRegistry() {
  const registry = new ProviderRegistry();
  const info = vi.fn();
  const warn = vi.fn();
  const debug = vi.fn();
  const error = vi.fn();
  // `logger` is a private field, but the tests intentionally swap it via
  // a cast so the assertions can stay declarative. Same pattern used by
  // the existing property-coverage runtime tests.
  (registry as unknown as { logger: { info: typeof info; warn: typeof warn; debug: typeof debug; error: typeof error } }).logger = {
    info,
    warn,
    debug,
    error,
  };
  return { registry, info, warn };
}

/** A (type, property) whose silent drop IS create-only. */
function pickCreateOnlyDropFixture(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    const first = [...cov.createOnlyDrops].sort((a, b) => a.localeCompare(b))[0];
    if (first !== undefined) return { resourceType, property: first };
  }
  throw new Error('no type has a create-only silent drop — use a synthetic fixture');
}

/** A (type, property) whose silent drop is NOT create-only. */
function pickPlainSilentDropFixtureForWarn(): { resourceType: string; property: string } {
  for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
    for (const property of cov.silentDrop.keys()) {
      if (!cov.createOnlyDrops.has(property)) return { resourceType, property };
    }
  }
  throw new Error('every silent drop is create-only — use a synthetic fixture');
}

describe('ProviderRegistry.validateResourceProperties (post-#614, now a report path)', () => {
  let fx: { resourceType: string; property: string };

  beforeEach(() => {
    fx = pickSilentDropFixture();
  });

  it('never throws — even for a resource with silent-drop properties', () => {
    const { registry } = makeRegistry();
    expect(() =>
      registry.validateResourceProperties([
        {
          logicalId: 'MyResource',
          resourceType: fx.resourceType,
          properties: { [fx.property]: 'x' },
        },
      ])
    ).not.toThrow();
  });

  it('emits an info log with the auto-route routing decision + override hint', () => {
    const { registry, info } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'MyLambda',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
      },
    ]);
    expect(info).toHaveBeenCalledTimes(1);
    const msg = info.mock.calls[0]![0] as string;
    expect(msg).toContain('MyLambda');
    expect(msg).toContain(fx.resourceType);
    expect(msg).toContain('routing via Cloud Control API');
    expect(msg).toContain(fx.property);
    expect(msg).toContain('--prefer-sdk-route');
    expect(msg).toContain(`${fx.resourceType}:${fx.property}`);
  });

  it('emits a warn log when the user has explicitly overridden the silent drop', () => {
    const { registry, info, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'MyResource',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
      },
    ]);
    expect(info).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain('MyResource');
    expect(msg).toContain(fx.resourceType);
    expect(msg).toContain(fx.property);
    expect(msg).toContain('silently dropped');
    expect(msg).toContain('--prefer-sdk-route');
  });

  /**
   * Issue #2750. The allow set is per `<Type>:<Prop>` while the ROUTE is per
   * resource: the un-allowed sibling sends the whole resource through Cloud
   * Control, which forwards the full property map — so the allow-listed
   * property reaches AWS after all and the "will be silently dropped" line is
   * simply false. Only the auto-route line is true here.
   */
  it('does NOT warn that an overridden drop will be DROPPED when a sibling auto-routes', () => {
    // Narrowed from `expect(warn).not.toHaveBeenCalled()` by issue
    // go-to-k/cdkd#3000, and the narrowing is a deliberate revision of
    // go-to-k/cdkd#2750's decision rather than an erosion of it.
    //
    // What #2750 retired was a FALSE warn: it told the user the property "will
    // be silently dropped" while Cloud Control was writing it, and prescribed
    // removing the override — a no-op. That sentence must stay gone, and the
    // assertion below is what keeps it gone.
    //
    // What #3000 added is the opposite claim and a true one: the user's
    // preference went INERT and the property IS written. It fires only for a
    // user who actually passed the flag for a property on THIS resource, so it
    // is not the broadcast warn #2750 removed — and without it an explicit
    // instruction appears silently ignored, which is the confusion that drove
    // the flag's rename.
    const pair = pickSilentDropPair();
    const { registry, info, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${pair.resourceType}:${pair.propA}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'MixedResource',
        resourceType: pair.resourceType,
        properties: { [pair.propA]: 'x', [pair.propB]: 'y' },
      },
    ]);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned, "the FALSE 'will be dropped' warn is back").not.toMatch(
      /silently dropped|will not be written|missing the field/
    );
    // And the true one IS present — otherwise this case would pass in the
    // world where #3000's warning was never wired.
    expect(warned, 'the inert-preference warning is gone').toContain('had no effect');
    // See the sticky case below for why the COUNT is asserted and not just the
    // phrases: it is the half the blanket `not.toHaveBeenCalled()` carried.
    expect(warn, 'a second warning appeared on this path').toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledTimes(1);
    const msg = info.mock.calls[0]![0] as string;
    expect(msg).toContain('routing via Cloud Control API');
    // The auto-route line still names ONLY the un-allowed drop: the override
    // hint it prints is what the user would add to force the SDK route.
    expect(msg).toContain(pair.propB);
    expect(msg).not.toContain(pair.propA);
  });

  /**
   * The engine calls this OPTIONALLY (`?.()`) so the many unit files that cast a
   * hand-built registry literal into `DeployEngine` keep working — which means
   * no engine-side test can witness the REAL class losing the method. Pin it
   * here, on the real class, or the #2750 desired-side narrowing goes silently
   * inert in production while every mocked suite stays green.
   */
  /**
   * Issue #2750, the second route that means the drop does not happen. A
   * `provisionedBy: 'cc-api'` record stays on Cloud Control (`getProviderFor`
   * rule 2) whatever the allow set says, so the full map is forwarded and the
   * property IS written — while the pre-fix warn told the user it "will be
   * silently dropped" and prescribed removing the override, which is a no-op
   * because the resource is already on the route that remedy names.
   *
   * The `!STICKY_CC_MIGRATION_EXEMPT.has(type)` half of that gate is NOT
   * exercised here and cannot be: an admitted exempt type has an EMPTY
   * silentDrop map by construction (that is why it was admitted), the same
   * unreachability `wouldReturnToSdkProvider`'s doc comment records for its own
   * both-bags condition. It is present for parity with the sibling
   * `reportUnrecognizedProperties`, which makes the identical test.
   */
  it('does NOT warn about an overridden drop on a resource already recorded cc-api', () => {
    const fx = pickSilentDropFixture();
    const { registry, info, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'StickyResource',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
        provisionedBy: 'cc-api',
      },
    ]);
    // NARROWED by issue go-to-k/cdkd#3000, like its sibling above. #2750
    // retired a FALSE warn here — it claimed the property would be dropped
    // while Cloud Control was writing it — and that sentence must stay gone.
    // What replaces the silence is the opposite claim and a true one: the
    // preference is INERT and the value IS written. This is the case a user is
    // most likely to report, and before #3000 cdkd said nothing about it at
    // default verbosity.
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned, "the FALSE 'will be dropped' warn is back").not.toMatch(
      /silently dropped|will not be written|missing the field/
    );
    expect(warned, 'the inert-preference warning is gone').toContain('had no effect');
    // EXACTLY one. The blanket `not.toHaveBeenCalled()` this replaced also
    // caught a SECOND warn on the same path — including #2750's retired remedy
    // sentence, whose wording none of the phrases above matches. Dropping the
    // count would lose that half silently.
    expect(warn, 'a second warning appeared on this path').toHaveBeenCalledTimes(1);
    // The sticky record is the operative cause, so the remedy must be the one
    // that can actually beat it. Widening the preference cannot.
    // It must NOT prescribe a command. `--recreate-via-sdk-provider` looks like
    // the remedy and is pre-flight REFUSED across most of this branch's
    // population (an actionable drop outside the preference, a stateful type
    // without `--force-stateful-recreation`, a nested-stack child) — and it is
    // destructive. The module already made this call for the mirror flag; the
    // first cut of this warning prescribed it anyway and the test pinned the
    // incomplete string.
    expect(warned, 'the sticky case prescribes a command that is usually refused').not.toContain(
      '--recreate-via-sdk-provider'
    );
    expect(warned, 'the sticky remedy hides that it is destructive').toContain(
      'destroy-and-recreate'
    );
    // The HAND-OFF, and the clause that makes "widening is not enough" actionable.
    // Without these two the pair above is satisfied by an outcome with no remedy
    // path at all ("Returning this resource to the SDK provider is a
    // destroy-and-recreate.") — which is the failure this round exists to
    // prevent, one step further along — and by a mis-subjected sentence.
    expect(warned, 'the remedy has no hand-off — the outcome is stated and abandoned').toContain(
      'docs/cli-deploy-safety.md'
    );
    expect(warned, 'the "widening alone is not enough" clause is gone').toMatch(
      /Widening --prefer-sdk-route alone cannot/
    );
    // And the page it hands off to must EXIST. The message delegates its whole
    // remedy there, so a rename dangles a user-facing pointer silently; this
    // repo already fences the mirror case the same way.
    expect(
      existsSync(new URL('../../../docs/cli-deploy-safety.md', import.meta.url)),
      'the warning points at a docs page that no longer exists'
    ).toBe(true);
    expect(warned, 'the sticky case prescribes a remedy that is a no-op').not.toMatch(
      /add .* to --prefer-sdk-route as well/
    );
    expect(info).not.toHaveBeenCalled();
  });

  it('STILL warns for the same bag on a resource recorded sdk', () => {
    // The control for the row above: without it, that row also passes under an
    // implementation that stopped warning entirely.
    const fx = pickSilentDropFixture();
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'SdkResource',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
        provisionedBy: 'sdk',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0] as string).toContain('silently dropped');
  });

  /**
   * The remedy is per property, because "remove the override" is FALSE for a
   * create-only one: cdkd keeps such a key in the record (removing it would
   * make the next deploy read it as an addition and so as a REPLACEMENT), so
   * with the flag gone the diff is NO_CHANGE and nothing routes anywhere.
   * go-to-k/cdkd#2790 is the residual.
   */
  it('tells a create-only drop it needs a RECREATE, not a flag removal', () => {
    const fx = pickCreateOnlyDropFixture();
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'CreateOnlyResource',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
        provisionedBy: 'sdk',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain(fx.property);
    expect(msg).toContain('create-only');
    expect(msg).toContain('can only be applied by recreating the resource');
    // The false remedy must be GONE for this property, not merely joined by the
    // true one — it is the sentence a user would act on.
    expect(msg).not.toContain('Remove the override');
    // And NO pasteable command: `--recreate-via-cc-api` is refused by
    // pre-flight while this very override is still set, needs
    // `--force-stateful-recreation` for a stateful type, and is refused
    // outright for a `disableCcApiFallback` provider. A line that has to be
    // right about all three is one that will be wrong about one.
    expect(msg).not.toContain('--recreate-via-cc-api');
  });

  it('keeps the flag-removal remedy for a NON-create-only drop', () => {
    // The control: without it the row above passes under an implementation
    // that dropped the reroutable remedy for everything.
    const fx = pickPlainSilentDropFixtureForWarn();
    const { registry, warn } = makeRegistry();
    registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
    registry.validateResourceProperties([
      {
        logicalId: 'PlainResource',
        resourceType: fx.resourceType,
        properties: { [fx.property]: 'x' },
        provisionedBy: 'sdk',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = warn.mock.calls[0]![0] as string;
    expect(msg).toContain(`Remove the override for ${fx.property}`);
    expect(msg).not.toContain('create-only');
  });

  it('exposes the allow set for the diff to narrow with (#2750)', () => {
    const registry = new ProviderRegistry();
    expect(registry.getAllowedUnsupportedProperties()).toBeInstanceOf(Set);
    expect(registry.getAllowedUnsupportedProperties().size).toBe(0);
    registry.allowUnsupportedProperties(['AWS::CloudWatch::Alarm:EvaluationWindow']);
    expect(Array.from(registry.getAllowedUnsupportedProperties())).toEqual([
      'AWS::CloudWatch::Alarm:EvaluationWindow',
    ]);
  });

  it('skips resources with no silent-drop properties (no log noise)', () => {
    const { registry, info, warn } = makeRegistry();
    registry.validateResourceProperties([
      {
        logicalId: 'CleanResource',
        resourceType: 'AWS::Made::Up',
        properties: { Anything: 'goes' },
      },
    ]);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The INERT-preference warning (issue
 * [#3000](https://github.com/go-to-k/cdkd/issues/3000)).
 *
 * The preference is per `<Type>:<Prop>` while ROUTING is per RESOURCE, so one
 * uncovered sibling drop sends the whole resource to Cloud Control — which
 * forwards the full map, writing the very properties the user asked to keep off
 * the wire. Neither of the flag's purposes is served, and until this warning
 * nothing named that: the user sees an explicit instruction apparently ignored.
 * It is the concrete confusion that motivated the rename.
 */
describe('--prefer-sdk-route had no effect', () => {
  /** A type with TWO silent drops, so one can be covered and one not. */
  function twoDrops() {
    const { resourceType, propA, propB } = pickSilentDropPair();
    const { registry, warn } = makeRegistry();
    return { registry, warn, resourceType, covered: propA, uncovered: propB };
  }

  it('warns, naming the covered property and the sibling that overrode it', () => {
    const { registry, warn, resourceType, covered, uncovered } = twoDrops();
    registry.allowUnsupportedProperties([`${resourceType}:${covered}`]);

    registry.validateResourceProperties([
      {
        logicalId: 'Target',
        resourceType,
        properties: { [covered]: 'x', [uncovered]: 'y' },
        provisionedBy: 'sdk',
      },
    ]);

    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text, 'no warning names the inert preference').toContain('had no effect');
    // BOTH halves: which property was ignored, and which one caused it. Naming
    // only the first leaves the user with no action to take.
    expect(text).toContain(covered);
    expect(text).toContain(uncovered);
    // And the remedy is to WIDEN the preference, not to drop it.
    expect(text).toContain('--prefer-sdk-route');
    // The two must appear in their OWN roles. `toContain(uncovered)` alone is
    // satisfied by the sibling appearing anywhere in the sentence, so review
    // measured the predicate `drops ∩ allowSet` reduced to plain `drops` and
    // this case stayed green — the warning then tells a user that a property
    // they NEVER named had no effect, which is the false-warn class #2750
    // retired, re-spelled.
    expect(
      text,
      'the warning names a property the user never passed — the allow-set filter is gone'
    ).toMatch(new RegExp(`had no effect for [^—]*\\b${covered}\\b`));
    expect(
      text.slice(0, text.indexOf('—')),
      'the uncovered sibling is being reported as the victim, not the cause'
    ).not.toContain(uncovered);
  });

  it('stays silent when the preference COVERS every drop on the resource', () => {
    // Then the resource really does stay on the SDK provider and the values
    // really are unwritten — the flag worked, and this warning would be false.
    const { registry, warn, resourceType, covered, uncovered } = twoDrops();
    registry.allowUnsupportedProperties([
      `${resourceType}:${covered}`,
      `${resourceType}:${uncovered}`,
    ]);

    registry.validateResourceProperties([
      {
        logicalId: 'Target',
        resourceType,
        properties: { [covered]: 'x', [uncovered]: 'y' },
        provisionedBy: 'sdk',
      },
    ]);

    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text, 'warned that the preference was inert when it was honoured').not.toContain(
      'had no effect'
    );
  });
});
