/**
 * go-to-k/cdkd#4705 (C): the plan-time check of the names cdkd GENERATES for
 * the creates of name-adopting types (`src/deployment/generated-name-guard.ts`):
 * which creates it asks about, that it batches per type and starts everything
 * at once, each verdict, the license sources, and the intent ledger: written
 * only when a create is admitted (never at plan time), one write per wave,
 * and settled at the deploy's end (review CB-1).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const ledger = vi.hoisted(() => ({
  recorded: new Map<string, { resourceType: string; name: string }>() as
    | Map<string, { resourceType: string; name: string }>
    | undefined,
  readError: undefined as Error | undefined,
  writeError: undefined as Error | undefined,
  writes: [] as Array<Array<{ logicalId: string; resourceType: string; name: string }>>,
  drops: [] as string[][],
  failedStamps: [] as Array<Map<string, number>>,
  settleFailures: 0,
  abandonedNotes: [] as number[],
  abandonedNoteOk: true,
  abandonedAt: undefined as number | undefined,
}));
vi.mock('../../../src/provisioning/providers/create-token-ledger.js', () => ({
  recordedAdoptingCreates: vi.fn(async () => {
    if (ledger.readError) throw ledger.readError;
    return ledger.recorded;
  }),
  recordAdoptingCreates: vi.fn(async (creates: Array<{ logicalId: string; resourceType: string; name: string }>) => {
    if (ledger.writeError) throw ledger.writeError;
    ledger.writes.push(creates);
  }),
  settleAdoptingCreates: vi.fn(async (ids: string[], failedAt: Map<string, number> = new Map()) => {
    if (ledger.settleFailures > 0) {
      ledger.settleFailures--;
      throw Object.assign(new Error('internal'), { $metadata: { httpStatusCode: 500 } });
    }
    ledger.drops.push([...ids]);
    ledger.failedStamps.push(new Map(failedAt));
  }),
  noteAbandonedRun: vi.fn(async (at: number) => {
    ledger.abandonedNotes.push(at);
    return ledger.abandonedNoteOk;
  }),
  ledgerAbandonedAt: vi.fn(async () => ledger.abandonedAt),
}));

import {
  GeneratedNameGuard,
  provenNothingCreated,
  type GeneratedNameGuardInput,
} from '../../../src/deployment/generated-name-guard.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
import {
  disarmInterruptWatchForTests,
  interruptWatchTestSeam,
  isInterruptedWaitError,
} from '../../../src/provisioning/interrupt-watch.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

const accessDenied = (): Error =>
  Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });

const create = (logicalId: string, resourceType: string, properties: Record<string, unknown> = {}): ResourceChange => ({
  logicalId,
  changeType: 'CREATE',
  resourceType,
  desiredProperties: properties,
});

/** A provider whose generated name is `gen-<logicalId>` and whose holders are `holders`. */
function providerOf(holders: Record<string, string> = {}, opts: { batch?: boolean; lookupError?: Error } = {}) {
  const provider = {
    generatedCreateName: vi.fn((_type: string, logicalId: string, properties: Record<string, unknown>) =>
      properties['Name'] || properties['QueueName'] ? undefined : `gen-${logicalId}`
    ),
    lookupNames: vi.fn(async (_type: string, names: readonly string[]) => {
      if (opts.lookupError) throw opts.lookupError;
      return new Map(names.flatMap((n) => (holders[n] ? [[n, holders[n]!] as const] : [])));
    }),
    import: vi.fn(async (input: { properties: Record<string, unknown>; knownPhysicalId?: string }) => {
      // By the ARN the name would take (SNS, Step Functions), else by name.
      if (input.knownPhysicalId !== undefined) {
        const held = Object.values(holders).includes(input.knownPhysicalId);
        return held ? { physicalId: input.knownPhysicalId, attributes: {} } : null;
      }
      const name = String(input.properties['QueueName'] ?? input.properties['Name'] ?? '');
      return holders[name] ? { physicalId: holders[name]!, attributes: {} } : null;
    }),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  if (opts.batch === false) delete (provider as Partial<typeof provider>).lookupNames;
  return provider;
}

function inputOf(
  changes: ResourceChange[],
  providers: Record<string, ReturnType<typeof providerOf>>,
  extra: Partial<GeneratedNameGuardInput> = {}
): GeneratedNameGuardInput {
  return {
    stackName: 'App',
    region: 'us-east-1',
    changes,
    providerFor: ({ resourceType }) => ({
      provider: providers[resourceType] as unknown as ResourceProvider,
      provisionedBy: 'sdk',
    }),
    records: {},
    orphans: undefined,
    loadJournal: vi.fn(async () => null),
    // No retained.json: this cdkd never destroyed the stack here.
    loadRetained: vi.fn(async () => null),
    accountInfo: vi.fn(async () => ({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' })),
    // No deletion-cooldown re-reads unless a case asks for them.
    timing: { cooldownMs: 0 },
    ...extra,
  };
}

const QUEUE = 'AWS::SQS::Queue';
const TOPIC = 'AWS::SNS::Topic';
const LOGS = 'AWS::Logs::LogGroup';
const ALARM = 'AWS::CloudWatch::Alarm';
const RULE = 'AWS::Events::Rule';
const BUCKET = 'AWS::S3::Bucket';
const ROLE = 'AWS::IAM::Role';

beforeEach(() => {
  ledger.recorded = new Map();
  ledger.readError = undefined;
  ledger.writeError = undefined;
  ledger.writes = [];
  ledger.drops = [];
  ledger.failedStamps = [];
  ledger.settleFailures = 0;
  ledger.abandonedNotes = [];
  ledger.abandonedNoteOk = true;
  ledger.abandonedAt = undefined;
});

/** Admit every id (the creates of one wave), as the engine does right before sending. */
const admitAll = (guard: GeneratedNameGuard, ids: string[]) =>
  Promise.all(ids.map((id) => guard.admit(id, {})));

describe('which creates are asked about', () => {
  it('only CREATE rows of name-adopting types whose name cdkd generates', () => {
    const q = providerOf();
    const role = providerOf();
    const guard = GeneratedNameGuard.start(
      inputOf(
        [
          create('Gen', QUEUE),
          create('Named', QUEUE, { QueueName: 'mine' }),
          { ...create('Upd', QUEUE), changeType: 'UPDATE' },
          { ...create('Same', QUEUE), changeType: 'NO_CHANGE' },
          create('Role', ROLE),
        ],
        { [QUEUE]: q, [ROLE]: role }
      )
    );
    expect(guard?.verdict('Gen')).toBeDefined();
    for (const id of ['Named', 'Upd', 'Same', 'Role']) expect(guard?.verdict(id), id).toBeUndefined();
    // A type that natively fails with AlreadyExists (IAM Role) is never probed.
    expect(role.lookupNames).not.toHaveBeenCalled();
    expect(role.import).not.toHaveBeenCalled();
  });

  it('a create routed to Cloud Control is not asked about (its handler refuses an existing name)', () => {
    const q = providerOf();
    const guard = GeneratedNameGuard.start({
      ...inputOf([create('Gen', QUEUE)], { [QUEUE]: q }),
      providerFor: () => ({ provider: q as unknown as ResourceProvider, provisionedBy: 'cc-api' }),
    });
    expect(guard).toBeUndefined();
    expect(q.lookupNames).not.toHaveBeenCalled();
  });

  it('a redeploy with no creates reads and writes nothing', () => {
    const q = providerOf();
    expect(GeneratedNameGuard.start(inputOf([{ ...create('A', QUEUE), changeType: 'UPDATE' }], { [QUEUE]: q }))).toBeUndefined();
    expect(q.lookupNames).not.toHaveBeenCalled();
    expect(ledger.writes).toEqual([]);
  });
});

describe('batched per type, all started at once', () => {
  it('20 creates across 6 types: one lookup per type, every one started before any verdict is awaited', () => {
    const types = [QUEUE, TOPIC, LOGS, ALARM, RULE, BUCKET];
    const providers = Object.fromEntries(types.map((t) => [t, providerOf()]));
    const changes = Array.from({ length: 20 }, (_, i) => create(`R${i}`, types[i % types.length]!));
    GeneratedNameGuard.start(inputOf(changes, providers));
    // Synchronously after start: every type's lookup is already in flight.
    for (const t of types) expect(providers[t]!.lookupNames, t).toHaveBeenCalledTimes(1);
    const total = types.reduce((n, t) => n + providers[t]!.lookupNames.mock.calls.length, 0);
    expect(total).toBe(6);
    expect(providers[QUEUE]!.lookupNames.mock.calls[0]![1]).toEqual(['gen-R0', 'gen-R6', 'gen-R12', 'gen-R18']);
  });

  it('a provider without lookupNames (SNS, Step Functions) is read name by name through import(), by exact ARN', async () => {
    const noBatch = providerOf({ 'gen-A': 'held-A' }, { batch: false });
    const asks = providerOf({ 'gen-T': 'arn:aws:sns:us-east-1:123456789012:gen-T' }, { batch: false });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('T', TOPIC)], { [QUEUE]: noBatch, [TOPIC]: asks })
    )!;
    await expect(guard.verdict('A')).resolves.toMatchObject({ kind: 'held', holder: 'held-A' });
    await expect(guard.verdict('T')).resolves.toMatchObject({ kind: 'held' });
    // SNS by the ARN the name would take.
    expect(asks.import.mock.calls[0]![0]).toMatchObject({
      knownPhysicalId: 'arn:aws:sns:us-east-1:123456789012:gen-T',
    });
  });
});

describe('the verdicts', () => {
  it('free: no holder; nothing is written at plan time, and admitting a wave writes its intents in ONE write', async () => {
    const q = providerOf();
    const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q }))!;
    await expect(guard.verdict('A')).resolves.toEqual({ kind: 'free' });
    expect(ledger.writes).toEqual([]);
    await expect(admitAll(guard, ['A', 'B'])).resolves.toEqual([{ kind: 'free' }, { kind: 'free' }]);
    expect(ledger.writes).toEqual([
      [
        { logicalId: 'A', resourceType: QUEUE, name: 'gen-A' },
        { logicalId: 'B', resourceType: QUEUE, name: 'gen-B' },
      ],
    ]);
  });

  it('held: a holder nothing of this stack names is refused, never recorded, and evidence was read', async () => {
    const q = providerOf({ 'gen-A': 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A' });
    const input = inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q });
    const guard = GeneratedNameGuard.start(input)!;
    await expect(guard.admit('A', {})).resolves.toMatchObject({ kind: 'held' });
    await expect(guard.admit('B', {})).resolves.toEqual({ kind: 'free' });
    expect(ledger.writes).toEqual([[{ logicalId: 'B', resourceType: QUEUE, name: 'gen-B' }]]);
    expect(input.loadJournal).toHaveBeenCalledTimes(1);
  });

  it('evidence is not read when no name is held', async () => {
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() });
    await GeneratedNameGuard.start(input)!.verdict('A');
    expect(input.loadJournal).not.toHaveBeenCalled();
    expect(input.loadRetained).not.toHaveBeenCalled();
  });

  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';
  const record = (physicalId: string): ResourceState =>
    ({ physicalId, resourceType: QUEUE, properties: {} }) as ResourceState;

  it.each([
    ['its state record (any logical id)', { records: { Other: record(URL) } }, 'record'],
    [
      'its rollback orphans',
      { orphans: [{ logicalId: 'A', orphanedAt: 1, state: record(URL) }] },
      'orphan',
    ],
    [
      "its journal's completed op",
      {
        loadJournal: async () => ({
          journalVersion: 1,
          stackName: 'App',
          region: 'us-east-1',
          segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [{ logicalId: 'A', changeType: 'CREATE', resourceType: QUEUE, physicalId: URL }], failedOperations: [] }],
        }),
      },
      'journal',
    ],
    [
      "its journal's failed op that recorded a physical id (a --no-rollback fix-forward)",
      {
        loadJournal: async () => ({
          journalVersion: 1,
          stackName: 'App',
          region: 'us-east-1',
          segments: [{ timestamp: 1, reason: 'no-rollback-failure', initialDeploy: false, operations: [], failedOperations: [{ logicalId: 'A', changeType: 'CREATE', resourceType: QUEUE, physicalId: URL, physicalIdRecoveredFromError: true }] }],
        }),
      },
      'journal',
    ],
    [
      'what a destroy of it under this prefix kept (retained.json)',
      { loadRetained: async () => [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL }] },
      'retained',
    ],
  ] as const)('licensed by %s', async (_what, extra, via) => {
    const q = providerOf({ 'gen-A': URL });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE)], { [QUEUE]: q }, extra as Partial<GeneratedNameGuardInput>)
    )!;
    await expect(guard.admit('A', {})).resolves.toEqual({ kind: 'licensed', holder: URL, via });
    // Recorded too once admitted: a re-run after a crash finds it as its own.
    expect(ledger.writes.flat().map((w) => w.logicalId)).toEqual(['A']);
  });

  it('licensed by the ledger: a re-run after a crash between the create and its record', async () => {
    ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-A' }]]);
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({
      kind: 'licensed',
      holder: URL,
      via: 'ledger',
    });
  });

  it('a ledger entry for ANOTHER name or type licenses nothing', async () => {
    ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-Other' }]]);
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'held' });
  });

  it("another backend's evidence licenses nothing: a holder of the same name is refused", async () => {
    // The pair: this prefix has no record, journal, ledger entry or kept record.
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({
      kind: 'held',
      holder: URL,
    });
  });

  it('a 403 on the lookup is unchecked (create, warning); any other failure refuses', async () => {
    const denied = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({}, { lookupError: accessDenied() }) })
    )!;
    await expect(denied.verdict('A')).resolves.toMatchObject({ kind: 'unchecked' });
    const failed = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({}, { lookupError: new Error('503') }) })
    )!;
    await expect(failed.verdict('A')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('evidence that cannot be read refuses a held name (fail closed)', async () => {
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
      loadJournal: async () => {
        throw new Error('journal unreadable');
      },
    });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('a ledger that cannot be written refuses the create at admission; one that cannot be read refuses a held name', async () => {
    ledger.writeError = new Error('ledger write failed');
    const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
    await expect(guard.admit('A', {})).resolves.toMatchObject({ kind: 'failed' });
    ledger.writeError = undefined;
    ledger.readError = new Error('ledger read failed');
    const again = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) })
    )!;
    await expect(again.verdict('A')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('an S3 403 (a bucket another account owns, or HeadBucket not granted) is unchecked: warn and create, never silently free (CB-4)', async () => {
    const bucket = providerOf({}, { batch: false });
    bucket.import.mockRejectedValue(accessDenied());
    const guard = GeneratedNameGuard.start(inputOf([create('B', BUCKET)], { [BUCKET]: bucket }))!;
    await expect(guard.verdict('B')).resolves.toMatchObject({ kind: 'unchecked' });
  });

  it('H-7: an S3 301 (the bucket exists in another region) is held, never failed', async () => {
    for (const redirect of [
      Object.assign(new Error('UnknownError'), { name: 'Unknown', $metadata: { httpStatusCode: 301 } }),
      Object.assign(new Error('moved'), { name: 'PermanentRedirect' }),
    ]) {
      const bucket = providerOf({}, { batch: false });
      bucket.import.mockRejectedValue(redirect);
      const guard = GeneratedNameGuard.start(inputOf([create('B', BUCKET)], { [BUCKET]: bucket }))!;
      await expect(guard.verdict('B')).resolves.toEqual({ kind: 'held', holder: 'gen-B' });
    }
    // Another type's 301-shaped failure stays a failure.
    const q = providerOf({}, { batch: false });
    q.import.mockRejectedValue(Object.assign(new Error('x'), { $metadata: { httpStatusCode: 301 } }));
    const other = GeneratedNameGuard.start(inputOf([create('T', TOPIC)], { [TOPIC]: q }))!;
    await expect(other.verdict('T')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('lists the creates that took back a kept resource and came back, for retained.json to let go', async () => {
    const q = providerOf({ 'gen-A': URL });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q }, {
        loadRetained: async () => [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL }],
      })
    )!;
    await admitAll(guard, ['A', 'B']);
    // Not yet sent: nothing was taken back.
    await expect(guard.readoptedFromRetained()).resolves.toEqual([]);
    guard.noteSent('A');
    guard.noteReturned('A');
    await expect(guard.readoptedFromRetained()).resolves.toEqual(['A']);
  });

  it('G1: evidence licenses only a holder of the SAME type (a record of another type with that id does not)', async () => {
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
      records: { Other: { physicalId: URL, resourceType: TOPIC, properties: {} } as ResourceState },
    });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'held' });
  });

  it('G2: a ledger intent of the same logical id and name but ANOTHER type licenses nothing', async () => {
    ledger.recorded = new Map([['A', { resourceType: TOPIC, name: 'gen-A' }]]);
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'held' });
  });
});

