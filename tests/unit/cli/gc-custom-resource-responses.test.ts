import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2052 — `cdkd gc` collects abandoned custom-resource response
 * placeholders from the STATE bucket.
 *
 * `CustomResourceProvider` PUTs an empty object at
 * `custom-resource-responses/{requestId}.json` before each invocation so the
 * handler has a pre-signed URL to write to. Nothing swept the ones that are
 * abandoned: `gc.ts` scanned the ASSET bucket and contained zero references to
 * this key family.
 *
 * These cases pin the whole contract in both directions, because a sweeper is
 * exactly the shape that can pass while doing nothing (it deletes what it finds,
 * and finding nothing is indistinguishable from a clean bucket): every positive
 * asserts the key is GONE — that the DELETE was issued naming it — never that
 * gc exited 0, and every one is paired with a negative proving the sweep leaves
 * alone what it must.
 */

const { mockS3Send, mockStsSend, mockEcrSend, mockQuestion, stateBackendMocks, loggerMocks } =
  vi.hoisted(() => ({
    mockS3Send: vi.fn(),
    mockStsSend: vi.fn(),
    mockEcrSend: vi.fn(),
    mockQuestion: vi.fn(),
    stateBackendMocks: {
      getRawObject: vi.fn(),
      listRawKeys: vi.fn(),
      listRawObjects: vi.fn(),
      deleteRawObjects: vi.fn(),
    },
    loggerMocks: {
      setLevel: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => loggerMocks,
}));

vi.mock('../../../src/utils/role-arn.js', () => ({
  applyRoleArnIfSet: vi.fn(async () => undefined),
}));

vi.mock('../../../src/utils/aws-clients.ts', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({
    get s3() {
      return { send: mockS3Send, config: { region: async () => REGION }, destroy: vi.fn() };
    },
    get sts() {
      return { send: mockStsSend, config: { region: async () => REGION }, destroy: vi.fn() };
    },
    destroy: vi.fn(),
  })),
  setAwsClients: vi.fn(),
  getAwsClients: vi.fn(),
}));

vi.mock('../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => stateBackendMocks),
}));

vi.mock('@aws-sdk/client-s3', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-s3')>();
  return {
    ...actual,
    S3Client: vi.fn().mockImplementation(() => ({ send: mockS3Send, destroy: vi.fn() })),
  };
});

vi.mock('@aws-sdk/client-ecr', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-ecr')>();
  return {
    ...actual,
    ECRClient: vi.fn().mockImplementation(() => ({ send: mockEcrSend, destroy: vi.fn() })),
  };
});

vi.mock('../../../src/utils/error-handler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/error-handler.js')>();
  return {
    ...actual,
    withErrorHandling: <Args extends unknown[]>(fn: (...args: Args) => Promise<void> | void) => fn,
  };
});

// `gc.ts` imports readline as a DEFAULT namespace (`import readline from
// 'node:readline/promises'`), so a named-export-only mock throws "No 'default'
// export is defined" instead of answering the prompt. Same shape as gc.test.ts.
vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => ({ question: mockQuestion, close: vi.fn() }),
  },
}));

const { createGcCommand, listResponsePlaceholderCandidates } = await import(
  '../../../src/cli/commands/gc.js'
);
const { CUSTOM_RESOURCE_RESPONSE_PREFIX } = await import('../../../src/state/state-prefix.js');

const ACCOUNT = '123456789012';
const REGION = 'us-east-1';
const STATE_BUCKET = `cdkd-state-${ACCOUNT}`;
const MARKER_KEY = `cdkd-bootstrap/${REGION}.json`;
const ASSET_BUCKET = 'my-custom-asset-bucket';
const CONTAINER_REPO = 'my-custom-container-repo';
const MARKER_BODY = JSON.stringify({
  assetBucket: ASSET_BUCKET,
  containerRepo: CONTAINER_REPO,
  assetSupportVersion: 1,
  createdAt: '2026-01-01T00:00:00.000Z',
});

/** Comfortably past the 30d `--older-than` default. */
const OLD = new Date(Date.now() - 90 * 24 * 3600_000);
/** Comfortably inside it — and the shape an in-flight run leaves behind. */
const RECENT = new Date(Date.now() - 60_000);

