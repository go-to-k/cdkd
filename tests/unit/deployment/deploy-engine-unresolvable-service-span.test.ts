/**
 * Issue #2743, the RESOURCE-PROPERTY position, with the REAL resolver and the
 * REAL redaction under a real `DeployEngine` (only the SDK client is faked).
 *
 * `Fn::Sub: ['{{resolve:${Pw}}}', { Pw: <secret reference> }]` assembles
 * `{{resolve:<plaintext>}}`. The resolver's unsupported-service arm used to
 * leave that token in the value, so the provider was handed it — AWS stored
 * the plaintext inside a bogus token under a green deploy — and the record,
 * its readback and the rollback journal all persisted it. The arm now refuses,
 * which fails the resource BEFORE the provider is called.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceChange } from '../../../src/types/state.js';

const { debugSpy, infoSpy, warnSpy, errorSpy } = vi.hoisted(() => ({
  debugSpy: vi.fn(),
  infoSpy: vi.fn(),
  warnSpy: vi.fn(),
  errorSpy: vi.fn(),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: debugSpy,
    info: infoSpy,
    warn: warnSpy,
    error: errorSpy,
    child: () => fns,
  };
  return { getLogger: () => fns };
});
vi.mock('p-limit', () => ({ default: vi.fn(() => <T>(fn: () => T) => fn()) }));

const SECRET_ID = 'cdkd-test-2743-secret';
const SENTINEL = 'sentinel-plaintext-2743';
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(command: { input?: { SecretId?: string }; constructor: { name: string } }): Promise<unknown> {
      // Refuses what this file does not model, so an unexpected path fails
      // loudly instead of resolving.
      if (command.constructor.name !== 'GetSecretValueCommand' || command.input?.SecretId !== SECRET_ID) {
        throw new Error(`unexpected Secrets Manager call ${command.constructor.name}`);
      }
      return { SecretString: JSON.stringify({ password: SENTINEL }) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { markNonRetryable } from '../../../src/deployment/retryable-errors.js';

const SECRET_REF = `{{resolve:secretsmanager:${SECRET_ID}:SecretString:password}}`;
const SERVICE_POSITION = { 'Fn::Sub': ['{{resolve:${Pw}}}', { Pw: SECRET_REF }] };
const TYPE = 'AWS::SSM::Parameter';

describe('DeployEngine - a secret assembled into an unresolvable reference fails the resource before the provider (issue #2743)', () => {
  const stackName = 'unresolvable-service-span-stack';
  let provider: Record<string, ReturnType<typeof vi.fn>>;
  let stateBackend: Record<string, ReturnType<typeof vi.fn>>;
  let engineDeps: unknown[];

  const template = (leakyValue: unknown): CloudFormationTemplate => ({
    Resources: {
      Good: { Type: TYPE, Properties: { Type: 'String', Value: 'plain' } },
      Leaky: { Type: TYPE, Properties: { Type: 'String', Value: leakyValue } },
    },
  });
  const changes = (leakyValue: unknown): Map<string, ResourceChange> =>
    new Map<string, ResourceChange>([
      ['Good', { logicalId: 'Good', changeType: 'CREATE', resourceType: TYPE, desiredProperties: { Type: 'String', Value: 'plain' } }],
      ['Leaky', { logicalId: 'Leaky', changeType: 'CREATE', resourceType: TYPE, desiredProperties: { Type: 'String', Value: leakyValue } }],
    ]);

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      create: vi.fn().mockImplementation((logicalId: string) => Promise.resolve({ physicalId: `${logicalId}-phys`, attributes: {} })),
      update: vi.fn(),
      delete: vi.fn().mockResolvedValue(undefined),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn().mockResolvedValue(undefined),
    };
    stateBackend = {
      getState: vi.fn().mockResolvedValue({ state: null, etag: undefined }),
      saveState: vi.fn().mockResolvedValue('etag-new'),
      loadRollbackJournal: vi.fn().mockResolvedValue(null),
      appendRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      popRollbackJournalSegment: vi.fn().mockResolvedValue(undefined),
      deleteRollbackJournal: vi.fn().mockResolvedValue(undefined),
    };
    const lockManager = {
      acquireLockWithRetry: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    };
    const dagBuilder = {
      buildGraph: vi.fn().mockReturnValue({}),
      getExecutionLevels: vi.fn().mockReturnValue([['Good'], ['Leaky']]),
      // `Leaky` runs only after `Good` completed, so there is a completed
      // sibling for the failure to settle.
      getDirectDependencies: vi.fn().mockImplementation((_dag: unknown, id: string) => (id === 'Leaky' ? ['Good'] : [])),
    };
    const diffCalculator = {
      calculateDiff: vi.fn(),
      hasChanges: vi.fn().mockReturnValue(true),
      filterByType: vi
        .fn()
        .mockImplementation((all: Map<string, ResourceChange>, type: string) =>
          Array.from(all.values()).filter((c) => c.changeType === type)
        ),
    };
    const providerRegistry = {
      hasProvider: vi.fn().mockReturnValue(true),
      getProvider: vi.fn().mockReturnValue(provider),
      getProviderFor: vi.fn().mockReturnValue({ provider, provisionedBy: 'sdk' }),
      getRegisteredTypes: vi.fn().mockReturnValue([]),
      validateResourceTypes: vi.fn(),
      validateResourceProperties: vi.fn(),
      getAllowedUnsupportedProperties: vi.fn().mockReturnValue(new Set<string>()),
    };
    engineDeps = [stateBackend, lockManager, dagBuilder, diffCalculator, providerRegistry];
  });

  function makeEngine(options: Record<string, unknown> = {}): DeployEngine {
    return new DeployEngine(...(engineDeps as [never, never, never, never, never]), { dryRun: false, ...options }, 'us-east-1');
  }
  const setChanges = (leakyValue: unknown): void => {
    (engineDeps[3] as { calculateDiff: ReturnType<typeof vi.fn> }).calculateDiff.mockResolvedValue(changes(leakyValue));
  };
  const allLines = (): string[] =>
    [debugSpy, infoSpy, warnSpy, errorSpy].flatMap((spy) => spy.mock.calls.map((c) => c.map(String).join(' ')));
  const createdIds = (): string[] => provider['create']!.mock.calls.map((c) => String(c[0]));
  const persisted = (): string =>
    JSON.stringify([
      stateBackend['saveState']!.mock.calls,
      stateBackend['appendRollbackJournalSegment']!.mock.calls,
    ]);
  const chainOf = (error: unknown): string[] => {
    const out: string[] = [];
    for (let link: unknown = error; link instanceof Error; link = link.cause) out.push(link.message);
    return out;
  };

  it('the provider is NEVER called for the refused resource, and nothing thrown, logged or persisted carries the plaintext', async () => {
    setChanges(SERVICE_POSITION);
    const error = await makeEngine()
      .deploy(stackName, template(SERVICE_POSITION))
      .then(
        () => undefined,
        (e: unknown) => e
      );

    expect(error).toBeInstanceOf(Error);
    expect(chainOf(error).join('\n')).toContain('Refusing to resolve {{resolve:***}}');
    expect(chainOf(error).join('\n')).not.toContain(SENTINEL);
    // The #2482 class: nothing reached AWS for it. `Good` did run, which is
    // what makes the absence of `Leaky` a statement about the refusal.
    expect(createdIds()).toEqual(['Good']);
    expect(provider['update']).not.toHaveBeenCalled();
    for (const line of allLines()) expect(line).not.toContain(SENTINEL);
    expect(persisted()).not.toContain(SENTINEL);
  });

  it('the deployment events handed to the event sink carry the masked refusal, and never the plaintext', async () => {
    // `deployments/<run>.jsonl` is a persisted reader of its own: whatever the
    // engine records here is what `cdkd events` prints and S3 keeps.
    const record = vi.fn();
    setChanges(SERVICE_POSITION);
    await makeEngine({ eventRecorder: { record, runId: 'run-2743' } })
      .deploy(stackName, template(SERVICE_POSITION))
      .catch(() => undefined);

    const events = record.mock.calls.map((c) => JSON.stringify(c[0]));
    // The premise: the refused resource's failure WAS recorded, so the
    // negative below is about an event that exists.
    const refused = events.filter((e) => e.includes('"Leaky"') && e.includes('Refusing to resolve'));
    expect(refused.length).toBeGreaterThan(0);
    for (const event of refused) expect(event).toContain('{{resolve:***}}');
    for (const event of events) expect(event).not.toContain(SENTINEL);
  });

  it('--no-rollback: the journaled failed op and the saved state carry no plaintext and no bogus token', async () => {
    setChanges(SERVICE_POSITION);
    await makeEngine({ noRollback: true })
      .deploy(stackName, template(SERVICE_POSITION))
      .catch(() => undefined);

    expect(stateBackend['appendRollbackJournalSegment']).toHaveBeenCalled();
    expect(stateBackend['saveState']).toHaveBeenCalled();
    expect(createdIds()).toEqual(['Good']);
    expect(persisted()).not.toContain(SENTINEL);
    expect(persisted()).not.toContain('{{resolve:***');
  });

  it('the completed sibling settles exactly as it does for any other non-retryable failure of the same resource', async () => {
    // The CONTROL fails `Leaky` at the provider with a non-retryable error;
    // the SUBJECT fails it at resolution. What happens to `Good` — the
    // rollback delete, the state saves, the journal writes — must not differ.
    // WHERE each run failed, kept outside the compared object: the control
    // reaches the provider for `Leaky` and the subject must not, or the two
    // are equal for the trivial reason that both failed at the provider.
    const created: string[][] = [];
    const settle = async (leakyValue: unknown): Promise<Record<string, unknown>> => {
      vi.clearAllMocks();
      provider['create']!.mockImplementation((logicalId: string) =>
        logicalId === 'Leaky'
          ? Promise.reject(markNonRetryable(new Error('rejected')))
          : Promise.resolve({ physicalId: `${logicalId}-phys`, attributes: {} })
      );
      setChanges(leakyValue);
      const rejected = await makeEngine()
        .deploy(stackName, template(leakyValue))
        .then(
          () => false,
          () => true
        );
      created.push(createdIds());
      return {
        rejected,
        deleted: provider['delete']!.mock.calls.map((c) => [c[0], c[1]]),
        saves: stateBackend['saveState']!.mock.calls.length,
        savedResources: stateBackend['saveState']!.mock.calls.map((c) =>
          Object.keys((c[2] as { resources: Record<string, unknown> }).resources)
        ),
        journalAppends: stateBackend['appendRollbackJournalSegment']!.mock.calls.length,
        journalDeletes: stateBackend['deleteRollbackJournal']!.mock.calls.length,
      };
    };

    const control = await settle('plain-value');
    const subject = await settle(SERVICE_POSITION);

    expect(control['rejected']).toBe(true);
    expect(control['deleted']).toEqual([['Good', 'Good-phys']]);
    expect(subject).toEqual(control);
    expect(created).toEqual([['Good', 'Leaky'], ['Good']]);
  });
});