describe('deploy -> destroy (Retain) -> deploy (go-to-k/cdkd#4705 maintainer decision 1)', () => {
  it.each([
    [BUCKET, 'gen-B', false],
    [LOGS, 'gen-B', true],
  ] as const)(
    '%s: the same prefix takes the kept resource back; a deploy under another prefix is refused',
    async (type, held, batch) => {
      const provider = providerOf({ [held]: held }, { batch });
      if (!batch) provider.import.mockImplementation(async () => ({ physicalId: held, attributes: {} }));
      // This prefix: the destroy recorded what it kept.
      const same = GeneratedNameGuard.start(
        inputOf([create('B', type)], { [type]: provider }, {
          loadRetained: async () => [{ logicalId: 'B', resourceType: type, physicalId: held }],
        })
      )!;
      await expect(same.verdict('B')).resolves.toEqual({ kind: 'licensed', holder: held, via: 'retained' });
      // Another prefix or bucket: nothing of its own names the kept resource.
      const other = GeneratedNameGuard.start(inputOf([create('B', type)], { [type]: provider }))!;
      await expect(other.verdict('B')).resolves.toEqual({ kind: 'held', holder: held });
    }
  );
});

describe('the intent ledger across a deploy (review CB-1 / CB-16)', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';

  it('approval declined: no create admitted, nothing written, and the re-run finds the name held', async () => {
    const q = providerOf({ 'gen-A': URL });
    // The declined deploy: the plan was looked up, nothing was admitted.
    const declined = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: q }))!;
    await declined.verdict('A');
    await declined.settle();
    expect(ledger.writes).toEqual([]);
    expect(ledger.drops).toEqual([]);
    // Meanwhile another backend created the name; the re-run must not take it.
    const rerun = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: q }))!;
    await expect(rerun.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
  });

  it('a failed level: the sibling admitted but never sent has its intent dropped; the one sent and never returned keeps it', async () => {
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: providerOf() })
    )!;
    await admitAll(guard, ['A', 'B']);
    guard.noteSent('A'); // A's create was sent, and failed before returning.
    await guard.settle();
    expect(ledger.drops).toEqual([['B']]);
  });

  it('a create that returned (then rolled back, or recorded) has its intent dropped', async () => {
    const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
    await admitAll(guard, ['A']);
    guard.noteSent('A');
    guard.noteReturned('A');
    await guard.settle();
    expect(ledger.drops).toEqual([['A']]);
  });

  it('a crash between the create and its record (no settle) still licenses the re-run (decision 2)', async () => {
    const first = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
    await admitAll(first, ['A']);
    first.noteSent('A');
    // Process dies here: `settle` never runs; the ledger keeps the intent.
    ledger.recorded = new Map(ledger.writes.flat().map((w) => [w.logicalId, { resourceType: w.resourceType, name: w.name }]));
    const rerun = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }))!;
    await expect(rerun.verdict('A')).resolves.toEqual({ kind: 'licensed', holder: URL, via: 'ledger' });
  });

  it('creates admitted in separate waves write separately, each before its own create', async () => {
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: providerOf() })
    )!;
    await guard.admit('A', {});
    expect(ledger.writes).toEqual([[{ logicalId: 'A', resourceType: QUEUE, name: 'gen-A' }]]);
    await guard.admit('B', {});
    expect(ledger.writes.map((w) => w.map((e) => e.logicalId))).toEqual([['A'], ['B']]);
  });
});

