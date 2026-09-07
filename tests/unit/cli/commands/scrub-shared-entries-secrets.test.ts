/**
 * `SharedEntriesSecrets` (issue #2531): the VIEW `cdkd scrub` resolves each intrinsic
 * `Export.Name` through. Its contract is "every read and write goes to the
 * target; nothing is stored here", and the contract holds only while every
 * entry-bearing member of `Map.prototype` is overridden — a member the class
 * inherits reads the view's own, permanently empty backing store, so a
 * needle inserted through it would never reach the pass map and the warn
 * that masks against that map would print the plaintext.
 *
 * Nothing in the class can fence that against the RUNTIME: the member set of
 * `Map.prototype` is the runtime's, and the stage-3 `getOrInsert` /
 * `getOrInsertComputed` would arrive with a Node bump, not a code change.
 * So this file asserts the override set against `Map.prototype` as the test
 * runtime actually has it, and pins the two members the production path
 * never calls (`delete` / `clear`) beside the storage claim, so the class is
 * fenced as a whole rather than at the surfaces the scrub cases happen to
 * drive.
 */

import { describe, it, expect, vi } from 'vite-plus/test';

// `scrub.ts` pulls in the whole command; the modules below would otherwise
// build real clients at import time. None of them is exercised here.
vi.mock('../../../../src/utils/logger.js', () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), setLevel: vi.fn() };
  return { getLogger: () => ({ ...logger, child: () => logger }) };
});
vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn(),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({ S3StateBackend: vi.fn() }));
vi.mock('../../../../src/state/lock-manager.js', () => ({ LockManager: vi.fn() }));
vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', () => ({
  IntrinsicFunctionResolver: vi.fn(),
}));

import { SharedEntriesSecrets } from '../../../../src/cli/commands/scrub.js';

/** Own property keys — names AND symbols — of an object, as one list. */
function ownKeys(o: object): Array<string | symbol> {
  return [...Object.getOwnPropertyNames(o), ...Object.getOwnPropertySymbols(o)];
}

describe('SharedEntriesSecrets — the scrub name loop view of the pass map (issue #2531)', () => {
  it('overrides every member of the RUNTIME Map.prototype except the ones that carry no entry', () => {
    // The allowance is exact, not a lower bound: a member appearing here that
    // is neither overridden nor in the list is the regression this fences —
    // `getOrInsert` landing in a Node bump would surface as exactly that.
    //
    // `Symbol.toStringTag` is a NAME (`[object Map]`), read by
    // `Object.prototype.toString` and nothing else; it neither reads nor
    // writes an entry, so inheriting it is correct. `constructor` is the
    // class's own by construction and is listed only to keep the difference
    // empty rather than special-cased.
    const carriesNoEntry = new Set<string | symbol>([Symbol.toStringTag, 'constructor']);
    const inherited = ownKeys(Map.prototype).filter(
      (k) => !carriesNoEntry.has(k) && !Object.prototype.hasOwnProperty.call(SharedEntriesSecrets.prototype, k)
    );
    expect(inherited).toEqual([]);
    // ...and the fence sees the members it claims to: a runtime whose
    // `Map.prototype` lost `set` or `forEach` would pass the filter above
    // vacuously.
    for (const k of ['get', 'set', 'has', 'delete', 'clear', 'keys', 'values', 'entries', 'forEach', 'size', Symbol.iterator]) {
      expect(ownKeys(Map.prototype)).toContain(k);
    }
  });

  it('stores nothing of its own: the inherited Map slots stay empty while the target carries every entry', () => {
    const target = new Map<string, string>();
    const view = new SharedEntriesSecrets(target);

    // `set` returns the VIEW (the `Map` contract callers chain on), not the
    // target — a delegate returning `this.target` would hand a chained caller
    // the pass map itself, with the identity the view exists to keep apart.
    expect(view.set('plaintext-one', '{{resolve:ssm:/p/one}}')).toBe(view);
    view.set('plaintext-two', '{{resolve:ssm:/p/two}}');

    expect(target.get('plaintext-one')).toBe('{{resolve:ssm:/p/one}}');
    expect(target.size).toBe(2);
    // `has` both ways — the resolver's cross-stack seam asks it — and a miss
    // on `get`; presence-only assertions are satisfied by a `has` that reads
    // the (empty) inherited slots as long as nothing asks for a hit.
    expect(view.has('plaintext-one')).toBe(true);
    expect(view.has('plaintext-absent')).toBe(false);
    expect(view.get('plaintext-absent')).toBeUndefined();
    // The ORIGINAL prototype methods, applied to the view, read its own
    // internal slots — the backing store the overrides bypass.
    expect(Reflect.get(Map.prototype, 'size', view)).toBe(0);
    expect(Map.prototype.get.call(view, 'plaintext-one')).toBeUndefined();
    expect(Map.prototype.has.call(view, 'plaintext-one')).toBe(false);
    expect([...Map.prototype.keys.call(view)]).toEqual([]);
    // ...while the view's own reads report the target's.
    expect(view.size).toBe(2);
    expect(view.get('plaintext-two')).toBe('{{resolve:ssm:/p/two}}');
    expect([...view.keys()]).toEqual(['plaintext-one', 'plaintext-two']);
  });

  it('delete and clear reach the target and report the target answer', () => {
    // No production reader on the view calls either — the scrub cases cannot
    // reach them — so they are pinned here: an override delegating to its own
    // storage would answer `false` / leave the target intact.
    const target = new Map<string, string>([
      ['plaintext-one', '{{resolve:ssm:/p/one}}'],
      ['plaintext-two', '{{resolve:ssm:/p/two}}'],
    ]);
    const view = new SharedEntriesSecrets(target);

    expect(view.delete('plaintext-one')).toBe(true);
    expect(target.has('plaintext-one')).toBe(false);
    expect(view.delete('plaintext-one')).toBe(false);
    expect(target.size).toBe(1);

    view.clear();
    expect(target.size).toBe(0);
    expect(view.size).toBe(0);
  });

  it('forEach hands the callback the VIEW as its map argument and honours thisArg', () => {
    const target = new Map<string, string>([['plaintext-one', '{{resolve:ssm:/p/one}}']]);
    const view = new SharedEntriesSecrets(target);
    const seen: Array<{ value: string; key: string; mapIsView: boolean; self: unknown }> = [];
    const thisArg = { tag: 'this' };

    view.forEach(function (this: unknown, value, key, map) {
      seen.push({ value, key, mapIsView: map === view, self: this });
    }, thisArg);

    expect(seen).toEqual([
      { value: '{{resolve:ssm:/p/one}}', key: 'plaintext-one', mapIsView: true, self: thisArg },
    ]);
  });

  it('iteration in every spelling reads the target', () => {
    const target = new Map<string, string>([['plaintext-one', '{{resolve:ssm:/p/one}}']]);
    const view = new SharedEntriesSecrets(target);

    expect([...view]).toEqual([['plaintext-one', '{{resolve:ssm:/p/one}}']]);
    expect([...view.entries()]).toEqual([['plaintext-one', '{{resolve:ssm:/p/one}}']]);
    expect([...view.values()]).toEqual(['{{resolve:ssm:/p/one}}']);
    expect(Array.from(view.keys())).toEqual(['plaintext-one']);
    expect(new Map(view).get('plaintext-one')).toBe('{{resolve:ssm:/p/one}}');
    expect(Object.fromEntries(view)).toEqual({ 'plaintext-one': '{{resolve:ssm:/p/one}}' });
  });
});