/**
 * Real producer-shaped keys, not readable stand-ins.
 *
 * `getResponseKey` builds `{prefix}/cdkd-${Date.now()}-${suffix}.json`, and the
 * sweep matches that shape rather than everything under the prefix. A
 * descriptive fixture name like `abandoned-request.json` is not a key cdkd can
 * write, so a suite using one would exercise the reject arm on every case while
 * appearing to test collection — the fixture has to contain the feature.
 */
const ABANDONED_KEY = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1756000000000-a1b2c3.json`;
const IN_FLIGHT_KEY = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1756180000000-z9y8x7.json`;

async function runGc(args: string[]): Promise<void> {
  const cmd = createGcCommand();
  cmd.exitOverride();
  await cmd.parseAsync(args, { from: 'user' });
}

/**
 * The keys gc actually asked the state backend to DELETE.
 *
 * Use for POSITIVE assertions only. It flattens, so `toEqual([])` cannot tell
 * "never called" from `deleteRawObjects([])` — a real distinction, since the
 * second still prints a `✓ Deleted 0 …` line. Negatives assert
 * `not.toHaveBeenCalled()` instead.
 */
function deletedResponseKeys(): string[] {
  return stateBackendMocks.deleteRawObjects.mock.calls.flatMap((c) => c[0] as string[]);
}

function infoText(): string {
  return loggerMocks.info.mock.calls.map((c) => String(c[0])).join('\n');
}

/**
 * The CONSENT surface. `promptGcConfirm` prints the plan through `warn`, not
 * `info`, and prints it before `--yes` short-circuits the question — so this is
 * what a user is shown before anything is deleted, in both the interactive and
 * the `-y` path.
 */
function warnText(): string {
  return loggerMocks.warn.mock.calls.map((c) => String(c[0])).join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStsSend.mockResolvedValue({ Account: ACCOUNT });
  stateBackendMocks.getRawObject.mockImplementation(async (key: string) =>
    key === MARKER_KEY ? MARKER_BODY : null
  );
  // No state files and no locks: the asset half of gc finds nothing, so these
  // cases measure only the placeholder sweep.
  stateBackendMocks.listRawKeys.mockResolvedValue([]);
  stateBackendMocks.listRawObjects.mockResolvedValue([]);
  stateBackendMocks.deleteRawObjects.mockResolvedValue(undefined);
  // Empty asset bucket / repo.
  mockS3Send.mockResolvedValue({ Contents: [], IsTruncated: false });
  mockEcrSend.mockResolvedValue({ imageDetails: [] });
  mockQuestion.mockResolvedValue('y');
});

