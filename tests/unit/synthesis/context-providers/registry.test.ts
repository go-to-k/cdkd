import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock all provider constructors to avoid real AWS SDK usage
vi.mock('../../../../src/synthesis/context-providers/az-provider.js', () => ({
  AZContextProvider: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

vi.mock('../../../../src/synthesis/context-providers/ssm-provider.js', () => ({
  SSMContextProvider: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

vi.mock('../../../../src/synthesis/context-providers/hosted-zone-provider.js', () => ({
  HostedZoneContextProvider: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

vi.mock('../../../../src/synthesis/context-providers/vpc-provider.js', () => ({
  VpcContextProvider: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

vi.mock('../../../../src/synthesis/context-providers/cc-api-provider.js', () => ({
  CcApiContextProvider: vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  })),
}));

// Mock logger
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { ContextProviderRegistry } from '../../../../src/synthesis/context-providers/index.js';
import type { MissingContext } from '../../../../src/types/assembly.js';

describe('ContextProviderRegistry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should resolve missing context using registered providers', async () => {
    const registry = new ContextProviderRegistry({ region: 'us-east-1' });

    // Register a custom mock provider
    const mockProvider = { resolve: vi.fn().mockResolvedValue(['us-east-1a', 'us-east-1b']) };
    registry.register('availability-zones', mockProvider);

    const missing: MissingContext[] = [
      {
        key: 'availability-zones:account=123456789012:region=us-east-1',
        provider: 'availability-zones',
        props: { account: '123456789012', region: 'us-east-1' },
      },
    ];

    const results = await registry.resolve(missing);

    expect(results['availability-zones:account=123456789012:region=us-east-1']).toEqual([
      'us-east-1a',
      'us-east-1b',
    ]);
    expect(mockProvider.resolve).toHaveBeenCalledWith({
      region: 'us-east-1',
      account: '123456789012',
    });
  });

  it('should return provider error for unknown provider types', async () => {
    const registry = new ContextProviderRegistry();

    const missing: MissingContext[] = [
      {
        key: 'unknown:key',
        provider: 'unknown-provider-type',
        props: { account: '123456789012', region: 'us-east-1' },
      },
    ];

    const results = await registry.resolve(missing);

    expect(results['unknown:key']).toEqual({
      $providerError: 'Unknown context provider: unknown-provider-type',
      $dontSaveContext: true,
    });
  });

  it('should mark provider errors as transient ($dontSaveContext)', async () => {
    const registry = new ContextProviderRegistry();

    const missing: MissingContext[] = [
      {
        key: 'some:key',
        provider: 'non-existent',
        props: { account: '123456789012', region: 'us-east-1' },
      },
    ];

    const results = await registry.resolve(missing);
    const errorResult = results['some:key'] as Record<string, unknown>;

    expect(errorResult['$dontSaveContext']).toBe(true);
    expect(errorResult['$providerError']).toBeDefined();
  });

  it('should handle provider resolution failures gracefully', async () => {
    const registry = new ContextProviderRegistry();

    // Register a provider that throws
    const failingProvider = {
      resolve: vi.fn().mockRejectedValue(new Error('AWS API call failed')),
    };
    registry.register('failing-provider', failingProvider);

    const missing: MissingContext[] = [
      {
        key: 'fail:key',
        provider: 'failing-provider',
        props: { account: '123456789012', region: 'us-east-1', some: 'prop' },
      },
    ];

    const results = await registry.resolve(missing);

    expect(results['fail:key']).toEqual({
      $providerError: 'AWS API call failed',
      $dontSaveContext: true,
    });
  });

  it('should resolve multiple missing context entries', async () => {
    const registry = new ContextProviderRegistry();

    const azProvider = { resolve: vi.fn().mockResolvedValue(['us-east-1a']) };
    const ssmProvider = { resolve: vi.fn().mockResolvedValue('param-value') };
    registry.register('availability-zones', azProvider);
    registry.register('ssm', ssmProvider);

    const missing: MissingContext[] = [
      {
        key: 'az:key',
        provider: 'availability-zones',
        props: { account: '123456789012', region: 'us-east-1' },
      },
      {
        key: 'ssm:key',
        provider: 'ssm',
        props: { account: '123456789012', region: 'us-east-1', parameterName: '/my/param' },
      },
    ];

    const results = await registry.resolve(missing);

    expect(results['az:key']).toEqual(['us-east-1a']);
    expect(results['ssm:key']).toBe('param-value');
  });

  // Issue #3522: `entry.key` comes from the `JSON.parse`d manifest, where
  // `__proto__` is an ordinary key. Written onto a `{}` literal it ran
  // `Object.prototype`'s setter, so the resolved value was DROPPED (no own key,
  // `JSON.stringify` gave `{}`) and the record's prototype was replaced.
  describe('a manifest context key named __proto__ (#3522)', () => {
    /** One `missing` row; `key` is a VALUE here, so a literal carries `__proto__` intact. */
    function missingRow(key: string, provider: string): MissingContext {
      return { key, provider, props: { account: '123456789012', region: 'us-east-1' } };
    }

    /** The own-key view `ContextStore.save` iterates, plus the serialized record. */
    function ownView(results: Record<string, unknown>): {
      keys: string[];
      value: unknown;
      json: string;
    } {
      return {
        keys: Object.keys(results),
        value: Object.getOwnPropertyDescriptor(results, '__proto__')?.value,
        json: JSON.stringify(results),
      };
    }

    it('stores a resolved value as an OWN key and leaves the prototype alone', async () => {
      const registry = new ContextProviderRegistry();
      registry.register('availability-zones', {
        resolve: vi.fn().mockResolvedValue(['us-east-1a']),
      });

      const results = await registry.resolve([missingRow('__proto__', 'availability-zones')]);

      expect(ownView(results)).toEqual({
        keys: ['__proto__'],
        value: ['us-east-1a'],
        json: '{"__proto__":["us-east-1a"]}',
      });
      // The pre-fix write made the resolved ARRAY the record's prototype.
      expect(Array.isArray(Object.getPrototypeOf(results))).toBe(false);
    });

    it('stores the unknown-provider marker as an OWN key', async () => {
      const registry = new ContextProviderRegistry();

      const results = await registry.resolve([missingRow('__proto__', 'no-such-provider')]);

      expect(ownView(results)).toEqual({
        keys: ['__proto__'],
        value: {
          $providerError: 'Unknown context provider: no-such-provider',
          $dontSaveContext: true,
        },
        json:
          '{"__proto__":{"$providerError":"Unknown context provider: no-such-provider",' +
          '"$dontSaveContext":true}}',
      });
    });

    it('stores the provider-failure marker as an OWN key', async () => {
      const registry = new ContextProviderRegistry();
      registry.register('failing-provider', {
        resolve: vi.fn().mockRejectedValue(new Error('AWS API call failed')),
      });

      const results = await registry.resolve([missingRow('__proto__', 'failing-provider')]);

      expect(ownView(results)).toEqual({
        keys: ['__proto__'],
        value: { $providerError: 'AWS API call failed', $dontSaveContext: true },
        json: '{"__proto__":{"$providerError":"AWS API call failed","$dontSaveContext":true}}',
      });
    });

    it('keeps every key that already stored normally, alongside __proto__', async () => {
      const registry = new ContextProviderRegistry();
      registry.register('availability-zones', {
        resolve: vi.fn().mockResolvedValue(['us-east-1a']),
      });
      const keys = ['toString', 'constructor', 'ordinary:key', '__proto__'];

      const results = await registry.resolve(
        keys.map((key) => missingRow(key, 'availability-zones'))
      );

      expect(Object.keys(results)).toEqual(keys);
      for (const key of keys) {
        expect(Object.getOwnPropertyDescriptor(results, key)?.value).toEqual(['us-east-1a']);
      }
    });
  });
});
