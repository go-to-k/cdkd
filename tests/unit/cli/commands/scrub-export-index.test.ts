/**
 * `cdkd scrub` repairs the cross-stack EXPORTS INDEX, not only `state.json`
 * (issue [#2667](https://github.com/go-to-k/cdkd/issues/2667)).
 *
 * The index at `{prefix}/_index/{region}/exports.json` stores each exported
 * Output's RESOLVED value, and only `cdkd deploy` used to write it. A legacy
 * binary published a `{{resolve:secretsmanager:...}}` Output's plaintext into
 * both `state.json` and that object; `cdkd scrub` — the command for the stack
 * the user does not want to redeploy — rewrote `state.json` alone, so the
 * plaintext stayed as the CURRENT body of a region-wide object readable with
 * `s3:GetObject` and no version id, and `--dry-run --fail`, documented as a
 * standing CI gate, read state records and reported GREEN over it.
 *
 * The rule this file pins is CONVERGENCE, not a match against scrub's plaintext
 * map: the map is built by LIVE RESOLUTION, so after a rotation it holds the
 * secret's current value while the index holds the value resolved at the legacy
 * deploy, and a byte match would miss exactly that entry. `state.outputs` is
 * what a redeploy and `ExportIndexStore.rebuild()` both write, so it is what an
 * entry is converged to.
 *
 * Membership is never changed. Ownership is read off the entry, never inferred
 * from the name.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import type { ExportIndexEntry } from '../../../../src/state/export-index-store.js';

const commandLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  setLevel: vi.fn(),
}));
vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({ ...commandLogger, child: () => commandLogger }),
}));

const synthStacks = vi.hoisted(() => [] as unknown[]);
const commandStateBackend = vi.hoisted(() => ({
  getState: vi.fn(),
  saveState: vi.fn().mockResolvedValue('etag-2'),
}));

vi.mock('../../../../src/synthesis/synthesizer.js', () => ({
  Synthesizer: vi.fn().mockImplementation(() => ({
    synthesize: vi.fn().mockImplementation(() => Promise.resolve({ stacks: synthStacks })),
    expandMacrosForStacks: vi.fn().mockResolvedValue(undefined),
  })),
  synthesisStatusMessage: () => 'synthesizing',
}));
vi.mock('../../../../src/cli/config-loader.js', () => ({
  resolveApp: () => 'node app.js',
  resolveStateBucketWithDefault: () => Promise.resolve('cdkd-state-bucket'),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn().mockImplementation(() => ({ s3: {} })),
  setAwsClients: vi.fn(),
}));
vi.mock('../../../../src/utils/role-arn.js', () => ({ applyRoleArnIfSet: vi.fn() }));
vi.mock('../../../../src/state/s3-state-backend.js', () => ({
  S3StateBackend: vi.fn().mockImplementation(() => commandStateBackend),
}));
vi.mock('../../../../src/state/lock-manager.js', () => ({
  LockManager: vi.fn().mockImplementation(() => ({
    acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  })),
}));

/**
 * A per-REGION double of the store. Keyed by the region the command passes to
 * the constructor, which is what makes the multi-region fan-out observable at
 * all: the index key embeds the region, so one store per region is one
 * `exports.json` per region.
 *
 * A successful `patchEntry` mutates the region's entries, exactly as the real
 * store's `persist` leaves its loaded snapshot — that is what lets the RE-RUN
 * case invoke the command twice against the state the first run left.
 */
interface IndexRegionSlot {
  entries: Map<string, ExportIndexEntry> | undefined;
  readError?: Error | undefined;
  /**
   * Throw only from the Nth read onward (1-based). The real store's
   * `loadPersisted` memoizes no failure and caches no MISSING result, so a
   * region whose per-stack read found no index is read a SECOND time by the
   * coverage pass — and only that second GET can fail transiently. A sticky
   * `readError` cannot model it: the per-stack read would fail first and the
   * coverage pass would skip the region entirely.
   */
  readErrorFrom?: number | undefined;
  patchOk: boolean;
  patches: Array<{
    exportName: string;
    entry: ExportIndexEntry;
    requireOwner?: { producerStack: string; producerRegion: string } | undefined;
  }>;
  reads: number;
}
const indexFake = vi.hoisted(() => ({
  regions: new Map<string, unknown>(),
  ctorRegions: [] as string[],
  ctorArgs: [] as unknown[][],
}));

