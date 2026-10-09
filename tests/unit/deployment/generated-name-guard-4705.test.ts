/**
 * go-to-k/cdkd#4705 (C): the plan-time check of the names cdkd GENERATES for
 * the creates of name-adopting types (`src/deployment/generated-name-guard.ts`):
 * which creates it asks about, that it batches per type and starts everything
 * at once, each verdict, the license sources, and the one ledger write.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const ledger = vi.hoisted(() => ({
  recorded: new Map<string, { resourceType: string; name: string }>() as
    | Map<string, { resourceType: string; name: string }>
    | undefined,
  readError: undefined as Error | undefined,
  writeError: undefined as Error | undefined,
  writes: [] as Array<Array<{ logicalId: string; resourceType: string; name: string }>>,
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
}));

import { GeneratedNameGuard, type GeneratedNameGuardInput } from '../../../src/deployment/generated-name-guard.js';
import { LookupEachNameInstead } from '../../../src/provisioning/name-lookup.js';
import type { ResourceChange, ResourceState } from '../../../src/types/state.js';
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
    loadRetained: vi.fn(async () => []),
    accountInfo: vi.fn(async () => ({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' })),
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
});

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

  it('a provider without a batch, or one that asks for it, is looked up name by name through import()', async () => {
    const noBatch = providerOf({ 'gen-A': 'held-A' }, { batch: false });
    const asks = providerOf({ 'gen-T': 'arn:aws:sns:us-east-1:123456789012:gen-T' }, {
      lookupError: new LookupEachNameInstead('too many'),
    });
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
  it('free: no holder, and the name is recorded in the ledger in ONE write before any create', async () => {
    const q = providerOf();
    const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q }))!;
    await expect(guard.verdict('A')).resolves.toEqual({ kind: 'free' });
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
    await expect(guard.verdict('A')).resolves.toMatchObject({ kind: 'held' });
    await expect(guard.verdict('B')).resolves.toEqual({ kind: 'free' });
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
    await expect(guard.verdict('A')).resolves.toEqual({ kind: 'licensed', holder: URL, via });
    // Recorded too: a re-run after a crash finds it as its own.
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

  it('a ledger that cannot be read or written refuses the creates that rely on it', async () => {
    ledger.writeError = new Error('ledger write failed');
    const guard = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
    await expect(guard.verdict('A')).resolves.toMatchObject({ kind: 'failed' });
    ledger.writeError = undefined;
    ledger.readError = new Error('ledger read failed');
    const again = GeneratedNameGuard.start(inputOf([create('A', QUEUE)], { [QUEUE]: providerOf() }))!;
    await expect(again.verdict('A')).resolves.toMatchObject({ kind: 'failed' });
  });

  it('S3 answering 403 for a bucket another account owns reads as free (its create fails natively)', async () => {
    const bucket = providerOf({}, { batch: false });
    bucket.import.mockRejectedValue(accessDenied());
    const guard = GeneratedNameGuard.start(inputOf([create('B', BUCKET)], { [BUCKET]: bucket }))!;
    await expect(guard.verdict('B')).resolves.toEqual({ kind: 'free' });
  });

  it('lists the creates that took back a kept resource, for retained.json to let go', async () => {
    const q = providerOf({ 'gen-A': URL });
    const guard = GeneratedNameGuard.start(
      inputOf([create('A', QUEUE), create('B', QUEUE)], { [QUEUE]: q }, {
        loadRetained: async () => [{ logicalId: 'A', resourceType: QUEUE, physicalId: URL }],
      })
    )!;
    await expect(guard.readoptedFromRetained()).resolves.toEqual(['A']);
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
