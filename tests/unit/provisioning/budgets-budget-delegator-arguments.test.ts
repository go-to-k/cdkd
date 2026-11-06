/**
 * The `BudgetsBudgetProvider` class keeps one delegator per method
 * whose body moved into `src/provisioning/providers/budgets-budget/`
 * (go-to-k/cdkd#5835): each is `return f.call(this, <its own parameters>)`. A
 * delegator that swaps two same-typed arguments, drops one, calls a sibling's
 * body, or drops the result still type-checks.
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
  getAwsClients: () => ({ sts: { send: vi.fn() } }),
}));

/** Every exported function of a companion module, replaced by a spy. */
async function spyAll(load: () => Promise<Record<string, unknown>>) {
  const actual = await load();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
}

vi.mock('../../../src/provisioning/providers/budgets-budget/create.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/budgets-budget/update.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/budgets-budget/delete.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/budgets-budget/read-state.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);

import { BudgetsBudgetProvider } from '../../../src/provisioning/providers/budgets-budget-provider.js';
import * as create from '../../../src/provisioning/providers/budgets-budget/create.js';
import * as update from '../../../src/provisioning/providers/budgets-budget/update.js';
import * as del from '../../../src/provisioning/providers/budgets-budget/delete.js';
import * as readState from '../../../src/provisioning/providers/budgets-budget/read-state.js';

type Module = Record<string, unknown>;

/** [class method, companion module, moved function, the moved function's arity]. */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['create', create, 'create', 4],
  ['update', update, 'update', 6],
  ['readDesiredLists', update, 'readDesiredLists', 4],
  ['addNotificationsOnly', update, 'addNotificationsOnly', 3],
  ['createNotificationOrSubscribers', update, 'createNotificationOrSubscribers', 3],
  ['sendDeleteIdempotent', update, 'sendDeleteIdempotent', 2],
  ['sendCreateIdempotent', update, 'sendCreateIdempotent', 2],
  ['reconcileNotifications', update, 'reconcileNotifications', 4],
  ['reconcileResourceTags', update, 'reconcileResourceTags', 4],
  ['delete', del, 'deleteImpl', 5],
  ['readCurrentState', readState, 'readCurrentState', 4],
  ['listNotifications', readState, 'listNotifications', 2],
  ['listSubscribers', readState, 'listSubscribers', 3],
  ['budgetFromSdk', readState, 'budgetFromSdk', 1],
  ['canonicalizeDriftPair', readState, 'canonicalizeDriftPair', 3],
  ['import', readState, 'importImpl', 1],
];

const allSpies = (): ReturnType<typeof vi.fn>[] =>
  [create, update, del, readState].flatMap((m) =>
    Object.values(m as Module).filter((v): v is ReturnType<typeof vi.fn> => vi.isMockFunction(v))
  );

describe('BudgetsBudgetProvider delegators hand every argument to the moved body', () => {
  beforeEach(() => {
    for (const spy of allSpies()) spy.mockReset();
  });

  it('covers every delegator the class has', () => {
    // A method whose body is a `.call(this, ...)` hand-off is a delegator; a
    // new one must be added to the table above.
    const own = Object.getOwnPropertyNames(BudgetsBudgetProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\breturn [\w$.]+\.call\(\s*this\b/.test(
          String((BudgetsBudgetProvider.prototype as unknown as Module)[name])
        )
    );
    // The class's own non-delegator methods stay in the class.
    expect(Object.getOwnPropertyNames(BudgetsBudgetProvider.prototype).length).toBe(
      own.length + 20
      // constructor, getClient, wrapBudgetError, wrapMaskedError, getCreateClient,
      // resolveAccountId, budgetArn, toSdkSpend, toSdkDate, toSdkBudget,
      // toSdkNotification, toSdkSubscriber, toSdkNotificationsWithSubscribers,
      // notificationKey, subscriberKey, toSdkResourceTags, getAttribute,
      // getDriftUnorderedPaths, getDriftUnknownPaths, canonicalizeDriftProperties
    );
    expect(own.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });

  it('every moved function the companions export is reached by a delegator', () => {
    // A companion function no delegator names would be dead code, or a body
    // reached around the class.
    for (const mod of [create, update, del, readState] as Module[]) {
      const named = DELEGATORS.filter(([, m]) => m === mod).map(([, , fn]) => fn);
      const exported = Object.keys(mod).filter((k) => vi.isMockFunction(mod[k]));
      expect(exported.sort()).toEqual(named.sort());
    }
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} forwards ${arity} argument(s) in order to ${fn} and returns its result`, () => {
      const provider = new BudgetsBudgetProvider();
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
