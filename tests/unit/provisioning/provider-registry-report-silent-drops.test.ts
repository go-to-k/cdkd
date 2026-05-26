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
    expect(msg).toContain('--allow-unsupported-properties');
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
    expect(msg).toContain('--allow-unsupported-properties');
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