describe('a lookup that needs the resolved properties waits for the create (review CB-18)', () => {
  it('an EventBridge rule on an unresolved bus is not looked up at plan time, then on its resolved bus', async () => {
    const rule = providerOf({ 'gen-R': 'arn:custom/gen-R' });
    (rule as unknown as { lookupNeedsResolvedProperties: unknown }).lookupNeedsResolvedProperties = (
      _t: string,
      p: Record<string, unknown>
    ) => typeof p['EventBusName'] === 'object';
    const guard = GeneratedNameGuard.start(
      inputOf([create('R', RULE, { EventBusName: { Ref: 'Bus' } })], { [RULE]: rule })
    )!;
    expect(rule.lookupNames).not.toHaveBeenCalled();
    await expect(guard.admit('R', { EventBusName: 'custom' })).resolves.toMatchObject({ kind: 'held' });
    const [, names, ctx] = rule.lookupNames.mock.calls[0]! as unknown as [
      string,
      string[],
      { propertiesByName: Map<string, Record<string, unknown>> },
    ];
    expect(names).toEqual(['gen-R']);
    expect(ctx.propertiesByName.get('gen-R')).toEqual({ EventBusName: 'custom' });
  });
});

describe('a name property the plan cannot read is skipped, never a crash (review CB-13)', () => {
  it('generatedCreateName throwing (an intrinsic Name) drops that create from the check only', async () => {
    const q = providerOf();
    q.generatedCreateName.mockImplementation((_t: string, logicalId: string) => {
      if (logicalId === 'Bad') throw new TypeError('name.replace is not a function');
      return `gen-${logicalId}`;
    });
    const guard = GeneratedNameGuard.start(inputOf([create('Bad', QUEUE), create('A', QUEUE)], { [QUEUE]: q }))!;
    expect(guard.candidate('Bad')).toBeUndefined();
    await expect(guard.verdict('A')).resolves.toEqual({ kind: 'free' });
  });
});

