/**
 * The `LogsLogGroupProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/providers/logs-loggroup/` (go-to-k/cdkd#5835):
 * each is `return f.call(this, <its own parameters>)`. A delegator that swaps
 * two same-typed arguments, drops a trailing optional one, or drops the result
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

vi.mock('../../../src/provisioning/providers/logs-loggroup/core.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/logs-loggroup/create.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/logs-loggroup/update.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/logs-loggroup/delete.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/logs-loggroup/identity.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/logs-loggroup/read-state.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);
vi.mock('../../../src/provisioning/providers/logs-loggroup/import.js', async (importOriginal) =>
  spyAll(await importOriginal<Record<string, unknown>>())
);

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';
import * as core from '../../../src/provisioning/providers/logs-loggroup/core.js';
import * as create from '../../../src/provisioning/providers/logs-loggroup/create.js';
import * as update from '../../../src/provisioning/providers/logs-loggroup/update.js';
import * as deleteModule from '../../../src/provisioning/providers/logs-loggroup/delete.js';
import * as identity from '../../../src/provisioning/providers/logs-loggroup/identity.js';
import * as readState from '../../../src/provisioning/providers/logs-loggroup/read-state.js';
import * as importModule from '../../../src/provisioning/providers/logs-loggroup/import.js';

const MODULES: Record<string, Record<string, unknown>> = {
  core,
  create,
  update,
  delete: deleteModule,
  identity,
  'read-state': readState,
  import: importModule,
};

/** [companion module, class method, moved function, parameter count]. */
const CASES: ReadonlyArray<readonly [string, string, string, number]> = [
  ['core', 'generatedCreateName', 'generatedCreateName', 3],
  ['core', 'holderCreatedAt', 'holderCreatedAt', 2],
  ['core', 'lookupNames', 'lookupNames', 2],
  ['core', 'wrapCaughtError', 'wrapCaughtError', 3],
  ['create', 'create', 'create', 4],
  ['delete', 'delete', 'deleteImpl', 5],
  ['delete', 'deleteOnce', 'deleteOnce', 5],
  ['delete', 'logGoneOnDelete', 'logGoneOnDelete', 3],
  ['identity', 'buildArn', 'buildArn', 1],
  ['identity', 'isSameResource', 'isSameResource', 4],
  ['identity', 'readIdentityIfExists', 'readIdentityIfExists', 1],
  ['identity', 'resourceIdentity', 'resourceIdentity', 3],
  ['import', 'import', 'importImpl', 1],
  ['read-state', 'getAttribute', 'getAttribute', 3],
  ['read-state', 'readCurrentState', 'readCurrentState', 3],
  ['update', 'applyUpdate', 'applyUpdate', 6],
  ['update', 'update', 'update', 6],
];

describe('LogsLogGroupProvider delegators hand each argument to the moved body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('covers every class method and every companion export, once each', () => {
    const methods = Object.getOwnPropertyNames(LogsLogGroupProvider.prototype).filter(
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
      const provider = new LogsLogGroupProvider();
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
});
