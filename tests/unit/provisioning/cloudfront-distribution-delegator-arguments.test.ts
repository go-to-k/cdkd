/**
 * The `CloudFrontDistributionProvider` class keeps one delegator per method
 * whose body moved into `src/provisioning/providers/cloudfront-distribution/`
 * (go-to-k/cdkd#5835): each is `return f.call(this, <its own parameters>)`. A
 * delegator that swaps two same-typed arguments, drops a trailing optional one,
 * or drops the result still type-checks.
 *
 * Every companion module is replaced by spies wrapping its real exports, so
 * each case calls the method through the instance, as the moved bodies do,
 * and asserts the moved function received the instance as `this`, every
 * argument in order (by identity), and that its result came back unchanged.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vite-plus/test';

const { spyAll, mockSend } = vi.hoisted(() => ({
  spyAll: (actual: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value,
      ])
    ),
  mockSend: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFront: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock(
  '../../../src/provisioning/providers/cloudfront-distribution/convert.js',
  async (importOriginal) => spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock(
  '../../../src/provisioning/providers/cloudfront-distribution/core.js',
  async (importOriginal) => spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock(
  '../../../src/provisioning/providers/cloudfront-distribution/delete.js',
  async (importOriginal) => spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock(
  '../../../src/provisioning/providers/cloudfront-distribution/read-state.js',
  async (importOriginal) => spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock(
  '../../../src/provisioning/providers/cloudfront-distribution/tags.js',
  async (importOriginal) => spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock(
  '../../../src/provisioning/providers/cloudfront-distribution/update-config.js',
  async (importOriginal) => spyAll(await importOriginal<Record<string, unknown>>())
);

import { GetDistributionCommand } from '@aws-sdk/client-cloudfront';
import { CloudFrontDistributionProvider } from '../../../src/provisioning/providers/cloudfront-distribution-provider.js';
import * as convert from '../../../src/provisioning/providers/cloudfront-distribution/convert.js';
import * as core from '../../../src/provisioning/providers/cloudfront-distribution/core.js';
import * as deleteModule from '../../../src/provisioning/providers/cloudfront-distribution/delete.js';
import * as readState from '../../../src/provisioning/providers/cloudfront-distribution/read-state.js';
import * as tags from '../../../src/provisioning/providers/cloudfront-distribution/tags.js';
import * as updateConfig from '../../../src/provisioning/providers/cloudfront-distribution/update-config.js';

const MODULES: Record<string, Record<string, unknown>> = {
  convert,
  core,
  delete: deleteModule,
  'read-state': readState,
  tags,
  'update-config': updateConfig,
};

/** [companion module, class method, moved function, parameter count]. */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
  ['convert', 'applyQuantityAtPath', 'applyQuantityAtPath', 2],
  ['convert', 'convertCacheBehavior', 'convertCacheBehavior', 1],
  ['convert', 'convertOrigin', 'convertOrigin', 1],
  ['convert', 'convertToCfnFormat', 'convertToCfnFormat', 1],
  ['convert', 'convertToSdkFormat', 'convertToSdkFormat', 1],
  ['convert', 'revertCacheBehavior', 'revertCacheBehavior', 1],
  ['convert', 'revertOrigin', 'revertOrigin', 1],
  ['convert', 'unwrapQuantity', 'unwrapQuantity', 1],
  ['convert', 'unwrapQuantityAtPath', 'unwrapQuantityAtPath', 2],
  ['convert', 'wrapWithQuantity', 'wrapWithQuantity', 1],
  ['core', 'create', 'create', 4],
  ['core', 'orphanSearchHint', 'orphanSearchHint', 2],
  ['core', 'update', 'update', 6],
  ['core', 'wrapCaughtError', 'wrapCaughtError', 3],
  ['delete', 'delete', 'deleteImpl', 5],
  ['delete', 'settleDistribution', 'settleDistribution', 2],
  ['delete', 'waitForDistributionStable', 'waitForDistributionStable', 2],
  ['read-state', 'getAttribute', 'getAttribute', 3],
  ['read-state', 'getDriftUnknownPaths', 'getDriftUnknownPaths', 1],
  ['read-state', 'getDriftUnorderedPaths', 'getDriftUnorderedPaths', 1],
  ['read-state', 'import', 'importImpl', 1],
  ['read-state', 'readCurrentState', 'readCurrentState', 4],
  ['tags', 'applyTagDiff', 'applyTagDiff', 7],
  ['tags', 'computeTagDiff', 'computeTagDiff', 4],
  ['tags', 'toSdkTags', 'toSdkTags', 1],
  ['update-config', 'completeRequiredUpdateFields', 'completeRequiredUpdateFields', 1],
  ['update-config', 'mergeUpdateConfig', 'mergeUpdateConfig', 4],
];

describe('CloudFrontDistributionProvider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('covers every class method and every companion export, once each', () => {
    const methods = Object.getOwnPropertyNames(CloudFrontDistributionProvider.prototype).filter(
      (name) => name !== 'constructor'
    );
    expect([...methods].sort()).toEqual(CASES.map(([, method]) => method).sort());
    const exported = Object.entries(MODULES).flatMap(([mod, exports]) =>
      Object.keys(exports).map((fn) => `${mod}:${fn}`)
    );
    expect(exported.sort()).toEqual(CASES.map(([mod, , fn]) => `${mod}:${fn}`).sort());
  });

  it.each(CASES)(
    '%s: %s forwards the instance, every argument in order, and the result',
    (mod, method, fn, arity) => {
      const provider = new CloudFrontDistributionProvider();
      const spy = MODULES[mod]![fn] as Mock;
      const result = { resultOf: method };
      spy.mockImplementationOnce(() => result);
      const args = Array.from({ length: arity }, (_, i) => ({ argument: i }));
      const delegator = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ]!;
      expect(delegator.apply(provider, args)).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.contexts[0]).toBe(provider);
      const received = spy.mock.calls[0]!;
      expect(received).toHaveLength(arity);
      received.forEach((arg, i) => expect(arg, `argument ${i}`).toBe(args[i]));
    }
  );

  it('a moved body sends through the instance client the constructor set', async () => {
    const provider = new CloudFrontDistributionProvider();
    mockSend.mockResolvedValueOnce({ Distribution: { DomainName: 'd111.cloudfront.net' } });
    await expect(
      provider.getAttribute('E123', 'AWS::CloudFront::Distribution', 'DomainName')
    ).resolves.toBe('d111.cloudfront.net');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const command = mockSend.mock.calls[0]![0] as unknown;
    expect(command).toBeInstanceOf(GetDistributionCommand);
    expect((command as GetDistributionCommand).input).toEqual({ Id: 'E123' });
  });
});
