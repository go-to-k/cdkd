import { describe, it, expect, vi } from 'vite-plus/test';
import {
  makeCanonicalizePropertiesFn,
  makeCreateOnlyEquivalenceFn,
} from '../../../src/provisioning/canonicalize-properties.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

/**
 * The shared diff-time normalizer builder (issue #1591), used by BOTH the
 * deploy engine and `cdkd diff` so the preview cannot narrow differently from
 * the apply.
 *
 * Every branch here is a degradation path, and each must fall back to the
 * properties UNCHANGED — a comparison refinement that can throw would take
 * down a deploy over a nicety.
 */
describe('makeCanonicalizePropertiesFn (#1591)', () => {
  const PROPS = { RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16' };

  it('returns the properties unchanged when no provider is registered', () => {
    const fn = makeCanonicalizePropertiesFn({
      hasProvider: () => false,
      // Mirrors the real registry, which THROWS rather than returning
      // undefined — the probe is what keeps that off the catch path.
      getProvider: () => {
        throw new Error('No provider available for AWS::Nope::Thing');
      },
    });
    expect(fn('AWS::Nope::Thing', PROPS)).toBe(PROPS);
  });

  it('returns the properties unchanged when the provider has no hook', () => {
    const fn = makeCanonicalizePropertiesFn({
      hasProvider: () => true,
      getProvider: () => ({}) as unknown as ResourceProvider,
    });
    expect(fn('AWS::EC2::Route', PROPS)).toBe(PROPS);
  });

  it('delegates to the hook when the provider implements it', () => {
    const hook = vi.fn().mockReturnValue({ narrowed: true });
    const fn = makeCanonicalizePropertiesFn({
      hasProvider: () => true,
      getProvider: () => ({ canonicalizeDesiredProperties: hook }) as unknown as ResourceProvider,
    });
    expect(fn('AWS::EC2::Route', PROPS)).toEqual({ narrowed: true });
    expect(hook).toHaveBeenCalledWith('AWS::EC2::Route', PROPS);
  });

  it('falls back to the properties when the hook THROWS', () => {
    // The load-bearing one: a provider bug must degrade to the pre-#1591
    // comparison, never abort the deploy or the diff.
    const fn = makeCanonicalizePropertiesFn({
      hasProvider: () => true,
      getProvider: () =>
        ({
          canonicalizeDesiredProperties: () => {
            throw new Error('boom');
          },
        }) as unknown as ResourceProvider,
    });
    expect(fn('AWS::EC2::Route', PROPS)).toBe(PROPS);
  });

  it('falls back when the REGISTRY LOOKUP itself throws', () => {
    const fn = makeCanonicalizePropertiesFn({
      hasProvider: () => true,
      getProvider: () => {
        throw new Error('registry exploded');
      },
    });
    expect(fn('AWS::EC2::Route', PROPS)).toBe(PROPS);
  });

  it('treats a hook returning undefined as "unchanged"', () => {
    const fn = makeCanonicalizePropertiesFn({
      hasProvider: () => true,
      getProvider: () =>
        ({ canonicalizeDesiredProperties: () => undefined }) as unknown as ResourceProvider,
    });
    expect(fn('AWS::EC2::Route', PROPS)).toBe(PROPS);
  });
});

/**
 * The createOnly equivalence builder (issue #3769) FAILS CLOSED: every
 * degradation answers `false`, keeping the schema's replacement, because a
 * wrong `true` updates in place what should have been replaced.
 */
describe('makeCreateOnlyEquivalenceFn (#3769)', () => {
  const ctx = { accountId: '111111111111' };
  const registryWith = (provider: Partial<ResourceProvider> | undefined) => ({
    hasProvider: () => provider !== undefined,
    getProvider: () => provider as ResourceProvider,
  });

  it('forwards every argument to the provider hook and returns its true', () => {
    const hook = vi.fn(() => true);
    const fn = makeCreateOnlyEquivalenceFn(registryWith({ createOnlyValuesEquivalent: hook }));

    expect(fn('AWS::Glue::Table', 'CatalogId', undefined, '111111111111', ctx)).toBe(true);
    expect(hook).toHaveBeenCalledWith('AWS::Glue::Table', 'CatalogId', undefined, '111111111111', ctx);
  });

  it('answers false for an unregistered type, a provider without the hook, a throwing hook, and a non-boolean answer', () => {
    expect(makeCreateOnlyEquivalenceFn(registryWith(undefined))('T', 'K', 1, 2, ctx)).toBe(false);
    expect(makeCreateOnlyEquivalenceFn(registryWith({}))('T', 'K', 1, 2, ctx)).toBe(false);
    const throwing = makeCreateOnlyEquivalenceFn(
      registryWith({
        createOnlyValuesEquivalent: () => {
          throw new Error('boom');
        },
      })
    );
    expect(throwing('T', 'K', 1, 2, ctx)).toBe(false);
    const truthy = makeCreateOnlyEquivalenceFn(
      registryWith({ createOnlyValuesEquivalent: (() => 'yes') as never })
    );
    expect(truthy('T', 'K', 1, 2, ctx)).toBe(false);
  });

  it('answers false when getProvider itself throws', () => {
    const fn = makeCreateOnlyEquivalenceFn({
      hasProvider: () => true,
      getProvider: () => {
        throw new Error('no provider');
      },
    });
    expect(fn('T', 'K', 1, 2, ctx)).toBe(false);
  });
});
