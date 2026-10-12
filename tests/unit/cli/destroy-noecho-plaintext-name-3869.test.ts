/**
 * `cdkd destroy` masks a name taken from a `NoEcho` parameter in a record
 * written before schema v11 (go-to-k/cdkd#3869).
 *
 * Such a record holds the value in PLAINTEXT (v11 persists `***`, and there is
 * no read-time migration), so nothing in it marks the name as secret, and the
 * record-only judge let its delete lines print the whole id. `cdkd destroy`
 * holds the synthesized template (`noEchoReresolver`), so it re-binds the
 * stack's `NoEcho` values once and judges every delete's printing bag with
 * them. `cdkd state destroy` holds no template and stays record-only.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const infoSink = vi.hoisted(() => ({ write: (_line: string): void => undefined }));
const warned = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const quiet = {
    setLevel: (): void => undefined,
    debug: (): void => undefined,
    info: (...args: unknown[]): void => infoSink.write(args.map(String).join(' ')),
    warn: (...args: unknown[]): void => void warned.push(args.map(String).join(' ')),
    error: (): void => undefined,
    child: (): unknown => quiet,
  };
  return { getLogger: () => quiet };
});
vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    sts: { send: vi.fn(() => Promise.resolve({ Account: '123456789012' })) },
  }),
}));
const readlineQuestion = vi.hoisted(() => vi.fn());
vi.mock('node:readline/promises', () => ({
  createInterface: () => ({ question: readlineQuestion, close: vi.fn() }),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import {
  NOECHO_PRINTING_BIND_CAP_MS,
  runDestroyForStack,
} from '../../../src/cli/commands/destroy-runner.js';
import { TemplateNoEchoReresolver } from '../../../src/deployment/noecho-delete-reresolution.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';
import { recordLogOnlyValue } from '../../../src/deployment/secret-redaction.js';

const REGION = 'us-east-1';
const SECRET = 'SuperSecretPassword123';
const DB_SECRET = 'SuperSecretDb1';

const TEMPLATE = {
  Parameters: {
    BucketNameParam: { Type: 'String', NoEcho: true, Default: SECRET },
    DbIdParam: { Type: 'String', NoEcho: true, Default: DB_SECRET },
  },
  Resources: {
    Bucket: { Type: 'AWS::S3::Bucket', Properties: { BucketName: { Ref: 'BucketNameParam' } } },
    Policy: { Type: 'AWS::S3::BucketPolicy', Properties: { Bucket: { Ref: 'Bucket' } } },
    Db: {
      Type: 'AWS::RDS::DBInstance',
      Properties: { DBInstanceIdentifier: { Ref: 'DbIdParam' } },
    },
    Replica: {
      Type: 'AWS::RDS::DBInstance',
      Properties: { SourceDBInstanceIdentifier: { Ref: 'Db' } },
    },
    Plain: { Type: 'AWS::S3::Bucket', Properties: { BucketName: 'plain-bucket-name' } },
  },
} as unknown as CloudFormationTemplate;

const record = (
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  extra: Partial<ResourceState> = {}
): ResourceState =>
  ({ physicalId, resourceType, properties, attributes: {}, dependencies: [], ...extra }) as ResourceState;

/** A record a pre-v11 binary wrote: the `NoEcho` value in plaintext, no marker. */
function preV11State(): StackState {
  return {
    version: 10,
    stackName: 'NoEchoStack',
    region: REGION,
    resources: {
      Bucket: record(SECRET, 'AWS::S3::Bucket', { BucketName: SECRET }),
      Policy: record('policy-id', 'AWS::S3::BucketPolicy', { Bucket: SECRET }, {
        dependencies: ['Bucket'],
      }),
      // RDS folds the identifier to lower case: no literal of the value.
      Db: record(DB_SECRET.toLowerCase(), 'AWS::RDS::DBInstance', {
        DBInstanceIdentifier: DB_SECRET,
      }),
      // A reader holding the FOLDED spelling: masked only through what it read.
      Replica: record('replica-id', 'AWS::RDS::DBInstance', {
        SourceDBInstanceIdentifier: DB_SECRET.toLowerCase(),
      }, { dependencies: ['Db'] }),
      Plain: record('plain-bucket-name', 'AWS::S3::Bucket', { BucketName: 'plain-bucket-name' }),
    },
    outputs: {},
    lastModified: 1,
  } as StackState;
}