describe('cdkd gc: abandoned custom-resource response placeholders (issue #2052)', () => {
  it('DELETES an abandoned placeholder older than the cutoff', async () => {
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    await runGc(['--yes']);

    // The positive assertion is the DELETE naming the key, not an exit code.
    expect(deletedResponseKeys()).toEqual([ABANDONED_KEY]);
  });

  it('KEEPS a placeholder a concurrent run may still write to', async () => {
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: IN_FLIGHT_KEY, lastModified: RECENT, size: 0 },
    ]);

    await runGc(['--yes']);

    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
    expect(infoText()).toContain('Nothing to garbage-collect');
  });

  it('separates the two in one bucket, rather than collecting or sparing both', async () => {
    // The discriminating case: a sweeper that ignored the age guard would
    // delete both, and one that never fired would delete neither. Only a
    // working guard produces exactly one.
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
      { key: IN_FLIGHT_KEY, lastModified: RECENT, size: 0 },
    ]);

    await runGc(['--yes']);

    expect(deletedResponseKeys()).toEqual([ABANDONED_KEY]);
  });

  it('scopes the listing to the prefix the PROVIDER writes under', async () => {
    await runGc(['--yes']);

    // A sweep pointed at the wrong prefix finds nothing and passes every
    // "deleted nothing" case above, so the prefix itself is asserted.
    expect(stateBackendMocks.listRawObjects).toHaveBeenCalledWith(
      `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/`
    );
  });

  it('deletes nothing under --dry-run, but names the placeholder in the plan', async () => {
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    await runGc(['--dry-run']);

    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
    expect(infoText()).toContain(ABANDONED_KEY);
    expect(infoText()).toContain('abandoned custom-resource response');
  });

  it('deletes nothing when the confirmation is declined', async () => {
    // `promptGcConfirm` hard-errors off a TTY, so the interactive path is only
    // reachable with `isTTY` stubbed — without this the case would fail for the
    // wrong reason and prove nothing about the answer 'n'.
    const realIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    mockQuestion.mockResolvedValue('n');
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    try {
      await runGc([]);
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        value: realIsTTY,
        configurable: true,
      });
    }

    // `not.toHaveBeenCalled()`, not `deletedResponseKeys()).toEqual([])` — the
    // helper flattens, so `toEqual([])` cannot tell "never called" from
    // `deleteRawObjects([])`, exactly as that helper's own doc says.
    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
    expect(infoText()).toContain('gc cancelled');
  });

  it('sweeps even when the region is not opted in to cdkd ASSET storage', async () => {
    // The placeholders live in the STATE bucket, which exists independently of
    // the asset bootstrap marker. Before issue #2052 reordered the flow, the
    // "not opted in" return fired first and the sweep was unreachable here.
    stateBackendMocks.getRawObject.mockResolvedValue(null);
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    await runGc(['--yes']);

    expect(deletedResponseKeys()).toEqual([ABANDONED_KEY]);
    // ...and it still says WHY no assets are listed, rather than silently
    // printing a plan with none.
    expect(infoText()).toContain('not opted in to cdkd asset storage');
  });

  it('says it is CONTINUING past the missing marker, in a run that deletes nothing', async () => {
    // Isolates the marker early-return from the delete arm.
    //
    // Every other no-marker case asserts the DELETE, so restoring the pre-fix
    // `return` reds a strict SUBSET of what simply removing the
    // `deleteRawObjects` call reds — distinct mutations, but not independently
    // fenced. This case is `--dry-run`, so the delete arm is not exercised at
    // all: it reds when the early return comes back and stays green when the
    // delete call goes away.
    //
    // The literal matters too. The no-marker path has TWO messages that both
    // contain "not opted in to cdkd asset storage" — one ending "nothing to
    // garbage-collect" and one ending "Continuing with ...". Only the second
    // says the sweep was reached.
    stateBackendMocks.getRawObject.mockResolvedValue(null);
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    await runGc(['--dry-run']);

    expect(infoText()).toContain(
      "Continuing with the state bucket's abandoned custom-resource response placeholders."
    );
    expect(infoText()).toContain(`s3://${STATE_BUCKET}/${ABANDONED_KEY}`);
    expect(infoText()).not.toContain('nothing to garbage-collect');
  });

  it('still reports "nothing to garbage-collect" with no marker AND no placeholders', async () => {
    // The negative control for the case above: the reordering must not turn the
    // not-opted-in path into a plan-printing one when there is nothing to plan.
    stateBackendMocks.getRawObject.mockResolvedValue(null);

    await runGc(['--yes']);

    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
    expect(infoText()).toContain('nothing to garbage-collect');
  });

  it('refuses even for a region with NO asset marker, which used to return first', async () => {
    // The reorder's behaviour change: a non-opted-in region previously returned
    // a friendly exit-0 no-op and never reached the lock guard. It can now
    // throw GC_LOCKED. That is the safe direction — gc refuses rather than
    // acting while a deploy is in flight — but it is a change users can see, so
    // it is pinned rather than left to the prose that describes it.
    stateBackendMocks.getRawObject.mockResolvedValue(null);
    stateBackendMocks.listRawKeys.mockResolvedValue(['cdkd/SomeStack/us-east-1/lock.json']);

    await expect(runGc(['--yes'])).rejects.toThrow(/active lock/);

    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
  });

  it('reports a placeholder delete failure with the GC_DELETE_FAILED identity', async () => {
    // Both asset arms throw CdkdError('GC_DELETE_FAILED'); `deleteRawObjects`
    // raises a bare StateError, and one failure mode with two error identities
    // is one every caller has to special-case.
    //
    // TWO candidates against ONE inner failure: that gap is the whole point of
    // the message assertions below, and a single candidate would make the
    // attempted and the actual count coincide, so the case could not tell them
    // apart.
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
      { key: `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1756000000001-d4e5f6.json`, lastModified: OLD, size: 8 },
    ]);
    stateBackendMocks.deleteRawObjects.mockRejectedValue(
      new Error('Failed to delete 1 object(s) from state bucket: k (AccessDenied: )')
    );

    const caught = await runGc(['--yes']).catch((e: unknown) => e);
    expect(caught).toMatchObject({ code: 'GC_DELETE_FAILED' });
    // The wrapper carries NO count of its own. It only ever knew the ATTEMPTED
    // one while the message it wraps reports the ACTUAL failures, so a count
    // here produced `Failed to delete 2 ... placeholder(s) ...: Failed to
    // delete 1 object(s) ...` — a partial failure describing itself as total.
    expect((caught as Error).message).toContain(
      `Failed to delete abandoned custom-resource response placeholder(s) from ${STATE_BUCKET}:`
    );
    expect((caught as Error).message).not.toMatch(
      /Failed to delete \d+ abandoned custom-resource/
    );
    // ...and the inner count still reaches the user, so dropping the outer one
    // removed a contradiction rather than the information.
    expect((caught as Error).message).toContain('Failed to delete 1 object(s)');
  });

  it('prints no "Deleted 0 ..." line when there is nothing to collect', async () => {
    // `deleteRawObjects([])` is a no-op at the wire, so the only observable of a
    // missing `length > 0` guard is the success line claiming a deletion that
    // did not happen.
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: IN_FLIGHT_KEY, lastModified: RECENT, size: 0 },
    ]);
    // An asset candidate so the run reaches the delete phase at all.
    mockS3Send.mockResolvedValue({
      Contents: [{ Key: 'garbage-old.zip', Size: 10, LastModified: OLD }],
      IsTruncated: false,
    });

    await runGc(['--yes']);

    // POSITIVE first: a negative assertion is satisfied by the run failing for
    // any unrelated reason, so it proves nothing until the run is pinned to
    // have reached the delete phase this case is about.
    expect(infoText()).toContain(`✓ Deleted 1 object(s) (10 B) from ${ASSET_BUCKET}`);
    // Then the negative, anchored on the literal the success line ACTUALLY
    // renders. An earlier spelling used `'placeholder(s) from'`, which exists
    // only in the ERROR message — a string `logger.info` can never emit — so it
    // was vacuously true and removing the very `length > 0` guard it names
    // passed the whole suite.
    expect(infoText()).not.toContain('Deleted 0 abandoned custom-resource response');
  });

  it('refuses to sweep while a stack lock is held', async () => {
    // The primary in-flight guard. The age cutoff is the second layer; this one
    // is what makes a concurrent deploy's key unreachable regardless of age.
    stateBackendMocks.listRawKeys.mockResolvedValue(['cdkd/SomeStack/us-east-1/lock.json']);
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    await expect(runGc(['--yes'])).rejects.toThrow(/active lock/);

    expect(stateBackendMocks.deleteRawObjects).not.toHaveBeenCalled();
  });
});