vi.mock('../../../../src/state/export-index-store.js', () => ({
  ExportIndexStore: vi
    .fn()
    .mockImplementation((...args: unknown[]) => {
      const region = args[3] as string;
      indexFake.ctorRegions.push(region);
      indexFake.ctorArgs.push(args);
      const slot = indexFake.regions.get(region) as IndexRegionSlot | undefined;
      return {
        readPersistedEntries: vi.fn().mockImplementation(() => {
          if (!slot) return Promise.resolve(undefined);
          slot.reads++;
          if (slot.readError) return Promise.reject(slot.readError);
          if (slot.readErrorFrom !== undefined && slot.reads >= slot.readErrorFrom) {
            return Promise.reject(new Error('transient S3 failure on the coverage read'));
          }
          return Promise.resolve(slot.entries ? new Map(slot.entries) : undefined);
        }),
        patchEntry: vi
          .fn()
          .mockImplementation(
            (
              exportName: string,
              entry: ExportIndexEntry,
              opts?: { requireOwner?: { producerStack: string; producerRegion: string } }
            ) => {
              if (!slot) return Promise.resolve(true);
              slot.patches.push({ exportName, entry, requireOwner: opts?.requireOwner });
              // Mirrors the real store's guard so a scrub that stopped passing
              // `requireOwner` is visible here rather than only in the store's
              // own suite.
              const current = slot.entries?.get(exportName);
              const owner = opts?.requireOwner;
              if (
                owner &&
                (!current ||
                  current.producerStack !== owner.producerStack ||
                  current.producerRegion !== owner.producerRegion)
              ) {
                return Promise.resolve(false);
              }
              if (slot.patchOk) slot.entries?.set(exportName, entry);
              return Promise.resolve(slot.patchOk);
            }
          ),
      };
    }),
}));

const SECRET_PLAINTEXT = 'super-secret-plaintext-value';
const SECRET_EXPR = '{{resolve:secretsmanager:app/db:SecretString:password::}}';
/** What the legacy index holds after the secret ROTATED — neither value nor expression. */
const ROTATED_AWAY_PLAINTEXT = 'the-previous-generation-of-that-password';

vi.mock('../../../../src/deployment/intrinsic-function-resolver.js', async () => {
  const actual = await vi.importActual<
    typeof import('../../../../src/deployment/intrinsic-function-resolver.js')
  >('../../../../src/deployment/intrinsic-function-resolver.js');
  return {
    ...actual,
    IntrinsicFunctionResolver: vi.fn().mockImplementation(() => ({
      resolveParameters: vi.fn().mockResolvedValue({}),
      evaluateConditions: vi.fn().mockResolvedValue({}),
      resolve: vi
        .fn()
        .mockImplementation(
          (value: unknown, ctx: { recordedSecretValues?: Map<string, string> }) => {
            const walk = (v: unknown): unknown => {
              if (v === SECRET_EXPR) {
                // LIVE RESOLUTION: the plaintext comes from AWS, so it is
                // recorded on every run, including one over already-scrubbed
                // state. That is what makes a re-run's map populated.
                ctx.recordedSecretValues?.set(SECRET_PLAINTEXT, SECRET_EXPR);
                return SECRET_PLAINTEXT;
              }
              if (Array.isArray(v)) return v.map(walk);
              if (v && typeof v === 'object') {
                const out: Record<string, unknown> = {};
                for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
                  out[k] = walk(val);
                }
                return out;
              }
              return v;
            };
            return Promise.resolve(walk(value));
          }
        ),
    })),
  };
});

import {
  scrubCommand,
  planExportIndexRepair,
  ScrubNeededError,
  type ScrubOptions,
} from '../../../../src/cli/commands/scrub.js';