describe("a license from this prefix's own history (review CB-14b: a destroy by a cdkd that wrote no retained.json)", () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';

  it('a held name the history shows this stack kept, by the same id, type and logical id, is licensed', async () => {
    const loadKeptInHistory = vi.fn(async () => [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL }]);
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, { loadKeptInHistory });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({
      kind: 'licensed',
      holder: URL,
      via: 'history',
    });
  });

  it.each([
    ['another logical id', { logicalId: 'B', resourceType: QUEUE, physicalId: URL }],
    ['another type', { logicalId: 'A', resourceType: TOPIC, physicalId: URL }],
    ['another physical id', { logicalId: 'A', resourceType: QUEUE, physicalId: `${URL}x` }],
  ])('history naming %s licenses nothing', async (_what, kept) => {
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
      loadKeptInHistory: async () => [kept],
    });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'held' });
  });

  it('the history is read only for a held name nothing else licenses, and unreadable history licenses nothing', async () => {
    const loadKeptInHistory = vi.fn(async () => {
      throw new Error('unreadable');
    });
    const free = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }, { loadKeptInHistory });
    await GeneratedNameGuard.start(free)!.verdict('A');
    const recorded = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
      loadKeptInHistory,
      records: { A: { physicalId: URL, resourceType: QUEUE, properties: {} } as ResourceState },
    });
    await GeneratedNameGuard.start(recorded)!.verdict('A');
    expect(loadKeptInHistory).not.toHaveBeenCalled();
    const held = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, { loadKeptInHistory });
    await expect(GeneratedNameGuard.start(held)!.verdict('A')).resolves.toMatchObject({ kind: 'held' });
    expect(loadKeptInHistory).toHaveBeenCalledTimes(1);
  });
});