describe('cdkd gc: only the producer\'s own key shape is swept (issue #2052)', () => {
  /**
   * `--state-prefix` is free-form and unvalidated, so a stack deployed with
   * `--state-prefix custom-resource-responses` lands its state INSIDE the swept
   * prefix. gc builds its backend on the DEFAULT prefix and cannot see the
   * collision, so an age-only sweep would delete live state and orphan every
   * resource in the stack. Found by the security review, which measured all
   * four keys below being returned as delete candidates.
   */
  it('does NOT collect state written under a colliding --state-prefix', async () => {
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
      {
        key: `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/MyStack/us-east-1/state.json`,
        lastModified: OLD,
        size: 900,
      },
      {
        key: `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/MyStack/us-east-1/lock.json`,
        lastModified: OLD,
        size: 90,
      },
      {
        key: `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/_index/us-east-1/exports.json`,
        lastModified: OLD,
        size: 40,
      },
    ]);

    await runGc(['--yes']);

    expect(deletedResponseKeys()).toEqual([ABANDONED_KEY]);
  });

  it('DOES collect a placeholder whose random suffix is EMPTY', async () => {
    // `Math.random().toString(36).substring(7)` returns '' whenever the base-36
    // rendering is shorter than eight characters, so `cdkd-<epoch>-.json` is a
    // key the provider really writes. A `[0-9a-z]+` shape filter would skip
    // exactly those — a filter defeating the sweep it protects, and invisible
    // because under-collection looks like a clean bucket.
    const emptySuffixKey = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1756180000000-.json`;
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: emptySuffixKey, lastModified: OLD, size: 0 },
    ]);

    await runGc(['--yes']);

    expect(deletedResponseKeys()).toEqual([emptySuffixKey]);
  });

  it('names the STATE bucket in the plan, not the asset bucket', async () => {
    // The state-vs-asset bucket distinction is the reason the delete goes
    // through the backend rather than the region-pinned asset client. Swapping
    // the plan's bucket for the asset one passed every other case.
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);

    await runGc(['--dry-run']);

    expect(infoText()).toContain(`s3://${STATE_BUCKET}/${ABANDONED_KEY}`);
  });
});

