/**
 * Issue #2792 — the accepted-drop warn must not tell a type with NO Cloud
 * Control route to "remove the override to route this resource via Cloud
 * Control API": for such a type, removing it makes the drop actionable and the
 * next deploy REFUSES at pre-flight (`buildUnroutableSilentDropMessage`)
 * instead of routing. Two conditions make a type unroutable, and each gets a
 * case: a provider declaring `disableCcApiFallback`, and a NON_PROVISIONABLE
 * type. No real type is both NON_PROVISIONABLE and carries a silent drop today
 * (that is the mid-transition window the guard also covers), so that arm
 * marks a real silent-drop type NON_PROVISIONABLE through the module mock.
 */
import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import type { ResourceProvider } from '../../../src/types/resource.js';

const extraNonProvisionable = vi.hoisted(() => new Set<string>());

vi.mock('../../../src/provisioning/unsupported-types.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/provisioning/unsupported-types.js')>();
  return {
    ...actual,
    isNonProvisionable: (resourceType: string): boolean =>
      extraNonProvisionable.has(resourceType) || actual.isNonProvisionable(resourceType),
  };
});

import { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.js';

function pickDrop(createOnly: boolean): { resourceType: string; property: string } {
  for (const [resourceType, cov] of [...PROPERTY_COVERAGE_BY_TYPE].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    for (const property of [...cov.silentDrop.keys()].sort((a, b) => a.localeCompare(b))) {
      if (cov.createOnlyDrops.has(property) === createOnly) return { resourceType, property };
    }
  }
  throw new Error(`no ${createOnly ? '' : 'non-'}create-only silent drop -- use a synthetic fixture`);
}

function stubProvider(disableCcApiFallback: boolean): ResourceProvider {
  return {
    disableCcApiFallback,
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as ResourceProvider;
}

function warnFor(
  fx: { resourceType: string; property: string },
  setup: (registry: ProviderRegistry) => void
): string {
  const registry = new ProviderRegistry();
  const warn = vi.fn();
  (registry as unknown as { logger: Record<string, unknown> }).logger = {
    info: vi.fn(),
    warn,
    debug: vi.fn(),
    error: vi.fn(),
  };
  setup(registry);
  registry.allowUnsupportedProperties([`${fx.resourceType}:${fx.property}`]);
  registry.reportSilentDropDecisions([
    {
      logicalId: 'Res',
      resourceType: fx.resourceType,
      properties: { [fx.property]: 'x' },
      provisionedBy: 'sdk',
    },
  ]);
  expect(warn).toHaveBeenCalledTimes(1);
  return warn.mock.calls[0]![0] as string;
}

describe('accepted-drop warn on a type with no Cloud Control route (issue #2792)', () => {
  beforeEach(() => {
    extraNonProvisionable.clear();
  });

  const cases: Array<{
    name: string;
    createOnly: boolean;
    setup: (fx: { resourceType: string }) => (registry: ProviderRegistry) => void;
    reason: string;
  }> = [
    {
      name: 'a provider declaring disableCcApiFallback, non-create-only drop',
      createOnly: false,
      setup: (fx) => (r) => r.register(fx.resourceType, stubProvider(true)),
      reason: 'disableCcApiFallback',
    },
    {
      name: 'a provider declaring disableCcApiFallback, create-only drop',
      createOnly: true,
      setup: (fx) => (r) => r.register(fx.resourceType, stubProvider(true)),
      reason: 'disableCcApiFallback',
    },
    {
      name: 'a NON_PROVISIONABLE type, non-create-only drop',
      createOnly: false,
      setup: (fx) => {
        extraNonProvisionable.add(fx.resourceType);
        return (r) => r.register(fx.resourceType, stubProvider(false));
      },
      reason: 'NON_PROVISIONABLE',
    },
    {
      name: 'a NON_PROVISIONABLE type, create-only drop',
      createOnly: true,
      setup: (fx) => {
        extraNonProvisionable.add(fx.resourceType);
        return (r) => r.register(fx.resourceType, stubProvider(false));
      },
      reason: 'NON_PROVISIONABLE',
    },
  ];

  for (const c of cases) {
    it(`says removing the override is refused, and prescribes neither remedy, for ${c.name}`, () => {
      const fx = pickDrop(c.createOnly);
      const msg = warnFor(fx, c.setup(fx));
      expect(msg).toContain(`${fx.property} will be silently dropped`);
      expect(msg).toContain('cannot be routed via Cloud Control API');
      expect(msg).toContain(c.reason);
      expect(msg).toContain('refuse at pre-flight instead of rerouting');
      // Both remedies are false here: the reroute is refused, and a recreate
      // lands on the same SDK provider that drops the property.
      expect(msg).not.toContain('Remove the override');
      expect(msg).not.toContain('recreating the resource');
    });
  }

  // The controls: the same registered provider WITHOUT the opt-out keeps each
  // arm's own remedy, so the cases above cannot pass under an implementation
  // that dropped the remedies for every registered provider.
  it('keeps the flag-removal remedy for a registered provider that allows the fallback', () => {
    const fx = pickDrop(false);
    const msg = warnFor(fx, (r) => r.register(fx.resourceType, stubProvider(false)));
    expect(msg).toContain(`Remove the override for ${fx.property}`);
    expect(msg).not.toContain('cannot be routed via Cloud Control API');
  });

  it('keeps the recreate sentence for a create-only drop on a provider that allows the fallback', () => {
    const fx = pickDrop(true);
    const msg = warnFor(fx, (r) => r.register(fx.resourceType, stubProvider(false)));
    expect(msg).toContain('can only be applied by recreating the resource');
    expect(msg).not.toContain('cannot be routed via Cloud Control API');
  });

  it('names the pronoun by count when two drops are accepted', () => {
    let pair: { resourceType: string; propA: string; propB: string } | undefined;
    for (const [resourceType, cov] of PROPERTY_COVERAGE_BY_TYPE) {
      if (cov.silentDrop.size >= 2) {
        const [propA, propB] = [...cov.silentDrop.keys()].sort((a, b) => a.localeCompare(b));
        pair = { resourceType, propA: propA!, propB: propB! };
        break;
      }
    }
    if (pair === undefined) throw new Error('no type with two silent drops');
    const registry = new ProviderRegistry();
    const warn = vi.fn();
    (registry as unknown as { logger: Record<string, unknown> }).logger = {
      info: vi.fn(),
      warn,
      debug: vi.fn(),
      error: vi.fn(),
    };
    registry.register(pair.resourceType, stubProvider(true));
    registry.allowUnsupportedProperties([
      `${pair.resourceType}:${pair.propA}`,
      `${pair.resourceType}:${pair.propB}`,
    ]);
    registry.reportSilentDropDecisions([
      {
        logicalId: 'Res',
        resourceType: pair.resourceType,
        properties: { [pair.propA]: 'x', [pair.propB]: 'y' },
        provisionedBy: 'sdk',
      },
    ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0] as string).toContain('applies them to this type');
  });
});
