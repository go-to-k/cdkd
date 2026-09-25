/**
 * Issue #3713: `findRoutableUnrecognizedProperties` refuses to route a type
 * Cloud Control has no handlers for (`NON_PROVISIONABLE`) even when the
 * generated coverage table still calls it routable — the mid-transition window
 * where the Tier 3 regen has not run yet. No shipped type sits in that window
 * (every NON_PROVISIONABLE provider also declares `disableCcApiFallback`), so
 * the arm is reachable only by mocking the Tier 3 lookup, which is file-scoped
 * in Vitest and so lives in its own file.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

/** A type the coverage table calls routable, pretended NON_PROVISIONABLE below. */
const FLAGGED = vi.hoisted(() => ({ type: '' }));

vi.mock('../../../src/provisioning/unsupported-types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/provisioning/unsupported-types.js')>();
  return {
    ...actual,
    isNonProvisionable: (resourceType: string) =>
      resourceType === FLAGGED.type || actual.isNonProvisionable(resourceType),
  };
});

import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import {
  PROPERTY_COVERAGE_BY_TYPE,
  findRoutableUnrecognizedProperties,
} from '../../../src/provisioning/property-coverage.js';
import { isNonProvisionable } from '../../../src/provisioning/unsupported-types.js';

const UNKNOWN_PROP = 'CdkdTotallyNewPropertyFromTheFuture';

/** Two routable Tier 1 types: one to flag, one as the unflagged control. */
function pickRoutablePair(): [string, string] {
  const routable = [...PROPERTY_COVERAGE_BY_TYPE]
    .filter(([type, cov]) => !cov.ccRouteUnavailable && !isNonProvisionable(type))
    .map(([type]) => type);
  if (routable.length < 2) throw new Error('fewer than two routable Tier 1 types');
  return [routable[0]!, routable[1]!];
}

describe('findRoutableUnrecognizedProperties on a NON_PROVISIONABLE type (#3713)', () => {
  const [flagged, control] = pickRoutablePair();
  FLAGGED.type = flagged;

  it('routes nothing when the Tier 3 lookup says Cloud Control has no handlers', () => {
    expect(PROPERTY_COVERAGE_BY_TYPE.get(flagged)?.ccRouteUnavailable).toBe(false);
    expect(isNonProvisionable(flagged)).toBe(true);
    expect(findRoutableUnrecognizedProperties(flagged, { [UNKNOWN_PROP]: 1 }, new Set())).toEqual([]);
    // Control: an unflagged routable type still routes the same bag, so the
    // mock did not simply break the predicate.
    expect(findRoutableUnrecognizedProperties(control, { [UNKNOWN_PROP]: 1 }, new Set())).toEqual([
      UNKNOWN_PROP,
    ]);
  });

  it('keeps the resource on the SDK route and warns with the NON_PROVISIONABLE reason', () => {
    const registry = new ProviderRegistry();
    const warn = vi.fn();
    (registry as unknown as { logger: Record<string, unknown> }).logger = {
      info: vi.fn(),
      warn,
      debug: vi.fn(),
      error: vi.fn(),
    };
    registry.register(flagged, { create: vi.fn(), update: vi.fn(), delete: vi.fn() } as never);
    expect(
      registry.getProviderFor({ resourceType: flagged, properties: { [UNKNOWN_PROP]: 1 } }).provisionedBy
    ).toBe('sdk');
    registry.validateResourceProperties([
      { logicalId: 'MyResource', resourceType: flagged, properties: { [UNKNOWN_PROP]: 1 } },
    ]);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(UNKNOWN_PROP));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('cannot be routed via Cloud Control API');
    expect(lines[0]).toContain('NON_PROVISIONABLE');
  });
});
