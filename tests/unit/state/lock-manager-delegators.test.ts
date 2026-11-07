/**
 * The moved `LockManager` method bodies live in `src/state/lock-manager/*.ts`
 * (go-to-k/cdkd#5835); the class keeps one `return f.call(this, ...)` delegator
 * per moved method, and each argument a delegator hands on is a hand-off the
 * split introduced.
 *
 * Every companion function is a pass-through spy on the real one. Each case
 * stubs its spy once and pins that the delegator calls its own function with
 * the manager as `this`, every argument in declared order, and returns that
 * function's result. The real bodies run end to end in the rest of
 * `tests/unit/state/lock-*.test.ts`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { S3Client } from '@aws-sdk/client-s3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// The compiler API lives under `typescript-v6`, as in the other source-reading fences.
import ts from 'typescript-v6';

/** Replace every function a module exports with a pass-through spy. */
async function spied(path: string): Promise<Record<string, unknown>> {
  const actual = await vi.importActual<Record<string, unknown>>(path);
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === 'function' ? vi.fn(v as (...a: unknown[]) => unknown) : v,
    ])
  );
}

vi.mock('../../../src/state/lock-manager/acquire.js', () =>
  spied('../../../src/state/lock-manager/acquire.js')
);
vi.mock('../../../src/state/lock-manager/read.js', () =>
  spied('../../../src/state/lock-manager/read.js')
);
vi.mock('../../../src/state/lock-manager/release.js', () =>
  spied('../../../src/state/lock-manager/release.js')
);
vi.mock('../../../src/state/lock-manager/renewal.js', () =>
  spied('../../../src/state/lock-manager/renewal.js')
);

import * as entry from '../../../src/state/lock-manager.js';
import { LockManager } from '../../../src/state/lock-manager.js';
import * as shared from '../../../src/state/lock-manager/shared.js';
import * as acquire from '../../../src/state/lock-manager/acquire.js';
import * as read from '../../../src/state/lock-manager/read.js';
import * as release from '../../../src/state/lock-manager/release.js';
import * as renewal from '../../../src/state/lock-manager/renewal.js';

const MODULES: Record<string, Record<string, unknown>> = { acquire, read, release, renewal };

/** [class method, companion module, declared parameter count]; the function shares the method's name. */
const DELEGATORS: ReadonlyArray<readonly [string, string, number]> = [
  ['acquireLock', 'acquire', 4],
  ['putLockObject', 'acquire', 3],
  ['acquireLockWithRetry', 'acquire', 6],
  ['getLockRecord', 'read', 2],
  ['doReleaseLock', 'release', 3],
  ['stillOursByBody', 'release', 1],
  ['forceReleaseLock', 'release', 3],
  ['deleteLock', 'release', 3],
  ['purgeLockVersions', 'release', 2],
  ['trackHeldLock', 'renewal', 1],
  ['doRenewLock', 'renewal', 1],
  ['adoptOwnWrite', 'renewal', 2],
];

/** Methods whose bodies stay on the class. */
const KEPT_ON_CLASS = new Set([
  'constructor',
  'wrapS3Failure',
  'settleDeferredPurges',
  'ownerParam',
  'ensureClientForBucket',
  'getLockKey',
  'getDefaultOwner',
  'isLockExpired',
  'formatDuration',
  'getLockInfo',
  'isLocked',
  'releaseLock',
  'sameLockIdentity',
  'abandonedRunEndedBy',
  'startRenewal',
  'stopRenewal',
  'renewLock',
  'isForeignLockError',
  'isGoneError',
  'isConditionUnsupportedError',
  'isNotOursError',
]);

type Callable = (...args: unknown[]) => unknown;
type Spy = ReturnType<typeof vi.fn>;

const manager = (): LockManager =>
  new LockManager({} as S3Client, { bucket: 'b', prefix: 'cdkd' }, { disableRenewal: true });

describe('LockManager delegators hand every argument and the result on', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('the table names every method the class delegates', () => {
    const methods = Object.getOwnPropertyNames(LockManager.prototype).filter(
      (m) => !KEPT_ON_CLASS.has(m)
    );
    expect(methods.sort()).toEqual(DELEGATORS.map(([m]) => m).sort());
  });

  it('each arity in the table is the delegator signature parameter count', () => {
    // Read off the class source, so a parameter added to a delegator without
    // a table update reddens here instead of leaving its hand-off unchecked.
    const file = join(process.cwd(), 'src/state/lock-manager.ts');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const declared = new Map<string, number>();
    source.forEachChild(function visit(node: ts.Node): void {
      if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
        declared.set(node.name.text, node.parameters.length);
      }
      node.forEachChild(visit);
    });
    for (const [method, , arity] of DELEGATORS) expect(declared.get(method), method).toBe(arity);
  });

  for (const [method, mod, arity] of DELEGATORS) {
    it(`${method} calls ${mod}.${method} with this, ${arity} argument(s) in order, and returns its result`, () => {
      const spy = MODULES[mod]![method] as Spy;
      expect(vi.isMockFunction(spy), `${mod}.${method} is not spied`).toBe(true);
      const result = { result: method };
      spy.mockImplementationOnce(() => result);
      const lm = manager();
      const args = Array.from({ length: arity }, (_, i) => ({ arg: i }));
      const returned = (lm as unknown as Record<string, Callable>)[method]!(...args);
      expect(returned).toBe(result);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]).toEqual(args);
      spy.mock.calls[0]!.forEach((a, i) => expect(a).toBe(args[i]));
      expect(spy.mock.contexts[0]).toBe(lm);
    });
  }

  it('acquireLockWithRetry hands on its default retry count and delay', () => {
    const spy = acquire.acquireLockWithRetry as unknown as Spy;
    spy.mockImplementationOnce(() => undefined);
    void manager().acquireLockWithRetry('S', 'us-east-1');
    expect(spy.mock.calls[0]).toEqual(['S', 'us-east-1', undefined, undefined, 3, 2000]);
  });

  it("putLockObject hands on its default create-only condition", () => {
    const spy = acquire.putLockObject as unknown as Spy;
    spy.mockImplementationOnce(() => undefined);
    const info = { owner: 'o', timestamp: 1, expiresAt: 2 };
    void manager().putLockObject('k', info);
    expect(spy.mock.calls[0]).toEqual(['k', info, { IfNoneMatch: '*' }]);
  });
});

describe('lock-manager.ts re-exports what it always exported', () => {
  it('abandonedRunHorizon, isLockInfoExpired and RELEASED_LOCK_REACQUIRE_LIMIT are the companion values', () => {
    expect(entry.abandonedRunHorizon).toBe(shared.abandonedRunHorizon);
    expect(entry.isLockInfoExpired).toBe(shared.isLockInfoExpired);
    expect(entry.RELEASED_LOCK_REACQUIRE_LIMIT).toBe(shared.RELEASED_LOCK_REACQUIRE_LIMIT);
    expect(entry.RELEASED_LOCK_REACQUIRE_LIMIT).toBe(3);
  });

  it('exports exactly the names it did before the split', () => {
    expect(Object.keys(entry).sort()).toEqual(
      ['LockManager', 'RELEASED_LOCK_REACQUIRE_LIMIT', 'abandonedRunHorizon', 'isLockInfoExpired'].sort()
    );
  });
});