/** The same stack as a v11 binary writes it: `***` at the parameter's leaves. */
function v11State(): StackState {
  const state = preV11State();
  state.version = 11;
  state.resources['Bucket'] = record(SECRET, 'AWS::S3::Bucket', { BucketName: '***' }, {
    noEchoLeaves: [['BucketName']],
  } as Partial<ResourceState>);
  return state;
}

function makeCtx(providerDelete: ReturnType<typeof vi.fn>, withTemplate: boolean) {
  return {
    stateBackend: {
      saveState: vi.fn().mockResolvedValue('"etag"'),
      deleteState: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    } as unknown as S3StateBackend,
    lockManager: {
      acquireLock: vi.fn().mockResolvedValue(true),
      releaseLock: vi.fn(),
    } as unknown as LockManager,
    providerRegistry: {
      getProviderFor: () => ({ provider: { delete: providerDelete } }),
    } as unknown as ProviderRegistry,
    baseAwsClients: {} as AwsClients,
    baseRegion: REGION,
    stateBucket: 'test-bucket',
    skipConfirmation: true,
    skipFinalSnapshot: true,
    ...(withTemplate && {
      noEchoReresolver: new TemplateNoEchoReresolver({
        template: TEMPLATE,
        stackName: 'NoEchoStack',
        region: REGION,
      }),
    }),
  };
}

/** Each delete's own log line (`Deleting <id> <physical id> [of <what it read>]`), as the sink masks it. */
async function linesOf(
  state: StackState,
  withTemplate: boolean
): Promise<Record<string, string | undefined>> {
  const lines: Record<string, string | undefined> = {};
  const providerDelete = vi.fn(
    (
      logicalId: string,
      physicalId: string,
      _type: string,
      properties: { Bucket?: string; SourceDBInstanceIdentifier?: string }
    ) => {
      const read = properties?.Bucket ?? properties?.SourceDBInstanceIdentifier;
      const line = `Deleting ${logicalId} ${physicalId}` + (read !== undefined ? ` of ${read}` : '');
      lines[logicalId] = currentLogLineMasker()?.(line) ?? line;
      return Promise.resolve(undefined);
    }
  );
  const result = await runDestroyForStack('NoEchoStack', state, makeCtx(providerDelete, withTemplate));
  expect(result.errorCount).toBe(0);
  expect(providerDelete).toHaveBeenCalledTimes(5);
  return lines;
}

describe('cdkd destroy masks a pre-v11 plaintext NoEcho-derived name (go-to-k/cdkd#3869)', () => {
  it("masks the resource's id, its lower-cased spelling, and a reader's copy", async () => {
    const lines = await linesOf(preV11State(), true);
    expect(lines['Bucket']).toBe('Deleting Bucket ***');
    // The reader holds the name in its own properties: masked on its line too.
    expect(lines['Policy']).toBe('Deleting Policy policy-id of ***');
    // Only the JUDGE yields the folded spelling: the value itself is mixed-case.
    expect(lines['Db']).toBe('Deleting Db ***');
    expect(lines['Replica']).toBe('Deleting Replica replica-id of ***');
    // Negative control: an ordinary name prints as it is.
    expect(lines['Plain']).toBe('Deleting Plain plain-bucket-name');
  });

  it('premise: without the template (cdkd state destroy) the plaintext record carries no evidence', async () => {
    const lines = await linesOf(preV11State(), false);
    expect(lines['Bucket']).toBe(`Deleting Bucket ${SECRET}`);
    expect(lines['Db']).toBe(`Deleting Db ${DB_SECRET.toLowerCase()}`);
    expect(lines['Replica']).toBe(`Deleting Replica replica-id of ${DB_SECRET.toLowerCase()}`);
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('boom'))],
    [
      'throws synchronously',
      () => {
        throw new Error('boom');
      },
    ],
  ])('a source whose binding %s leaves the destroy running, record-only', async (_l, fail) => {
    const lines: Record<string, string | undefined> = {};
    const providerDelete = vi.fn((logicalId: string, physicalId: string) => {
      const line = `Deleting ${logicalId} ${physicalId}`;
      lines[logicalId] = currentLogLineMasker()?.(line) ?? line;
      return Promise.resolve(undefined);
    });
    const ctx = {
      ...makeCtx(providerDelete, false),
      noEchoReresolver: {
        printingNoEchoValues: fail,
        valuesFor: () => Promise.resolve(undefined),
      } as unknown as TemplateNoEchoReresolver,
    };
    const result = await runDestroyForStack('NoEchoStack', v11State(), ctx);
    expect(result.errorCount).toBe(0);
    expect(providerDelete).toHaveBeenCalledTimes(5);
    expect(lines['Bucket']).toBe('Deleting Bucket ***');
  });

  it('boundary: a v11 record (`***`) stays masked, with and without the template', async () => {
    for (const withTemplate of [true, false]) {
      const lines = await linesOf(v11State(), withTemplate);
      expect(lines['Bucket']).toBe('Deleting Bucket ***');
      expect(lines['Plain']).toBe('Deleting Plain plain-bucket-name');
    }
  });
});