describe('review round CB2', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';
  const kept = [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL }];

  it('D-1: after this cdkd wrote retained.json (an orphan or destroy tombstone), the history licenses nothing', async () => {
    const loadKeptInHistory = vi.fn(async () => kept);
    const tombstoned = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
      loadRetained: async () => [],
      loadKeptInHistory,
    });
    await expect(GeneratedNameGuard.start(tombstoned)!.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
    expect(loadKeptInHistory).not.toHaveBeenCalled();
  });

  it('D-1: an older cdkd destroyed it (no retained.json at all): the history still licenses', async () => {
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
      loadRetained: async () => null,
      loadKeptInHistory: async () => kept,
    });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'licensed', via: 'history' });
  });

  describe('D-2: a kept resource licenses only a holder created no later than it was kept', () => {
    const KEPT_AT = Date.parse('2026-09-01T00:00:00Z');
    const LOGS_NAME = '/cdkd/App-gen-L';
    it.each([
      [QUEUE, 'gen-A', URL],
      [LOGS, 'gen-L', LOGS_NAME],
    ])('%s: the original (created before) is taken back; a twin re-created after is refused', async (type, name, id) => {
      for (const [createdAt, expected] of [
        [KEPT_AT - 86_400_000, 'licensed'],
        [KEPT_AT + 3_600_000, 'held'],
      ] as const) {
        const provider = providerOf({ [name]: id });
        (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(async () => createdAt);
        const retained = inputOf([create(name.slice(4), type)], { [type]: provider }, {
          loadRetained: async () => [{ logicalId: name.slice(4), resourceType: type, physicalId: id, keptAt: KEPT_AT }],
        });
        await expect(GeneratedNameGuard.start(retained)!.verdict(name.slice(4)), `${type} retained ${expected}`).resolves.toMatchObject({ kind: expected });
        const history = inputOf([create(name.slice(4), type)], { [type]: provider }, {
          loadKeptInHistory: async () => [{ logicalId: name.slice(4), resourceType: type, physicalId: id, keptAt: KEPT_AT }],
        });
        await expect(GeneratedNameGuard.start(history)!.verdict(name.slice(4)), `${type} history ${expected}`).resolves.toMatchObject({ kind: expected });
      }
    });

    it.each([
      [30_000, 'licensed'],
      [90_000, 'held'],
    ] as const)('E-6: the 60 s clock-skew allowance: a holder %i ms after keptAt is %s', async (after, kind) => {
      const provider = providerOf({ 'gen-A': URL });
      (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(async () => KEPT_AT + after);
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: provider }, {
        loadRetained: async () => [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL, keptAt: KEPT_AT }],
      });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind });
    });

    it('a type that reports no creation time, or an entry with no keptAt, licenses by name (the documented residual)', async () => {
      const provider = providerOf({ 'gen-A': URL });
      (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(async () => undefined);
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: provider }, {
        loadRetained: async () => [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL, keptAt: KEPT_AT }],
      });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'licensed', via: 'retained' });
      const noKeptAt = providerOf({ 'gen-A': URL });
      const read = vi.fn(async () => KEPT_AT + 3_600_000);
      (noKeptAt as unknown as { holderCreatedAt: unknown }).holderCreatedAt = read;
      const legacy = inputOf([create('A', QUEUE)], { [QUEUE]: noKeptAt }, { loadRetained: async () => kept });
      await expect(GeneratedNameGuard.start(legacy)!.verdict('A')).resolves.toMatchObject({ kind: 'licensed' });
      expect(read).not.toHaveBeenCalled();
    });

    it('a creation time that cannot be read refuses (fail closed); a 403 licenses by name (S-2)', async () => {
      for (const [error, kind] of [
        [new Error('503'), 'failed'],
        [accessDenied(), 'licensed'],
      ] as const) {
        const provider = providerOf({ 'gen-A': URL });
        (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(async () => {
          throw error;
        });
        const input = inputOf([create('A', QUEUE)], { [QUEUE]: provider }, {
          loadRetained: async () => [{ ...kept[0]!, keptAt: KEPT_AT }],
        });
        await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind });
      }
    });
  });

  describe('D-3: a create that threw keeps its intent only when its outcome is unknown', () => {
    const status = (code: number, name = 'Err') =>
      Object.assign(new Error(name), { name, $metadata: { httpStatusCode: code } });
    it.each([
      ['a validation 400', status(400, 'InvalidParameterValue'), true],
      ['AlreadyExists 409', status(409, 'AlreadyExistsException'), true],
      ['AccessDenied 403', status(403, 'AccessDenied'), true],
      ['wrapped under a provider error', Object.assign(new Error('wrap'), { cause: status(400, 'ValidationError') }), true],
      ['a throttle', status(400, 'ThrottlingException'), false],
      ['a 429', status(429, 'TooManyRequestsException'), false],
      ['a 408 (E-4: the request may have been processed)', status(408, 'RequestTimeout'), false],
      ['a 503', status(503, 'ServiceUnavailable'), false],
      ['a client timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), false],
      ['a socket reset', Object.assign(new Error('r'), { code: 'ECONNRESET' }), false],
      ['no status at all', new Error('boom'), false],
    ])('%s: proven nothing created = %s', async (_what, error, proven) => {
      expect(provenNothingCreated(error, 'A', QUEUE)).toBe(proven);
      const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
      await guard.admit('A', {});
      guard.noteSent('A');
      guard.noteFailed('A', error);
      await guard.settle();
      // Unknown outcome: kept, and stamped with when it came back failed (S-6).
      expect(ledger.drops).toEqual(proven ? [['A']] : [[]]);
      expect([...(ledger.failedStamps[0]?.keys() ?? [])]).toEqual(proven ? [] : ['A']);
    });
  });

  it('D-9: SNS topics are read at most 4 at a time', async () => {
    const topic = providerOf({}, { batch: false });
    let inFlight = 0;
    let peak = 0;
    topic.import.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return null;
    });
    const changes = Array.from({ length: 12 }, (_, i) => create(`T${i}`, TOPIC));
    const guard = GeneratedNameGuard.start(inputOf(changes, { [TOPIC]: topic }))!;
    await guard.verdict('T0');
    expect(topic.import).toHaveBeenCalledTimes(12);
    expect(peak).toBeLessThanOrEqual(4);
  });

  describe('D-10: a held queue or bucket is read again across its deletion cooldown before it is refused', () => {
    const timing = (): { sleeps: number[]; t: { now: () => number; sleep: (ms: number) => Promise<void>; cooldownMs: number; cooldownStepMs: number } } => {
      let clock = 0;
      const sleeps: number[] = [];
      return {
        sleeps,
        t: {
          now: () => clock,
          sleep: async (ms: number) => {
            sleeps.push(ms);
            clock += ms;
          },
          cooldownMs: 65_000,
          cooldownStepMs: 10_000,
        },
      };
    };

    it('a queue that disappears within the window (it was being deleted) is free', async () => {
      const q = providerOf({ 'gen-A': URL });
      let reads = 0;
      q.lookupNames.mockImplementation(async (_t: string, names: readonly string[]) => {
        reads++;
        return reads <= 2 ? new Map(names.map((n) => [n, URL])) : new Map();
      });
      const { sleeps, t } = timing();
      const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: q }, { timing: t }))!;
      await expect(guard.verdict('A')).resolves.toEqual({ kind: 'free' });
      expect(sleeps).toEqual([10_000, 10_000]);
    });

    it('a queue still there after the window is refused; the waits are bounded', async () => {
      const { sleeps, t } = timing();
      const guard = GeneratedNameGuard.start(
        inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, { timing: t })
      )!;
      await expect(guard.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(70_000);
      expect(sleeps.length).toBe(7);
    });

    it('a log group (deleted at once) is refused without waiting', async () => {
      const { sleeps, t } = timing();
      const guard = GeneratedNameGuard.start(
        inputOf([create('L', LOGS)], { [LOGS]: providerOf({ 'gen-L': '/cdkd/x' }) }, { timing: t })
      )!;
      await expect(guard.verdict('L')).resolves.toMatchObject({ kind: 'held' });
      expect(sleeps).toEqual([]);
    });
  });

  it('D-14 / E-5: settle waits for EVERY intent write in flight -- an earlier one still pending included', async () => {
    let releaseFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => (releaseFirst = resolve));
    const { recordAdoptingCreates } = await import('../../../src/provisioning/providers/create-token-ledger.js');
    let firstStarted = false;
    vi.mocked(recordAdoptingCreates).mockImplementationOnce(async (creates) => {
      firstStarted = true;
      await firstPending; // the first wave's write is still in flight...
      ledger.writes.push(creates as never);
    });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: providerOf() })
    )!;
    await guard.verdict('A');
    const first = guard.admit('A', {});
    while (!firstStarted) await new Promise((r) => setImmediate(r)); // A's write started, and waits
    await guard.admit('B', {}); // ...while B's (a later wave) lands
    let settled = false;
    const settling = guard.settle().then(() => (settled = true));
    await new Promise((r) => setImmediate(r));
    expect(settled).toBe(false); // settle is still waiting for A's write
    releaseFirst();
    await settling;
    await first;
    // Neither was sent: both intents dropped -- A's too, because settle waited.
    expect(ledger.drops.flat().sort()).toEqual(['A', 'B']);
  });
});

