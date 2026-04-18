import { describe, it, expect, vi, beforeEach } from 'vitest';

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
});