describe('cdkd destroy judges a journaled orphan with the NoEcho values too (go-to-k/cdkd#3869)', () => {
  /** A failed-CREATE DB instance orphan whose journal entry holds the plaintext. */
  const journal = {
    journalVersion: 1,
    stackName: 'NoEchoStack',
    region: REGION,
    segments: [
      {
        timestamp: 1,
        reason: 'no-rollback-failure',
        initialDeploy: false,
        skipPrefix: false,
        operations: [],
        failedOperations: [
          {
            logicalId: 'OrphanDb',
            changeType: 'CREATE',
            resourceType: 'AWS::RDS::DBInstance',
            // RDS folds the identifier: only the judge yields this spelling.
            physicalId: DB_SECRET.toLowerCase(),
            provisionedBy: 'sdk',
            physicalIdRecoveredFromError: true,
            createdResourceIdentity: 'created-token',
            attemptedProperties: { DBInstanceIdentifier: DB_SECRET },
          },
        ],
      },
    ],
  };

  /** The delete's own line, and the pre-prompt listing's line naming the orphan. */
  async function orphanLine(withTemplate: boolean): Promise<string | undefined> {
    let line: string | undefined;
    listed.length = 0;
    infoSink.write = (raw) => {
      if (raw.startsWith('  - OrphanDb')) listed.push(currentLogLineMasker()?.(raw) ?? raw);
    };
    const providerDelete = vi.fn((logicalId: string, physicalId: string) => {
      const raw = `Deleting ${logicalId} ${physicalId}`;
      line = currentLogLineMasker()?.(raw) ?? raw;
      return Promise.resolve(undefined);
    });
    const base = makeCtx(providerDelete, withTemplate);
    const ctx = {
      ...base,
      stateBackend: {
        saveState: vi.fn().mockResolvedValue('"etag"'),
        deleteState: vi.fn().mockResolvedValue(undefined),
        getState: vi.fn().mockResolvedValue(null),
        loadRollbackJournal: vi.fn().mockResolvedValue(journal),
        dropRollbackJournalFailedOperations: vi.fn().mockResolvedValue(0),
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      providerRegistry: {
        getProviderFor: () => ({
          provider: { delete: providerDelete, resourceIdentity: async () => 'created-token' },
          provisionedBy: 'sdk',
        }),
      } as unknown as ProviderRegistry,
    };
    const state = { ...preV11State(), resources: {} } as StackState;
    const result = await runDestroyForStack('NoEchoStack', state, ctx);
    expect(result.errorCount).toBe(0);
    expect(providerDelete).toHaveBeenCalledTimes(1);
    return line;
  }

  const listed: string[] = [];

  it('masks the folded id of a plaintext-named orphan, on its delete and in the listing', async () => {
    expect(await orphanLine(true)).toBe('Deleting OrphanDb ***');
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain('OrphanDb');
    expect(listed[0]).not.toContain(DB_SECRET.toLowerCase());
  });

  it('premise: without the template the entry carries no evidence', async () => {
    expect(await orphanLine(false)).toBe(`Deleting OrphanDb ${DB_SECRET.toLowerCase()}`);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toContain(DB_SECRET.toLowerCase());
  });
});

describe("cdkd destroy masks the prompt's list of kept orphans (go-to-k/cdkd#3869)", () => {
  const REF = '{{resolve:secretsmanager:team:SecretString:queue::}}';
  const orphan = (logicalId: string, physicalId: string, queueName: string) => ({
    logicalId,
    orphanedAt: 1,
    state: record(physicalId, 'AWS::SQS::Queue', { QueueName: queueName }),
  });

  /** The listing's row per orphan, as the sink masks it. */
  const standard = () => [
    orphan('RefNamed', 'team-secret-queue-url', REF),
    orphan('PlainTextNamed', SECRET, SECRET),
    orphan('Ordinary', 'ordinary-queue-url', 'ordinary-queue'),
    // RDS folds the identifier: only the judge yields this spelling.
    {
      logicalId: 'Folded',
      orphanedAt: 1,
      state: record(DB_SECRET.toLowerCase(), 'AWS::RDS::DBInstance', {
        DBInstanceIdentifier: DB_SECRET,
      }),
    },
  ];

  async function listed(
    withTemplate: boolean,
    orphans: unknown[] = standard()
  ): Promise<Record<string, string>> {
    const rows: Record<string, string> = {};
    infoSink.write = (raw) => {
      const id = /^ {2}- (\S+) /.exec(raw)?.[1];
      if (id !== undefined) rows[id] = currentLogLineMasker()?.(raw) ?? raw;
    };
    const state = {
      ...preV11State(),
      resources: {},
      orphans,
    } as unknown as StackState;
    await runDestroyForStack('NoEchoStack', state, makeCtx(vi.fn(), withTemplate));
    infoSink.write = () => undefined;
    return rows;
  }

  it('masks an id named from a secret reference or a NoEcho value; an ordinary id prints', async () => {
    const rows = await listed(true);
    expect(rows['RefNamed']).toBeDefined();
    expect(rows['RefNamed']).not.toContain('team-secret-queue-url');
    expect(rows['PlainTextNamed']).not.toContain(SECRET);
    expect(rows['Ordinary']).toContain('ordinary-queue-url');
    expect(rows['Folded']).toBeDefined();
    expect(rows['Folded']).not.toContain(DB_SECRET.toLowerCase());
  });

  it('masks the value itself where an id merely embeds it (no name key)', async () => {
    const rows = await listed(true, [
      { logicalId: 'Embeds', orphanedAt: 1, state: record(`queue-${SECRET}`, 'AWS::SQS::Queue', {}) },
    ]);
    expect(rows['Embeds']).toContain('queue-');
    expect(rows['Embeds']).not.toContain(SECRET);
  });

  it('premise: without the template a plaintext name has no evidence; a reference still does', async () => {
    const rows = await listed(false);
    expect(rows['PlainTextNamed']).toContain(SECRET);
    expect(rows['RefNamed']).not.toContain('team-secret-queue-url');
  });
});

describe('the NoEcho binding at destroy (go-to-k/cdkd#3869)', () => {
  it('a declined destroy never asks for the values', async () => {
    const printingNoEchoValues = vi.fn().mockResolvedValue(undefined);
    readlineQuestion.mockReset().mockResolvedValue('n');
    const originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    let result;
    try {
      result = await runDestroyForStack('NoEchoStack', preV11State(), {
        ...makeCtx(vi.fn(), false),
        skipConfirmation: false,
        noEchoReresolver: {
          printingNoEchoValues,
          valuesFor: () => Promise.resolve(undefined),
        } as unknown as TemplateNoEchoReresolver,
      });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    }
    expect(readlineQuestion).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(true);
    expect(printingNoEchoValues).not.toHaveBeenCalled();
  });

  it('a cap fired before the prompt yields to a binding that settles later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      warned.length = 0;
      let settle: (bag: Map<string, string>) => void = () => undefined;
      const late = new Promise<Map<string, string>>((resolve) => (settle = resolve));
      const values = new Map<string, string>();
      recordLogOnlyValue(values, SECRET);
      const rows: string[] = [];
      infoSink.write = (raw) => {
        if (raw.startsWith('  - PlainTextNamed')) rows.push(currentLogLineMasker()?.(raw) ?? raw);
      };
      const lines: Record<string, string | undefined> = {};
      const providerDelete = vi.fn((logicalId: string, physicalId: string) => {
        const line = `Deleting ${logicalId} ${physicalId}`;
        lines[logicalId] = currentLogLineMasker()?.(line) ?? line;
        return Promise.resolve(undefined);
      });
      const base = makeCtx(providerDelete, false);
      const ctx = {
        ...base,
        lockManager: {
          // The binding settles after the listing's cap, before the deletes.
          acquireLock: vi.fn(async () => {
            settle(values);
            for (let i = 0; i < 20; i++) await Promise.resolve();
            return true;
          }),
          releaseLock: vi.fn(),
        } as unknown as LockManager,
        noEchoReresolver: {
          printingNoEchoValues: () => late,
          valuesFor: () => Promise.resolve(undefined),
        } as unknown as TemplateNoEchoReresolver,
      };
      const state = {
        ...preV11State(),
        orphans: [
          { logicalId: 'PlainTextNamed', orphanedAt: 1, state: record(SECRET, 'AWS::SQS::Queue', { QueueName: SECRET }) },
        ],
      } as unknown as StackState;
      const run = runDestroyForStack('NoEchoStack', state, ctx);
      await vi.advanceTimersByTimeAsync(NOECHO_PRINTING_BIND_CAP_MS);
      const result = await run;
      expect(result.errorCount).toBe(0);
      // Premise: the cap fired for the listing, which printed record-only, and warned.
      expect(rows).toHaveLength(1);
      expect(rows[0]).toContain(SECRET);
      expect(warned.some((w) => w.includes('were not bound within'))).toBe(true);
      expect(warned.join('\n')).not.toContain(SECRET);
      // The deletes took the value that settled after the cap.
      expect(lines['Bucket']).toBe('Deleting Bucket ***');
    } finally {
      infoSink.write = () => undefined;
      vi.useRealTimers();
    }
  });

  it('a binding that settles in time clears its cap timer: nothing warns later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      warned.length = 0;
      const result = await runDestroyForStack('NoEchoStack', v11State(), {
        ...makeCtx(vi.fn().mockResolvedValue(undefined), false),
        noEchoReresolver: {
          printingNoEchoValues: () => Promise.resolve(undefined),
          valuesFor: () => Promise.resolve(undefined),
        } as unknown as TemplateNoEchoReresolver,
      });
      expect(result.errorCount).toBe(0);
      await vi.advanceTimersByTimeAsync(NOECHO_PRINTING_BIND_CAP_MS);
      expect(warned.some((w) => w.includes('were not bound within'))).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a binding that never settles is capped: the destroy goes on record-only', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const lines: Record<string, string | undefined> = {};
      const providerDelete = vi.fn((logicalId: string, physicalId: string) => {
        const line = `Deleting ${logicalId} ${physicalId}`;
        lines[logicalId] = currentLogLineMasker()?.(line) ?? line;
        return Promise.resolve(undefined);
      });
      const run = runDestroyForStack('NoEchoStack', v11State(), {
        ...makeCtx(providerDelete, false),
        noEchoReresolver: {
          printingNoEchoValues: () => new Promise(() => undefined),
          valuesFor: () => Promise.resolve(undefined),
        } as unknown as TemplateNoEchoReresolver,
      });
      let settled = false;
      void run.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(NOECHO_PRINTING_BIND_CAP_MS - 1);
      // Premise: the destroy is waiting on the binding, not done.
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await run;
      expect(result.errorCount).toBe(0);
      expect(providerDelete).toHaveBeenCalledTimes(5);
      expect(lines['Bucket']).toBe('Deleting Bucket ***');
    } finally {
      vi.useRealTimers();
    }
  });
});
