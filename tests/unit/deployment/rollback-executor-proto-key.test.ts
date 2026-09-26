/**
 * Issue [#2776](https://github.com/go-to-k/cdkd/issues/2776): the rollback
 * replay's property walk keeps a `__proto__` key.
 *
 * `resolveReplayProps` rebuilds every replayed bag before it reaches the
 * provider, and the journal and state record it reads are `JSON.parse`d, which
 * makes a property literally named `__proto__` an ORDINARY own key. Rebuilt
 * onto a `{}` literal with `out[k] = v`, that one key ran `Object.prototype`'s
 * setter instead: the key was silently ABSENT from the bag `provider.update()`
 * / `create()` received, with no error and no warning. The resolver's own
 * object walk had the same defect one layer up and was fixed by issue #2767;
 * this is the replay twin.
 *
 * Every bag here is built with `JSON.parse`, never an object literal:
 * `{ __proto__: 'x' }` SETS the prototype, so a literal would make each case
 * vacuous (nothing for the walk to drop).
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayRollback,
  replayFailedOperations,
  type CompletedOperation,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { ResourceState } from '../../../src/types/state.js';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({}),
  setAwsClients: vi.fn(),
  AwsClients: vi.fn(),
}));

const TYPE = 'Custom::Thing';

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
  child: () => silentLogger,
} as unknown as RollbackExecutorContext['logger'];

function res(overrides: Partial<ResourceState> = {}): ResourceState {
  return {
    physicalId: 'phys',
    resourceType: TYPE,
    properties: {},
    attributes: {},
    dependencies: [],
    ...overrides,
  };
}

function makeCtx(provider: { update?: unknown; create?: unknown; delete?: unknown }) {
  const ctx: RollbackExecutorContext = {
    region: 'us-east-1',
    logger: silentLogger,
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as unknown as RollbackExecutorContext['providerRegistry'],
    recordEvent: () => {},
  };
  return ctx;
}

/** A bag carrying `__proto__` at the TOP level and one level down. */
const bag = (marker: string): Record<string, unknown> =>
  JSON.parse(
    `{"__proto__":"top-${marker}","Nested":{"__proto__":"inner-${marker}","Ordinary":"o"},` +
      `"List":[{"__proto__":"in-array-${marker}"}]}`
  ) as Record<string, unknown>;

/**
 * The regression is a silent OMISSION, so presence is asserted by own-key
 * membership and the key list. A bare `bag['__proto__']` read is not enough:
 * on a plain object that dropped the key it answers `Object.prototype`, which
 * is truthy and would mask the loss.
 */
function expectProtoKept(received: unknown, marker: string): void {
  const top = received as Record<string, unknown>;
  expect(Object.keys(top).sort()).toEqual(['List', 'Nested', '__proto__']);
  expect(Object.hasOwn(top, '__proto__')).toBe(true);
  expect(top['__proto__']).toBe(`top-${marker}`);

  const nested = top['Nested'] as Record<string, unknown>;
  expect(Object.keys(nested).sort()).toEqual(['Ordinary', '__proto__']);
  expect(nested['__proto__']).toBe(`inner-${marker}`);

  const inArray = (top['List'] as Record<string, unknown>[])[0]!;
  expect(Object.hasOwn(inArray, '__proto__')).toBe(true);
  expect(inArray['__proto__']).toBe(`in-array-${marker}`);

  // The rebuilt node keeps an ORDINARY prototype, the same choice the
  // resolver's walk made (issue #2767): the bag goes to every provider, and a
  // null-prototype object throws where a provider coerces it (`String(bag)`,
  // a template literal) and has no `.hasOwnProperty()` method to call.
  expect(Object.getPrototypeOf(top)).toBe(Object.prototype);
  expect(Object.getPrototypeOf(nested)).toBe(Object.prototype);
  expect(String(top)).toBe('[object Object]');
}

describe('rollback replay keeps a __proto__ property key (#2776)', () => {
  it('revert: both the desired and the previous bag handed to update() keep the key', async () => {
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const ctx = makeCtx({ update });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'phys',
        previousState: res({ properties: bag('desired') }),
      },
    ];
    // Differs from previousState, so the op is a real revert rather than
    // `skip-already-done`.
    const state: Record<string, ResourceState> = { R: res({ properties: bag('current') }) };

    await replayRollback(ops, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expectProtoKept(update.mock.calls[0]![3], 'desired');
    // The PREVIOUS side is resolved through the same walk (a patch provider
    // diffs the two), so it is pinned too.
    expectProtoKept(update.mock.calls[0]![4], 'current');
  });

  it('--revert-failed: the desired and the attempted bag handed to update() keep the key', async () => {
    // The third caller of the same walk (`replayFailedOperations`), pinned so
    // every arm that resolves a replay bag is driven, not only reasoned about.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const ctx = makeCtx({ update });
    const failed: FailedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'phys',
        previousState: res({ properties: bag('desired') }),
        attemptedProperties: bag('attempted'),
      },
    ];
    const state: Record<string, ResourceState> = { R: res({ properties: bag('attempted') }) };

    await replayFailedOperations(failed, state, 'S', ctx);

    expect(update).toHaveBeenCalledTimes(1);
    expectProtoKept(update.mock.calls[0]![3], 'desired');
    expectProtoKept(update.mock.calls[0]![4], 'attempted');
  });

  it('an OBJECT-valued __proto__ stays data and does not become the bag prototype', async () => {
    // The sharper pre-fix shape: `out['__proto__'] = {Injected: 'x'}` did not
    // merely drop the key, it REPLACED the rebuilt bag's prototype, so a
    // provider reading `props.Injected` got an inherited value the user never
    // wrote at that level.
    const update = vi.fn().mockResolvedValue({ physicalId: 'phys' });
    const ctx = makeCtx({ update });
    const injected = (): Record<string, unknown> =>
      JSON.parse('{"__proto__":{"Injected":"x"},"Ordinary":"o"}') as Record<string, unknown>;
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'phys',
        previousState: res({ properties: injected() }),
      },
    ];
    const state: Record<string, ResourceState> = {
      R: res({ properties: { Ordinary: 'changed' } }),
    };

    await replayRollback(ops, state, 'S', ctx);

    const desired = update.mock.calls[0]![3] as Record<string, unknown>;
    expect(Object.getPrototypeOf(desired)).toBe(Object.prototype);
    expect(desired['Injected']).toBeUndefined();
    expect(Object.hasOwn(desired, '__proto__')).toBe(true);
    expect(desired['__proto__']).toEqual({ Injected: 'x' });
  });

  it('reverse-replacement: the bag handed to the replay create() keeps the key', async () => {
    const create = vi.fn().mockResolvedValue({ physicalId: 'old-phys' });
    const del = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({ create, delete: del });
    const ops: CompletedOperation[] = [
      {
        logicalId: 'R',
        changeType: 'UPDATE',
        resourceType: TYPE,
        physicalId: 'new-phys',
        previousState: res({ physicalId: 'old-phys', properties: bag('recreate') }),
      },
    ];
    const state: Record<string, ResourceState> = {
      R: res({ physicalId: 'new-phys', properties: bag('current') }),
    };

    await replayRollback(ops, state, 'S', ctx);

    expect(create).toHaveBeenCalledTimes(1);
    expectProtoKept(create.mock.calls[0]![2], 'recreate');
  });
});