describe('review round CB3', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';

  describe('E-1 / P2: re-read only after an approval prompt that ran, in one batched pass per type', () => {
    function clocked(q: ReturnType<typeof providerOf>, warn = vi.fn()) {
      let clock = 0;
      const guard = GeneratedNameGuard.start(
        inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q }, {
          timing: { now: () => clock, cooldownMs: 0 },
          warn,
        })
      )!;
      return { guard, warn, at: (t: number) => (clock = t) };
    }

    it('P2: a deploy running far past a minute with no prompt re-reads nothing', async () => {
      const q = providerOf();
      const { guard, at } = clocked(q);
      await guard.verdict('A');
      guard.recordPlannedIntents();
      at(120_000);
      await guard.admit('A', {});
      at(300_000);
      await guard.admit('B', {});
      expect(q.lookupNames).toHaveBeenCalledTimes(1);
    });

    it('after a prompt that ran, every decided verdict is read again at once -- one call per type, however many creates', async () => {
      const q = providerOf();
      const { guard } = clocked(q);
      await guard.verdict('A');
      guard.noteApprovalPrompted();
      expect(q.lookupNames).toHaveBeenCalledTimes(2);
      expect(q.lookupNames.mock.calls[1]![1]).toEqual(['gen-A', 'gen-B']);
      guard.recordPlannedIntents();
      await Promise.all([guard.admit('A', {}), guard.admit('B', {})]);
      expect(q.lookupNames).toHaveBeenCalledTimes(2);
    });

    it('a holder that appeared while the prompt waited is refused', async () => {
      const q = providerOf();
      const { guard } = clocked(q);
      await guard.verdict('A');
      q.lookupNames.mockImplementation(async (_t: string, names: readonly string[]) =>
        new Map(names.filter((n) => n === 'gen-B').map((n) => [n, `https://q/${n}`]))
      );
      guard.noteApprovalPrompted();
      guard.recordPlannedIntents();
      const [a, b] = await Promise.all([guard.admit('A', {}), guard.admit('B', {})]);
      expect(a).toEqual({ kind: 'free' });
      expect(b).toMatchObject({ kind: 'held' });
      expect(ledger.writes.flat().map((w) => w.logicalId)).toEqual(['A']);
    });

    it('a re-read that fails transiently keeps the plan-time verdict, with a warning -- never a mid-deploy refusal', async () => {
      const q = providerOf();
      const { guard, warn } = clocked(q);
      await guard.verdict('A');
      q.lookupNames.mockRejectedValue(Object.assign(new Error('Service Unavailable'), { $metadata: { httpStatusCode: 503 } }));
      guard.noteApprovalPrompted();
      guard.recordPlannedIntents();
      await expect(guard.admit('A', {})).resolves.toEqual({ kind: 'free' });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/A: could not re-read/));
      expect(ledger.writes.flat().map((w) => w.logicalId).sort()).toEqual(['A', 'B']);
    });
  });

  describe("E-2: each create's verdict resolves when its own type answers", () => {
    it('a slow type never holds another type\'s creates', async () => {
      const q = providerOf();
      const logs = providerOf();
      let releaseLogs!: () => void;
      logs.lookupNames.mockImplementation(
        () => new Promise((resolve) => (releaseLogs = () => resolve(new Map())))
      );
      const guard = GeneratedNameGuard.start(
        inputOf([create('A', QUEUE), create('L', LOGS)], { [QUEUE]: q, [LOGS]: logs })
      )!;
      await expect(guard.verdict('A')).resolves.toEqual({ kind: 'free' });
      releaseLogs();
      await expect(guard.verdict('L')).resolves.toEqual({ kind: 'free' });
    });

    it('a held queue waiting out a deletion delays only that create, not its free siblings', async () => {
      let wake!: () => void;
      const q = providerOf({ 'gen-A': URL });
      const guard = GeneratedNameGuard.start(
        inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q }, {
          timing: {
            now: () => 0,
            sleep: () => new Promise<void>((resolve) => (wake = resolve)),
            cooldownMs: 65_000,
            cooldownStepMs: 10_000,
          },
        })
      )!;
      await expect(guard.verdict('B')).resolves.toEqual({ kind: 'free' });
      let aSettled = false;
      void guard.verdict('A')!.then(() => (aSettled = true));
      await new Promise((r) => setImmediate(r));
      expect(aSettled).toBe(false); // A is still waiting out the cooldown
      q.lookupNames.mockResolvedValue(new Map());
      wake();
      await expect(guard.verdict('A')).resolves.toEqual({ kind: 'free' });
    });
  });
});

