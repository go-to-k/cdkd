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
vi.mock('../../../src/utils/logger.js', () => {
  const quiet = {
    setLevel: (): void => undefined,
    debug: (): void => undefined,
    info: (...args: unknown[]): void => infoSink.write(args.map(String).join(' ')),
    warn: (): void => undefined,
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

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { TemplateNoEchoReresolver } from '../../../src/deployment/noecho-delete-reresolution.js';
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

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