function commandOptions(overrides: Partial<ScrubOptions> = {}): ScrubOptions {
  return { output: 'cdk.out', statePrefix: 'cdkd', verbose: false, all: true, ...overrides };
}

function makeStackInfo(
  stackName: string,
  region?: string
): { stackName: string; region?: string; template: CloudFormationTemplate } {
  return {
    stackName,
    ...(region && { region }),
    template: {
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
        },
      },
      Outputs: { Db: { Value: SECRET_EXPR, Export: { Name: `${stackName}:Db` } } },
    },
  };
}

/** @param scrubbed whether the record already holds the expression (a re-run). */
function makeState(stackName: string, region: string, scrubbed: boolean): StackState {
  const stored = scrubbed ? SECRET_EXPR : SECRET_PLAINTEXT;
  return {
    version: 9,
    region,
    stackName,
    resources: {
      Db: {
        physicalId: 'db-1',
        resourceType: 'AWS::RDS::DBInstance',
        properties: { MasterUserPassword: stored, MasterUsername: 'admin' },
      },
    },
    outputs: { Db: stored, [`${stackName}:Db`]: stored },
    exportNames: [`${stackName}:Db`],
    lastModified: 0,
  };
}

function slot(overrides: Partial<IndexRegionSlot> = {}): IndexRegionSlot {
  return { entries: new Map(), patchOk: true, patches: [], reads: 0, ...overrides };
}

function entry(
  value: unknown,
  producerStack: string,
  producerRegion: string
): ExportIndexEntry {
  return { value, producerStack, producerRegion };
}

function logLines(): string {
  return [
    ...commandLogger.info.mock.calls,
    ...commandLogger.warn.mock.calls,
    ...commandLogger.error.mock.calls,
  ]
    .map((c) => c.join(' '))
    .join('\n');
}

beforeEach(() => {
  vi.clearAllMocks();
  synthStacks.length = 0;
  indexFake.regions.clear();
  indexFake.ctorRegions.length = 0;
  indexFake.ctorArgs.length = 0;
  commandStateBackend.saveState.mockResolvedValue('etag-2');
});