describe('review P1: one intent write, and the intent licenses only what its create made', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';
  const T = Date.parse('2026-10-01T00:00:00Z');

  it('recordPlannedIntents writes every free planned create once; admits do not write again; a held one is not recorded', async () => {
    const q = providerOf({ 'gen-C': 'https://q/gen-C' });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('B', QUEUE), create('C', QUEUE)], { [QUEUE]: q })
    )!;
    guard.recordPlannedIntents();
    await Promise.all([guard.admit('A', {}), guard.admit('B', {}), guard.admit('C', {})]);
    expect(ledger.writes.map((w) => w.map((e) => e.logicalId))).toEqual([['A', 'B']]);
  });

  it.each([
    ['created after the intent (the create it announced made it)', T + 5_000, 'licensed'],
    ['created long before the intent (another backend\'s, left by a crash)', T - 3_600_000, 'held'],
  ] as const)('a holder %s is %s', async (_what, createdAt, kind) => {
    ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-A', firstSentAt: T }]]) as never;
    const provider = providerOf({ 'gen-A': URL });
    (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(async () => createdAt);
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: provider });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind });
  });

  it('a type with no creation time is licensed by the intent alone (the crash-only residual)', async () => {
    ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-A', firstSentAt: T }]]) as never;
    const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) });
    await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({
      kind: 'licensed',
      via: 'ledger',
    });
  });
});

describe('review round G', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';
  const SENT = Date.parse('2026-10-01T00:00:00Z');
  const CRASHED = SENT + 120_000; // the abandoned run's last lock renewal

  describe('G-1: an abandoned run\'s intent licenses only what that run could have made', () => {
    const withCreatedAt = (createdAt: number) => {
      const provider = providerOf({ 'gen-A': URL });
      (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(async () => createdAt);
      return provider;
    };
    beforeEach(() => {
      ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-A', firstSentAt: SENT }]]) as never;
    });

    it('crash, then a twin created after it by another backend, then the re-run: held', async () => {
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: withCreatedAt(CRASHED + 3_600_000) }, {
        abandonedRunAt: CRASHED,
      });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
    });

    it('crash, our own create having landed before it: licensed', async () => {
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: withCreatedAt(SENT + 30_000) }, {
        abandonedRunAt: CRASHED,
      });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({
        kind: 'licensed',
        via: 'ledger',
      });
    });

    it('the bound recorded by cdkd force-unlock (the ledger) applies the same way', async () => {
      ledger.abandonedAt = CRASHED;
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: withCreatedAt(CRASHED + 3_600_000) });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
    });

    it('a type with no creation time: an abandoned run\'s intent licenses nothing (refused, cdkd import remedy)', async () => {
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, {
        abandonedRunAt: CRASHED,
      });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
    });

    it('an intent written AFTER the abandonment (a later run) is not bounded by it', async () => {
      ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-A', firstSentAt: CRASHED + 1 }]]) as never;
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: withCreatedAt(CRASHED + 3_600_000) }, {
        abandonedRunAt: CRASHED,
      });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'licensed' });
    });
  });

  it('G-2: a slow type never delays another type\'s creates: one write per type, each when its own lookup answers', async () => {
    const q = providerOf();
    const topics = providerOf({}, { batch: false });
    let releaseTopics!: () => void;
    const topicsGate = new Promise<void>((r) => (releaseTopics = r));
    topics.import.mockImplementation(async () => {
      await topicsGate;
      return null;
    });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('T', TOPIC)], { [QUEUE]: q, [TOPIC]: topics })
    )!;
    guard.recordPlannedIntents();
    await expect(guard.admit('A', {})).resolves.toEqual({ kind: 'free' });
    expect(ledger.writes.map((w) => w.map((e) => e.logicalId))).toEqual([['A']]);
    releaseTopics();
    await expect(guard.admit('T', {})).resolves.toEqual({ kind: 'free' });
    expect(ledger.writes.map((w) => w.map((e) => e.logicalId))).toEqual([['A'], ['T']]);
  });

  it('G-3: a failed planned intent write refuses the creates it covered with { kind: failed, error }', async () => {
    const boom = new Error('S3 PutObject 500');
    ledger.writeError = boom;
    const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
    guard.recordPlannedIntents();
    await expect(guard.admit('A', {})).resolves.toEqual({ kind: 'failed', error: boom });
  });
});

