/**
 * The `S3DirectoryBucketProvider` class keeps one delegator per method whose
 * body moved into `src/provisioning/providers/s3-directory-bucket/`
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
  getAwsClients: () => ({ s3: { send: vi.fn() }, sts: { send: vi.fn() } }),
}));

/** Every exported function of a companion module, replaced by a spy. */
async function spyAll(load: () => Promise<Record<string, unknown>>) {
  const actual = await load();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [k, typeof v === 'function' ? vi.fn() : v])
  );
}

vi.mock('../../../src/provisioning/providers/s3-directory-bucket/create.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/s3-directory-bucket/update.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/s3-directory-bucket/delete.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);
vi.mock('../../../src/provisioning/providers/s3-directory-bucket/read-state.js', (io) =>
  spyAll(io as () => Promise<Record<string, unknown>>)
);

import { S3DirectoryBucketProvider } from '../../../src/provisioning/providers/s3-directory-bucket-provider.js';
import * as create from '../../../src/provisioning/providers/s3-directory-bucket/create.js';
import * as update from '../../../src/provisioning/providers/s3-directory-bucket/update.js';
import * as del from '../../../src/provisioning/providers/s3-directory-bucket/delete.js';
import * as readState from '../../../src/provisioning/providers/s3-directory-bucket/read-state.js';

type Module = Record<string, unknown>;

/** [class method, companion module, moved function, the moved function's arity]. */
const DELEGATORS: ReadonlyArray<readonly [string, Module, string, number]> = [
  ['create', create, 'create', 4],
  ['applyConfigurations', create, 'applyConfigurations', 6],
  ['deleteItemIdempotently', create, 'deleteItemIdempotently', 1],
  ['update', update, 'update', 6],
  ['delete', del, 'deleteImpl', 5],
  ['deleteBucketWithEmptyRetry', del, 'deleteBucketWithEmptyRetry', 4],
  ['emptyBucket', del, 'emptyBucket', 2],
  ['readState', readState, 'readState', 1],
  ['readEncryption', readState, 'readEncryption', 1],
  ['readLifecycle', readState, 'readLifecycle', 1],
  ['readMetrics', readState, 'readMetrics', 1],
  ['readInventory', readState, 'readInventory', 1],
  ['readTags', readState, 'readTags', 1],
  ['import', readState, 'importImpl', 1],
];

const allSpies = (): ReturnType<typeof vi.fn>[] =>
  [create, update, del, readState].flatMap((m) =>
    Object.values(m as Module).filter((v): v is ReturnType<typeof vi.fn> => vi.isMockFunction(v))
  );

describe('S3DirectoryBucketProvider delegators hand every argument to the moved body', () => {
  beforeEach(() => {
    for (const spy of allSpies()) spy.mockReset();
  });

  it('covers every delegator the class has', () => {
    // A method whose body is a `.call(this, ...)` hand-off is a delegator; a
    // new one must be added to the table above.
    const own = Object.getOwnPropertyNames(S3DirectoryBucketProvider.prototype).filter(
      (name) =>
        name !== 'constructor' &&
        /\breturn [\w$.]+\.call\(\s*this\b/.test(
          String((S3DirectoryBucketProvider.prototype as unknown as Module)[name])
        )
    );
    // The class's own non-delegator methods stay in the class.
    expect(Object.getOwnPropertyNames(S3DirectoryBucketProvider.prototype).length).toBe(
      // constructor, wrapCaughtError, readUnsettled, getDriftUnorderedPaths,
      // canonicalizeDriftProperties, getCreateClient, getEc2Client,
      // getS3ControlClient, getAzId, getRegion, getAccountId, buildAttributes,
      // buildBucketArn, readCurrentState
      own.length + 14
    );
    expect(own.sort()).toEqual(DELEGATORS.map(([name]) => name).sort());
  });

  for (const [method, mod, fn, arity] of DELEGATORS) {
    it(`${method} forwards ${arity} argument(s) in order to ${fn} and returns its result`, () => {
      const provider = new S3DirectoryBucketProvider();
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

  it('readCurrentState reads through readState with the physical id', async () => {
    // Not a delegator (it stayed in the class), but its one hand-off goes
    // through the readState delegator, so it lands on the moved body.
    const provider = new S3DirectoryBucketProvider();
    const live = { BucketName: 'b--use1-az1--x-s3' };
    (readState.readState as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(live);

    await expect(provider.readCurrentState('b--use1-az1--x-s3', 'L', 'T')).resolves.toBe(live);
    expect(readState.readState).toHaveBeenCalledWith('b--use1-az1--x-s3');
  });
});