describe('planExportIndexRepair — the convergence rule, both directions', () => {
  const OWNED = 'MyStack:Db';

  it('converges an entry whose value differs from a state value carrying {{resolve:', () => {
    const entries = new Map([[OWNED, entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', {
      [OWNED]: SECRET_EXPR,
    });

    expect(plan.examined).toEqual([OWNED]);
    expect(plan.findings).toEqual([
      { kind: 'converge', exportName: OWNED, stateValue: SECRET_EXPR },
    ]);
  });

  it('converges an entry holding a value that ROTATED AWAY, which no byte match reaches', () => {
    // The arm that decided the rule. Scrub's plaintext map holds the secret's
    // CURRENT value; this entry holds the previous one, so a rule keyed on the
    // map would leave the old credential readable while reporting success.
    const entries = new Map([[OWNED, entry(ROTATED_AWAY_PLAINTEXT, 'MyStack', 'us-east-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', {
      [OWNED]: SECRET_EXPR,
    });

    expect(plan.findings).toEqual([
      { kind: 'converge', exportName: OWNED, stateValue: SECRET_EXPR },
    ]);
  });

  it('THE OTHER DIRECTION: leaves an entry whose state value carries no {{resolve:', () => {
    // A plain, non-secret export. Converging it onto a plaintext would move a
    // plaintext INTO the shared object; the entry is left alone and nothing is
    // reported for it.
    const entries = new Map([[OWNED, entry('index-side-value', 'MyStack', 'us-east-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', {
      [OWNED]: 'state-side-value',
    });

    expect(plan.examined).toEqual([OWNED]);
    expect(plan.findings).toEqual([]);
  });

  it('THE OTHER DIRECTION: leaves an entry that already equals the state value', () => {
    const entries = new Map([[OWNED, entry(SECRET_EXPR, 'MyStack', 'us-east-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', {
      [OWNED]: SECRET_EXPR,
    });

    expect(plan.findings).toEqual([]);
  });

  it('compares LIST-valued outputs structurally, not by reference', () => {
    // `state.outputs` is not string-coerced: a list-valued `Fn::GetAtt` used as
    // an Output value persists an array. Two structurally equal arrays are two
    // objects, so `!==` alone would report every such export as divergent and
    // rewrite it on every run.
    const equal = new Map([[OWNED, entry([SECRET_EXPR, 'b'], 'MyStack', 'us-east-1')]]);
    expect(
      planExportIndexRepair(equal, 'MyStack', 'us-east-1', { [OWNED]: [SECRET_EXPR, 'b'] }).findings
    ).toEqual([]);

    const differing = new Map([[OWNED, entry([SECRET_PLAINTEXT, 'b'], 'MyStack', 'us-east-1')]]);
    expect(
      planExportIndexRepair(differing, 'MyStack', 'us-east-1', { [OWNED]: [SECRET_EXPR, 'b'] })
        .findings
    ).toEqual([{ kind: 'converge', exportName: OWNED, stateValue: [SECRET_EXPR, 'b'] }]);
  });
});

describe('planExportIndexRepair — ownership is read off the entry', () => {
  const NAME = 'Shared:Db';

  it('does not examine an entry published by ANOTHER stack under the same name', () => {
    // A pre-v9 record makes every output key importable, so an index can carry
    // an entry named for a key this stack also has. The name is not the
    // discriminator.
    const entries = new Map([[NAME, entry(SECRET_PLAINTEXT, 'OtherStack', 'us-east-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', { [NAME]: SECRET_EXPR });

    expect(plan.examined).toEqual([]);
    expect(plan.findings).toEqual([]);
  });

  it('does not examine an entry published by the same stack in ANOTHER region', () => {
    const entries = new Map([[NAME, entry(SECRET_PLAINTEXT, 'MyStack', 'eu-west-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', { [NAME]: SECRET_EXPR });

    expect(plan.examined).toEqual([]);
    expect(plan.findings).toEqual([]);
  });

  it('examines the owned entry and leaves its same-named neighbours alone', () => {
    const entries = new Map([
      ['Mine', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')],
      ['Theirs', entry(SECRET_PLAINTEXT, 'OtherStack', 'us-east-1')],
      ['Elsewhere', entry(SECRET_PLAINTEXT, 'MyStack', 'eu-west-1')],
    ]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', {
      Mine: SECRET_EXPR,
      Theirs: SECRET_EXPR,
      Elsewhere: SECRET_EXPR,
    });

    expect(plan.examined).toEqual(['Mine']);
    expect(plan.findings).toEqual([
      { kind: 'converge', exportName: 'Mine', stateValue: SECRET_EXPR },
    ]);
  });
});

describe('planExportIndexRepair — the ABSENT-key report path', () => {
  it('reports an owned entry whose name is not a key of state.outputs', () => {
    const entries = new Map([['Ghost', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', { Other: SECRET_EXPR });

    // EXAMINED, so the coverage report does not double-count it as unexamined,
    // and reported rather than skipped.
    expect(plan.examined).toEqual(['Ghost']);
    expect(plan.findings).toEqual([{ kind: 'absent', exportName: 'Ghost' }]);
  });

  it('reports every owned entry when the stack has NO state record at all', () => {
    const entries = new Map([
      ['A', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')],
      ['B', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')],
    ]);

    const plan = planExportIndexRepair(entries, 'MyStack', 'us-east-1', undefined);

    expect(plan.findings).toEqual([
      { kind: 'absent', exportName: 'A' },
      { kind: 'absent', exportName: 'B' },
    ]);
  });
});

describe('cdkd scrub converges the exports index after state.json (issue #2667)', () => {
  it('a REAL run writes the state value into the owned entry and adds no name', async () => {
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', false),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([
        ['MyStack:Db', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')],
        ['Foreign:Db', entry('untouched', 'OtherStack', 'us-east-1')],
      ]),
    });
    indexFake.regions.set('us-east-1', region);

    await scrubCommand([], commandOptions());

    expect(commandStateBackend.saveState).toHaveBeenCalled();
    expect(region.patches).toEqual([
      {
        exportName: 'MyStack:Db',
        entry: { value: SECRET_EXPR, producerStack: 'MyStack', producerRegion: 'us-east-1' },
        // PINNED: the write re-asserts the ownership the PLAN read off a
        // snapshot, so an If-Match retry that reloaded a concurrent deploy's
        // claim on this name refuses instead of resurrecting this stack's
        // value.
        requireOwner: { producerStack: 'MyStack', producerRegion: 'us-east-1' },
      },
    ]);
    // Membership unchanged: nothing added, nothing removed, and the foreign
    // entry is untouched.
    expect([...region.entries!.keys()].sort()).toEqual(['Foreign:Db', 'MyStack:Db']);
    expect(region.entries!.get('Foreign:Db')!.value).toBe('untouched');
    expect(logLines()).toContain('Converged exports index entry');
  });

  it('--dry-run READS the index and writes nothing; --fail exits non-zero over the divergence', async () => {
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', false),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([['MyStack:Db', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]),
    });
    indexFake.regions.set('us-east-1', region);

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).rejects.toBeInstanceOf(ScrubNeededError);

    // The READ happened — scrub's plaintext map comes from live resolution, so
    // the audit half runs under --dry-run — and no write did.
    expect(region.reads).toBeGreaterThan(0);
    expect(region.patches).toEqual([]);
    expect(region.entries!.get('MyStack:Db')!.value).toBe(SECRET_PLAINTEXT);
    expect(commandStateBackend.saveState).not.toHaveBeenCalled();
    expect(logLines()).toContain('Would converge exports index entry');
  });

  it('a --dry-run audit reddens on the INDEX even where state.json is already clean', async () => {
    // The gate this issue leads with: state records hold the expression, the
    // index still holds the plaintext, and `--dry-run --fail` used to exit 0.
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([['MyStack:Db', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]),
    });
    indexFake.regions.set('us-east-1', region);

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).rejects.toBeInstanceOf(ScrubNeededError);

    // MEDIUM from the #2667 review: the `indexConverged === 0` guard on the
    // per-stack clean line had no coverage, so deleting it reddened nothing
    // while the mutant printed "No plaintext secrets found in MyStack"
    // directly beside "Would converge exports index entry". The line's own
    // claim stays true — it is about state RECORDS — but printed next to a
    // reported divergence it reads as covering it.
    expect(logLines()).toContain('Would converge exports index entry');
    expect(logLines()).not.toContain('No plaintext secrets found in MyStack');
  });

  it('NEGATIVE CONTROL: a converged index over clean state exits 0 under --dry-run --fail', async () => {
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    indexFake.regions.set(
      'us-east-1',
      slot({ entries: new Map([['MyStack:Db', entry(SECRET_EXPR, 'MyStack', 'us-east-1')]]) })
    );

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).resolves.toBeUndefined();
  });

  it('a FAILED index write is an explicit failure naming the remainder', async () => {
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', false),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([['MyStack:Db', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]),
      patchOk: false,
    });
    indexFake.regions.set('us-east-1', region);

    // NOT a warn-and-continue: the entry keeps the plaintext, so exiting 0 here
    // is the false success this issue is about.
    await expect(scrubCommand([], commandOptions())).rejects.toMatchObject({
      code: 'SCRUB_EXPORT_INDEX_INCOMPLETE',
      exitCode: 2,
    });
    const err = await scrubCommand([], commandOptions()).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('state.json complete');
    expect(err!.message).toContain('1 exports index entry unwritten');
    expect(err!.message).toContain("'MyStack:Db' in us-east-1");
  });

  it('an UNREADABLE index is an explicit failure too, under --dry-run as well', async () => {
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    indexFake.regions.set(
      'us-east-1',
      slot({ entries: new Map(), readError: new Error('Access Denied on _index') })
    );

    await expect(scrubCommand([], commandOptions({ dryRun: true }))).rejects.toMatchObject({
      code: 'SCRUB_EXPORT_INDEX_INCOMPLETE',
    });
  });

  it('a CORRUPT index is an explicit failure, not a silent green gate', async () => {
    // BLOCKER from the #2667 review. `readPersistedEntries` used to collapse
    // "missing" and "corrupt" into one `undefined`, so an index whose bytes
    // cdkd cannot parse — bytes that may still hold the plaintext — produced
    // no finding, no warn, and `--dry-run --fail` exited 0 over it. That is
    // this issue's own failure shape reproduced inside its fix.
    //
    // The MISSING case is covered separately below and must stay exit 0; that
    // pair is what makes this assertion about corruption rather than about
    // "any unusual index".
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    indexFake.regions.set(
      'us-east-1',
      slot({
        entries: new Map(),
        readError: new Error('Exports index at cdkd/_index/us-east-1/exports.json could not be parsed'),
      })
    );

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).rejects.toMatchObject({ code: 'SCRUB_EXPORT_INDEX_INCOMPLETE', exitCode: 2 });
    expect(logLines()).toContain('could not be parsed');
  });

  it('the failure message does not claim a write under --dry-run', async () => {
    // `state.json complete` is a claim about a WRITE. Under `--dry-run`
    // nothing was written, and the only way to reach this error is a read that
    // failed.
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    indexFake.regions.set(
      'us-east-1',
      slot({ entries: new Map(), readError: new Error('Access Denied on _index') })
    );

    const err = await scrubCommand([], commandOptions({ dryRun: true })).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('no state written (--dry-run)');
    expect(err!.message).not.toContain('state.json complete');
  });

  it('reports an unreadable region ONCE, however many stacks it holds', async () => {
    // `loadPersisted` memoizes no failure, so every stack in a region re-reads
    // and fails identically. Without the dedupe the failure message reads
    // `3 region(s) ... (us-east-1: X; us-east-1: X; us-east-1: X)`, which
    // misstates how many regions are affected.
    synthStacks.push(
      makeStackInfo('StackA'),
      makeStackInfo('StackB'),
      makeStackInfo('StackC')
    );
    commandStateBackend.getState.mockImplementation((stackName: string, region: string) =>
      Promise.resolve({ state: makeState(stackName, region, true), etag: 'etag-1' })
    );
    indexFake.regions.set(
      'us-east-1',
      slot({ entries: new Map(), readError: new Error('Access Denied on _index') })
    );

    const err = await scrubCommand([], commandOptions()).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err!.message).toContain('1 region(s)');
    expect(err!.message).not.toContain('3 region(s)');
    // One error line, not one per stack.
    expect(commandLogger.error.mock.calls.filter((c) => String(c[0]).includes('us-east-1'))).toHaveLength(1);
  });

  it('RE-RUN: the second invocation writes nothing and exits 0', async () => {
    // What makes the failure above recoverable. The rule reads
    // `state.outputs`, which the first run's write already matches, so the
    // remainder is empty on the second pass.
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', false),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([['MyStack:Db', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]),
    });
    indexFake.regions.set('us-east-1', region);

    await scrubCommand([], commandOptions());
    expect(region.patches).toHaveLength(1);

    // The record is now scrubbed, which is what a real second run reads.
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-2',
    });
    await expect(scrubCommand([], commandOptions())).resolves.toBeUndefined();
    expect(region.patches).toHaveLength(1);
  });

  it('reports an owned entry ABSENT from state.outputs without failing the gate', async () => {
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([['Ghost', entry(SECRET_PLAINTEXT, 'MyStack', 'us-east-1')]]),
    });
    indexFake.regions.set('us-east-1', region);

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).resolves.toBeUndefined();

    expect(region.patches).toEqual([]);
    expect(logLines()).toContain("Exports index entry 'Ghost'");
    expect(logLines()).toContain('has no key of that name');
  });

  it('reports UNEXAMINED entries as coverage and does not fail the gate', async () => {
    // `--all` targets every stack in the SYNTHESIZED APP, and one bucket and
    // region are legitimately shared by several apps, so another app's entries
    // are permanently unexaminable from here. Failing on them would be a gate
    // nobody running this app could clear.
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', true),
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([
        ['MyStack:Db', entry(SECRET_EXPR, 'MyStack', 'us-east-1')],
        ['OtherApp:Db', entry(SECRET_PLAINTEXT, 'AnotherAppStack', 'us-east-1')],
      ]),
    });
    indexFake.regions.set('us-east-1', region);

    await expect(
      scrubCommand([], commandOptions({ dryRun: true, fail: true }))
    ).resolves.toBeUndefined();

    expect(region.patches).toEqual([]);
    expect(logLines()).toContain('1 entry is');
    expect(logLines()).toContain('published by a producer this run did not scrub');
    // The coverage pass reads the region ONCE MORE at most — it is served from
    // the snapshot the per-stack pass loaded. Pinned because an unbounded
    // re-read per stack would be a GET per stack per region on every run.
    expect(region.reads).toBeLessThanOrEqual(2);
  });

  it('MULTI-REGION: one store and one exports.json per region, each converged', async () => {
    // The index key embeds the region, and scrub is per-stack-region. Examining
    // one region and reporting green would be a scaled-down instance of this
    // issue's own failure.
    synthStacks.push(makeStackInfo('EastStack'), makeStackInfo('WestStack', 'eu-west-1'));
    commandStateBackend.getState.mockImplementation((stackName: string, region: string) =>
      Promise.resolve({ state: makeState(stackName, region, false), etag: 'etag-1' })
    );
    const east = slot({
      entries: new Map([['EastStack:Db', entry(SECRET_PLAINTEXT, 'EastStack', 'us-east-1')]]),
    });
    const west = slot({
      entries: new Map([['WestStack:Db', entry(SECRET_PLAINTEXT, 'WestStack', 'eu-west-1')]]),
    });
    indexFake.regions.set('us-east-1', east);
    indexFake.regions.set('eu-west-1', west);

    await scrubCommand([], commandOptions());

    expect([...new Set(indexFake.ctorRegions)].sort()).toEqual(['eu-west-1', 'us-east-1']);
    expect(east.patches.map((p) => p.exportName)).toEqual(['EastStack:Db']);
    expect(west.patches.map((p) => p.exportName)).toEqual(['WestStack:Db']);
    expect(east.entries!.get('EastStack:Db')!.value).toBe(SECRET_EXPR);
    expect(west.entries!.get('WestStack:Db')!.value).toBe(SECRET_EXPR);
    // The store is constructed with the STACK's region, which is what selects
    // the `_index/{region}/exports.json` key.
    expect(indexFake.ctorArgs.map((a) => a[3])).toContain('eu-west-1');
  });

  it('a SECRET-BEARING export name is MASKED in every index message', async () => {
    // BLOCKER from the #2667 review. An export name is a key of
    // `state.outputs`, and a pre-#1919 binary could publish an `Export.Name`
    // built by `Fn::Sub` that embeds a secret — the residue this command
    // reports and cannot rewrite. `displaySafe` strips control characters; it
    // does not mask. These lines print at `info` / `warn` on the DOCUMENTED CI
    // gate path, into CI logs, on every run.
    const leakyName = `alias-${SECRET_PLAINTEXT}-suffix`;
    const info = makeStackInfo('MyStack');
    info.template.Outputs = { Db: { Value: SECRET_EXPR, Export: { Name: leakyName } } };
    synthStacks.push(info);
    commandStateBackend.getState.mockResolvedValue({
      state: {
        version: 9,
        region: 'us-east-1',
        stackName: 'MyStack',
        resources: {
          Db: {
            physicalId: 'db-1',
            resourceType: 'AWS::RDS::DBInstance',
            properties: { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
          },
        },
        outputs: { Db: SECRET_EXPR, [leakyName]: SECRET_EXPR },
        exportNames: [leakyName],
        lastModified: 0,
      } satisfies StackState,
      etag: 'etag-1',
    });
    const region = slot({
      entries: new Map([[leakyName, entry('legacy-index-value', 'MyStack', 'us-east-1')]]),
    });
    indexFake.regions.set('us-east-1', region);

    await scrubCommand([], commandOptions());

    // The repair still happened — masking must not cost the fix.
    expect(region.patches.map((p) => p.exportName)).toEqual([leakyName]);
    // THE ASSERTION: the plaintext never reaches a message, and the line that
    // names the entry says it masked it.
    const out = logLines();
    expect(out).not.toContain(SECRET_PLAINTEXT);
    expect(out).toContain('Converged exports index entry (masked:');
  });

  it('a masked name reaches the FAILURE message too, not just the log', async () => {
    const leakyName = `alias-${SECRET_PLAINTEXT}-suffix`;
    const info = makeStackInfo('MyStack');
    info.template.Outputs = { Db: { Value: SECRET_EXPR, Export: { Name: leakyName } } };
    synthStacks.push(info);
    commandStateBackend.getState.mockResolvedValue({
      state: {
        version: 9,
        region: 'us-east-1',
        stackName: 'MyStack',
        resources: {
          Db: {
            physicalId: 'db-1',
            resourceType: 'AWS::RDS::DBInstance',
            properties: { MasterUserPassword: SECRET_EXPR, MasterUsername: 'admin' },
          },
        },
        outputs: { Db: SECRET_EXPR, [leakyName]: SECRET_EXPR },
        exportNames: [leakyName],
        lastModified: 0,
      } satisfies StackState,
      etag: 'etag-1',
    });
    indexFake.regions.set(
      'us-east-1',
      slot({
        entries: new Map([[leakyName, entry('legacy-index-value', 'MyStack', 'us-east-1')]]),
        patchOk: false,
      })
    );

    const err = await scrubCommand([], commandOptions()).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err).toBeInstanceOf(Error);
    // The error is rendered by `handleError` and the top-level console.error,
    // which walk the whole cause chain — the reader a per-site mask cannot
    // close, which is why the name is masked BEFORE it is stored.
    expect(err!.message).not.toContain(SECRET_PLAINTEXT);
    expect(err!.message).toContain('masked:');
  });

  it('a TRANSIENT failure on the coverage read is recorded, not thrown out of the command', async () => {
    // Reachable exactly when the per-stack read found NO index: `loadState`
    // stays unloaded, so the coverage pass issues a second GET. Unwrapped,
    // that throw escapes the summary and leaves the command with `state.json`
    // already rewritten and no explanation.
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', false),
      etag: 'etag-1',
    });
    // `entries: undefined` = no index object, so the per-stack read returns
    // undefined and the coverage pass reads again; the 2nd read throws.
    indexFake.regions.set('us-east-1', slot({ entries: undefined, readErrorFrom: 2 }));

    const err = await scrubCommand([], commandOptions()).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    // An explicit cdkd failure, not a raw escape: the code is what says the
    // command ended on its own terms.
    expect(err).toMatchObject({ code: 'SCRUB_EXPORT_INDEX_INCOMPLETE' });
    expect(logLines()).toContain('could not be read for the coverage report');
    // The state write still happened and is still reported, which is what the
    // failure message has to be honest about.
    expect(commandStateBackend.saveState).toHaveBeenCalled();
  });

  it('a region with no exports.json contributes no finding and no failure', async () => {
    // `readPersistedEntries` reports a missing object without rebuilding it, so
    // an app that publishes no exports is unaffected.
    synthStacks.push(makeStackInfo('MyStack'));
    commandStateBackend.getState.mockResolvedValue({
      state: makeState('MyStack', 'us-east-1', false),
      etag: 'etag-1',
    });
    indexFake.regions.set('us-east-1', slot({ entries: undefined }));

    await expect(scrubCommand([], commandOptions())).resolves.toBeUndefined();
    expect(logLines()).not.toContain('exports index entry');
  });
});