describe('review rounds H and S', () => {
  const URL = 'https://sqs.us-east-1.amazonaws.com/123456789012/gen-A';
  const SENT = Date.parse('2026-10-01T00:00:00Z');
  const withCreatedAt = (createdAt: number | (() => Promise<number>)) => {
    const provider = providerOf({ 'gen-A': URL });
    (provider as unknown as { holderCreatedAt: unknown }).holderCreatedAt = vi.fn(
      typeof createdAt === 'number' ? async () => createdAt : createdAt
    );
    return provider;
  };

  describe('S-6: an intent whose create came back failed licenses only what existed by then', () => {
    beforeEach(() => {
      ledger.recorded = new Map([
        ['A', { resourceType: QUEUE, name: 'gen-A', firstSentAt: SENT, failedAt: SENT + 5_000 }],
      ]) as never;
    });
    it('a holder created long after the failure: held', async () => {
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: withCreatedAt(SENT + 3_600_000) });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
    });
    it('a holder created between the send and the failure: licensed', async () => {
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: withCreatedAt(SENT + 2_000) });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'licensed', via: 'ledger' });
    });
    it('noteFailed stamps the time of an unknown outcome, never of a proven rejection', async () => {
      ledger.recorded = new Map();
      let clock = 1_000;
      const guard = GeneratedNameGuard.start(
        inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: providerOf() }, {
          timing: { cooldownMs: 0, now: () => clock },
        })
      )!;
      guard.recordPlannedIntents();
      await admitAll(guard, ['A', 'B']);
      guard.noteSent('A');
      guard.noteSent('B');
      clock = 7_000;
      guard.noteFailed('A', Object.assign(new Error('t'), { name: 'TimeoutError' }));
      guard.noteFailed('B', Object.assign(new Error('v'), { name: 'ValidationError', $metadata: { httpStatusCode: 400 } }));
      await guard.settle();
      expect(ledger.drops).toEqual([['B']]);
      expect([...ledger.failedStamps[0]!]).toEqual([['A', 7_000]]);
    });
  });

  describe('S-2: a 403 on the creation-time read is "no creation time", never unchecked', () => {
    const denied = () => withCreatedAt(async () => {
      throw accessDenied();
    });
    beforeEach(() => {
      ledger.recorded = new Map([['A', { resourceType: QUEUE, name: 'gen-A', firstSentAt: SENT }]]) as never;
    });
    it('intent path, no abandoned run: licensed by name, with a warning', async () => {
      const warn = vi.fn();
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: denied() }, { warn });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toMatchObject({ kind: 'licensed' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('deciding by its name alone'));
    });
    it('intent path, an abandoned run: held (the G-1 bound is not bypassed)', async () => {
      const input = inputOf([create('A', QUEUE)], { [QUEUE]: denied() }, { abandonedRunAt: SENT + 60_000 });
      await expect(GeneratedNameGuard.start(input)!.verdict('A')).resolves.toEqual({ kind: 'held', holder: URL });
    });
  });

  describe('S-1: settle retries the intent drop, then bounds what is left', () => {
    const settled = async () => {
      const warn = vi.fn();
      const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }, { warn }))!;
      guard.recordPlannedIntents();
      await guard.admit('A', {});
      await guard.settle();
      return warn;
    };
    it('one failure: the retry drops it; no abandonment, no warning', async () => {
      ledger.settleFailures = 1;
      const warn = await settled();
      expect(ledger.drops).toEqual([['A']]);
      expect(ledger.abandonedNotes).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    });
    it('two failures: the run is recorded as abandoned now, with a warning', async () => {
      ledger.settleFailures = 2;
      const warn = await settled();
      expect(ledger.drops).toEqual([]);
      expect(ledger.abandonedNotes).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('license only what existed by now'));
    });
    it('and when that cannot be recorded either, the warning names the residual', async () => {
      ledger.settleFailures = 2;
      ledger.abandonedNoteOk = false;
      const warn = await settled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('Nor could the ledger record'));
    });
  });

  it('S-3: the re-read warning renders the logical id display-safe', async () => {
    const q = providerOf();
    let reads = 0;
    q.lookupNames.mockImplementation(async () => {
      reads++;
      if (reads > 1) throw new Error('503');
      return new Map();
    });
    const warn = vi.fn();
    const id = 'A\u001b[31mX';
    const guard = GeneratedNameGuard.start(inputOf([create(id, QUEUE)], { [QUEUE]: q }, { warn }))!;
    await guard.verdict(id);
    guard.noteApprovalPrompted();
    await expect(guard.verdict(id)).resolves.toEqual({ kind: 'free' });
    const reread = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('could not re-read'));
    expect(reread).toHaveLength(1);
    expect(reread[0]).not.toContain('\u001b');
  });

  describe('H-4: a Ctrl-C ends the deletion cooldown at once', () => {
    let baseline: readonly unknown[] = [];
    beforeEach(() => {
      disarmInterruptWatchForTests();
      interruptWatchTestSeam.commandOwnsInterrupts = () => true;
      baseline = process.listeners('SIGINT');
    });
    afterEach(() => {
      disarmInterruptWatchForTests();
      delete interruptWatchTestSeam.commandOwnsInterrupts;
    });
    it('the waiting create fails with the interrupt, without waiting out the step', async () => {
      // A sleep that never ends: only the interrupt can end the wait.
      let clock = 0;
      // The clock moves only so that a wait that ignores the interrupt still ends.
      const t = { now: () => (clock += 1_000), sleep: () => new Promise<void>(() => undefined), cooldownMs: 65_000, cooldownStepMs: 10_000 };
      const guard = GeneratedNameGuard.start(
        inputOf([create('A', QUEUE)], { [QUEUE]: providerOf({ 'gen-A': URL }) }, { timing: t })
      )!;
      const verdict = guard.verdict('A')!;
      for (let i = 0; i < 50 && process.listeners('SIGINT').length === baseline.length; i++) {
        await new Promise((r) => setImmediate(r));
      }
      for (const listener of process.listeners('SIGINT').filter((l) => !baseline.includes(l))) {
        (listener as unknown as () => void)();
      }
      const v = await verdict;
      expect(v.kind).toBe('failed');
      expect(isInterruptedWaitError((v as { error: unknown }).error)).toBe(true);
    });
  });
});
