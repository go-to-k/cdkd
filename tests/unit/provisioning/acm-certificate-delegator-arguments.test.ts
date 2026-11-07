/**
 * The `ACMCertificateProvider` class keeps one delegator per method whose body
 * moved into `src/provisioning/providers/acm-certificate/` (go-to-k/cdkd#5835):
 * each is `return f.call(this, <its own parameters>)`. A delegator that swaps
 * two same-typed arguments, drops one, calls a sibling's body, or drops the
 * result still type-checks.
 *
 * Every companion module that holds a moved method is replaced by spies here,
 * so each case observes the hand-off itself: the moved function is called
 * once, on the instance, with every argument in order, and the delegator
 * returns what it returned. The arity in the table is the moved function's own
 * parameter count (minus `this`), not the delegator's, so a delegator that
 * drops its last parameter fails here instead of shrinking the call.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({ acm: { send: vi.fn() } }),
}));

/** Every exported function of a companion module, replaced by a spy. */
async function spyAll(load: () => Promise<Record<string, unknown>>) {
  const actual = await load();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
}

vi.mock('../../../src/provisioning/providers/acm-certificate/create.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/acm-certificate/update.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/acm-certificate/delete.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/acm-certificate/read-state.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/acm-certificate/wait.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import * as create from '../../../src/provisioning/providers/acm-certificate/create.js';
import * as update from '../../../src/provisioning/providers/acm-certificate/update.js';
import * as del from '../../../src/provisioning/providers/acm-certificate/delete.js';
import * as readState from '../../../src/provisioning/providers/acm-certificate/read-state.js';
import * as wait from '../../../src/provisioning/providers/acm-certificate/wait.js';

type Module = Record<string, unknown>;

/** [class method, companion module, moved function, the moved function's arity]. */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['create', create, 'create', 4],
  ['cleanupRequestedCertificate', create, 'cleanupRequestedCertificate', 4],
  ['update', update, 'update', 6],
  ['updateTags', update, 'updateTags', 5],
  ['delete', del, 'deleteImpl', 5],
  ['readCurrentState', readState, 'readCurrentState', 4],
  ['import', readState, 'importImpl', 1],
  ['waitForCertificateIssued', wait, 'waitForCertificateIssued', 4],
  ['writeValidationRecords', wait, 'writeValidationRecords', 6],
  ['renderValidationOptions', wait, 'renderValidationOptions', 1],
];

const allSpies = (): ReturnType<typeof vi.fn>[] =>
  [create, update, del, readState, wait].flatMap((m) =>
    Object.values(m as Module).filter((v): v is ReturnType<typeof vi.fn> => vi.isMockFunction(v))
  );

describe('ACMCertificateProvider delegators hand every argument to the moved body', () => {
  beforeEach(() => {
    for (const spy of allSpies()) spy.mockReset();
  });

  it('covers every delegator the class has', () => {
    // A method whose body is a `.call(this, ...)` hand-off is a delegator; a
    // new one must be added to the table above.
    const own = Object.getOwnPropertyNames(ACMCertificateProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\breturn [\w$.]+\.call\(\s*this\b/.test(
          String((ACMCertificateProvider.prototype as unknown as Module)[name])
        )
    );
    // The class's own non-delegator methods stay in the class.
    expect(Object.getOwnPropertyNames(ACMCertificateProvider.prototype).length).toBe(
      // constructor, wrapCaughtError, regionOfArn, getAttribute,
      // getDriftUnknownPaths
      own.length + 5
    );
    expect(own.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });

  it('every moved function the companions export is reached by a delegator', () => {
    // A companion function no delegator names would be dead code, or a body
    // reached around the class.
    for (const mod of [create, update, del, readState, wait] as Module[]) {
      const named = DELEGATORS.filter(([, m]) => m === mod).map(([, , fn]) => fn);
      const exported = Object.keys(mod).filter((k) => vi.isMockFunction(mod[k]));
      expect(exported.sort()).toEqual(named.sort());
    }
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} forwards ${arity} argument(s) in order to ${fn} and returns its result`, () => {
      const provider = new ACMCertificateProvider();
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