describe('cdkd gc: the consent surface and the reclaim totals (issue #2052)', () => {
  /**
   * An ASSET candidate alongside the placeholder, with deliberately different
   * byte counts.
   *
   * 10 + 512 is what makes the totals discriminating: with only one of the two
   * arms populated, an arm dropped from the sum would still print the other
   * arm's number and every assertion would hold.
   */
  function withOneAssetAndOnePlaceholder(): void {
    stateBackendMocks.listRawObjects.mockResolvedValue([
      { key: ABANDONED_KEY, lastModified: OLD, size: 512 },
    ]);
    mockS3Send.mockResolvedValue({
      Contents: [{ Key: 'garbage-old.zip', Size: 10, LastModified: OLD }],
      IsTruncated: false,
    });
  }

  it('asks for consent over the WIDENED blast radius, not over "assets"', async () => {
    // The prompt is what a user reads before anything is deleted, and the plan
    // behind it now includes STATE-bucket objects that are neither assets nor
    // region-scoped. Nothing greped the prompt, so reverting it to
    // `unreferenced assets in <region>` — describing strictly less than it is
    // about to delete — passed the whole suite. Three reviewers flagged the
    // wording; this is the assertion that keeps it.
    withOneAssetAndOnePlaceholder();

    await runGc(['--yes']);

    expect(warnText()).toContain(`cdkd gc will delete the following (region: ${REGION}):`);
    expect(warnText()).not.toContain('unreferenced assets');
    // ...and the placeholder is actually IN the plan the user consents to, so
    // the wording above is not merely accurate about an empty list.
    expect(warnText()).toContain(`s3://${STATE_BUCKET}/${ABANDONED_KEY}`);
  });

  it('counts placeholder bytes in the plan total the user consents to', async () => {
    // 10 B of asset + 512 B of placeholder. Dropping `responseBytes` from the
    // sum leaves a self-consistent-looking `= 10 B reclaimable`, which no other
    // case could see.
    withOneAssetAndOnePlaceholder();

    await runGc(['--yes']);

    expect(warnText()).toContain(
      'Total: 1 S3 object(s) (10 B) + 0 ECR image(s) (0 B) + ' +
        '1 custom-resource response placeholder(s) (512 B) = 522 B reclaimable'
    );
  });

  it('counts placeholder bytes in the --dry-run total as well', async () => {
    // The dry-run path prints the same total through `info` rather than through
    // the prompt, so it is a second, independent rendering of the same sum.
    withOneAssetAndOnePlaceholder();

    await runGc(['--dry-run']);

    expect(infoText()).toContain('(512 B) = 522 B reclaimable');
  });

  it('counts placeholder bytes in the final reclaimed total', async () => {
    // The closing line is computed separately from the plan total, so dropping
    // `responseBytes` from one and not the other is a real (and silent) state.
    withOneAssetAndOnePlaceholder();

    await runGc(['--yes']);

    expect(infoText()).toContain('✓ gc completed: 522 B reclaimed');
  });
});

describe('listResponsePlaceholderCandidates (issue #2052)', () => {
  const logger = { debug: vi.fn() };

  it('applies the cutoff strictly, so an object exactly at it is KEPT', async () => {
    const cutoff = Date.now() - 1000;
    const atBoundary = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-1-aaa.json`;
    const older = `${CUSTOM_RESOURCE_RESPONSE_PREFIX}/cdkd-2-bbb.json`;
    const backend = {
      listRawObjects: vi.fn(async () => [
        { key: atBoundary, lastModified: new Date(cutoff), size: 1 },
        { key: older, lastModified: new Date(cutoff - 1), size: 1 },
      ]),
    };

    const candidates = await listResponsePlaceholderCandidates(backend, cutoff, logger);

    // `>= cutoff` keeps: the boundary object is not collected. A `>` would
    // collect it, which is the wrong direction for an in-flight guard.
    expect(candidates.map((c) => c.key)).toEqual([older]);
  });

  it('returns an empty list when the prefix holds nothing', async () => {
    const backend = { listRawObjects: vi.fn(async () => []) };
    await expect(listResponsePlaceholderCandidates(backend, Date.now(), logger)).resolves.toEqual(
      []
    );
  });
});
