/**
 * The `LambdaFunctionProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/providers/lambda-function/` (go-to-k/cdkd#5835):
 * each is `return f.call(this, <its own parameters>)`. A delegator that swaps
 * two same-typed arguments, drops one, calls a sibling's body, or drops the
 * result still type-checks.
 *
 * Every companion module is replaced by spies here, so each case observes the
 * hand-off itself: the moved function is called once, on the instance, with
 * every argument in order, and the delegator returns what it returned. The
 * arity in the table is the moved function's own parameter count (minus
 * `this`), not the delegator's, so a delegator that drops its last parameter
 * fails here instead of shrinking the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ lambda: { send: vi.fn() }, ec2: { send: vi.fn() } }),
}));

/** Every exported function of a companion module, replaced by a spy. */
async function spyAll(load: () => Promise<Record<string, unknown>>) {
  const actual = await load();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
}

vi.mock('../../../src/provisioning/providers/lambda-function/create.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/errors.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/update.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/delete.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/vpc.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/code.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/identity.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/lambda-function/read-state.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import * as create from '../../../src/provisioning/providers/lambda-function/create.js';
import * as errors from '../../../src/provisioning/providers/lambda-function/errors.js';
import * as update from '../../../src/provisioning/providers/lambda-function/update.js';
import * as del from '../../../src/provisioning/providers/lambda-function/delete.js';
import * as vpc from '../../../src/provisioning/providers/lambda-function/vpc.js';
import * as code from '../../../src/provisioning/providers/lambda-function/code.js';
import * as identity from '../../../src/provisioning/providers/lambda-function/identity.js';
import * as readState from '../../../src/provisioning/providers/lambda-function/read-state.js';

type Module = Record<string, unknown>;

/** [class method, companion module, moved function, the moved function's arity]. */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['create', create, 'create', 4],
  ['wrapMaskedError', errors, 'wrapMaskedError', 3],
  ['applyPostCreateConfig', create, 'applyPostCreateConfig', 2],
  ['putRuntimeManagementConfig', create, 'putRuntimeManagementConfig', 2],
  ['waitForLatestPublishedSettled', create, 'waitForLatestPublishedSettled', 3],
  ['wrapStatusReasonError', errors, 'wrapStatusReasonError', 3],
  ['putFunctionScalingConfig', create, 'putFunctionScalingConfig', 3],
  ['update', update, 'update', 6],
  ['delete', del, 'deleteImpl', 5],
  ['waitForFunctionGone', del, 'waitForFunctionGone', 2],
  ['buildVpcConfig', vpc, 'buildVpcConfig', 1],
  ['buildVpcConfigForUpdate', vpc, 'buildVpcConfigForUpdate', 2],
  ['normalizeEnvironmentForUpdate', vpc, 'normalizeEnvironmentForUpdate', 1],
  ['hasVpcConfig', vpc, 'hasVpcConfig', 1],
  ['applyTagDiff', update, 'applyTagDiff', 8],
  ['waitForFunctionUpdated', update, 'waitForFunctionUpdated', 4],
  ['waitForLambdaUpdateCompleted', update, 'waitForLambdaUpdateCompleted', 1],
  ['cleanupLambdaEnis', del, 'cleanupLambdaEnis', 2],
  ['deleteEniWithRetry', del, 'deleteEniWithRetry', 3],
  ['listLambdaEnis', del, 'listLambdaEnis', 1],
  ['buildCode', code, 'buildCode', 2],
  ['createZipFromInlineCode', code, 'createZipFromInlineCode', 2],
  ['crc32', code, 'crc32', 1],
  ['logFunctionGone', del, 'logFunctionGone', 3],
  ['isSameResource', identity, 'isSameResource', 4],
  ['resourceIdentity', identity, 'resourceIdentity', 3],
  ['readFunctionIfExists', identity, 'readFunctionIfExists', 1],
  ['getAttribute', identity, 'getAttribute', 3],
  ['readUnsettled', readState, 'readUnsettled', 4],
  ['unsettledInTransition', readState, 'unsettledInTransition', 4],
  ['readCurrentState', readState, 'readCurrentState', 3],
  ['import', identity, 'importImpl', 1],
];

const allSpies = (): ReturnType<typeof vi.fn>[] =>
  [create, errors, update, del, vpc, code, identity, readState].flatMap((m) =>
    Object.values(m as Module).filter((v): v is ReturnType<typeof vi.fn> => vi.isMockFunction(v))
  );

describe('LambdaFunctionProvider delegators hand every argument to the moved body', () => {
  beforeEach(() => {
    for (const spy of allSpies()) spy.mockReset();
  });

  it('covers every delegator the class has', () => {
    // A method whose body is a `.call(this, ...)` hand-off is a delegator; a
    // new one must be added to the table above.
    const own = Object.getOwnPropertyNames(LambdaFunctionProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\breturn [\w$.]+\.call\(\s*this\b/.test(
          String((LambdaFunctionProvider.prototype as unknown as Module)[name])
        )
    );
    // The class's own non-delegator methods stay in the class.
    expect(Object.getOwnPropertyNames(LambdaFunctionProvider.prototype).length).toBe(
      own.length + 3 // constructor, sleep, getDriftUnknownPaths
    );
    expect(own.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} forwards ${arity} argument(s) in order to ${fn} and returns its result`, () => {
      const provider = new LambdaFunctionProvider();
      const target = mod[fn] as ReturnType<typeof vi.fn>;
      const result = Symbol(`${fn} result`);
      target.mockReturnValue(result);
      const args = Array.from({ length: arity }, (_, i) => Symbol(`${method} arg ${i}`));

      const returned = (provider as unknown as Record<string, (...a: unknown[]) => unknown>)[
        method
      ]!(...args);

      expect(returned).toBe(result);
      expect(target).toHaveBeenCalledTimes(1);
      expect(target.mock.calls[0]).toEqual(args);
      expect(target.mock.contexts[0]).toBe(provider);
      // No other moved body ran: the delegator reached its own function only.
      for (const spy of allSpies()) if (spy !== target) expect(spy).not.toHaveBeenCalled();
    });
  }
});
