/**
 * The `KinesisStreamProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/providers/kinesis/` (go-to-k/cdkd#5835): each is
 * `return f.call(this, <its own parameters>)`. A delegator that swaps two
 * same-typed arguments, drops a trailing optional one, or drops the result
 * still type-checks.
 *
 * Every companion module is replaced by spies wrapping its real exports, so
 * each case calls the method through the instance, as the moved bodies do,
 * and asserts the moved function received the instance as `this`, every
 * argument in order (by identity), and that its result came back unchanged.
 */
import { describe, it, expect, vi, beforeEach, type Mock } from 'vite-plus/test';

const { spyAll } = vi.hoisted(() => ({
  spyAll: (actual: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(
      Object.entries(actual).map(([key, value]) => [
        key,
        typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value,
      ])
    ),
}));

vi.mock('../../../src/provisioning/providers/kinesis/client.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/kinesis/create.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/kinesis/delete.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/kinesis/identity.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/kinesis/import.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/kinesis/read-state.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/kinesis/update.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);

import { KinesisClient } from '@aws-sdk/client-kinesis';
import { KinesisStreamProvider } from '../../../src/provisioning/providers/kinesis-provider.js';
import * as client from '../../../src/provisioning/providers/kinesis/client.js';
import * as create from '../../../src/provisioning/providers/kinesis/create.js';
import * as deleteModule from '../../../src/provisioning/providers/kinesis/delete.js';
import * as identity from '../../../src/provisioning/providers/kinesis/identity.js';
import * as importModule from '../../../src/provisioning/providers/kinesis/import.js';
import * as readState from '../../../src/provisioning/providers/kinesis/read-state.js';
import * as update from '../../../src/provisioning/providers/kinesis/update.js';

const MODULES: Record<string, Record<string, unknown>> = {
  client,
  create,
  delete: deleteModule,
  identity,
  import: importModule,
  'read-state': readState,
  update,
};

/** [companion module, class method, moved function, parameter count]. */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
  ['client', 'getClient', 'getClient', 0],
  ['client', 'getCreateClient', 'getCreateClient', 0],
  ['client', 'getOpenShardCount', 'getOpenShardCount', 1],
  ['client', 'readStreamArnIfExists', 'readStreamArnIfExists', 1],
  ['client', 'readStreamStatusForDelete', 'readStreamStatusForDelete', 1],
  ['client', 'resolveStreamArn', 'resolveStreamArn', 1],
  ['client', 'waitForStreamActive', 'waitForStreamActive', 2],
  ['client', 'wrapCaughtError', 'wrapCaughtError', 3],
  ['create', 'create', 'create', 4],
  ['delete', 'delete', 'deleteImpl', 5],
  ['identity', 'isSameResource', 'isSameResource', 4],
  ['identity', 'resourceIdentity', 'resourceIdentity', 3],
  ['import', 'import', 'importImpl', 1],
  ['read-state', 'canonicalizeDesiredProperties', 'canonicalizeDesiredProperties', 2],
  ['read-state', 'getDriftUnorderedPaths', 'getDriftUnorderedPaths', 1],
  ['read-state', 'readCurrentState', 'readCurrentState', 4],
  ['read-state', 'readUnsettled', 'readUnsettled', 7],
  ['read-state', 'unsettledInTransition', 'unsettledInTransition', 4],
  ['update', 'applyTagDiff', 'applyTagDiff', 6],
  ['update', 'effectiveMetricsProperties', 'effectiveMetricsProperties', 2],
  ['update', 'reconcileDistributionStrategy', 'reconcileDistributionStrategy', 7],
  ['update', 'update', 'update', 6],
  ['update', 'warnUndeclaredLiveMetrics', 'warnUndeclaredLiveMetrics', 4],
];

describe('KinesisStreamProvider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('covers every class method and every companion export, once each', () => {
    const methods = Object.getOwnPropertyNames(KinesisStreamProvider.prototype).filter(
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
      const provider = new KinesisStreamProvider();
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

  it('getClient and getCreateClient each build a KinesisClient once, and not the same one', () => {
    const provider = new KinesisStreamProvider();
    const plain = provider.getClient();
    const forCreate = provider.getCreateClient();
    expect(plain).toBeInstanceOf(KinesisClient);
    expect(forCreate).toBeInstanceOf(KinesisClient);
    expect(provider.getClient()).toBe(plain);
    expect(provider.getCreateClient()).toBe(forCreate);
    expect(forCreate).not.toBe(plain);
  });
});
