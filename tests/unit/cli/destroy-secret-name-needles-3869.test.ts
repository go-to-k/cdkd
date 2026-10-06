/**
 * `cdkd destroy` masks a physical name derived from a secret (go-to-k/cdkd#3869).
 *
 * A destroy resolves nothing, so a resource named from a secret (its record
 * still spells the `{{resolve:` reference) and a reader holding that name
 * (an access key's `UserName`) printed it on every line their provider's
 * delete logged. Each resource's delete now runs under a PRINTING bag of its
 * own needles and those it read, which the logger's sink masker applies.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
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
  getAwsClients: vi.fn(),
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
import { currentLogLineMasker } from '../../../src/utils/log-line-masker.js';

const REGION = 'us-east-1';
const REF = '{{resolve:secretsmanager:team:SecretString:user::}}';
const USER_ID = 'team-secret-user';

function makeState(userName: string): StackState {
  const user: ResourceState = {
    physicalId: USER_ID,
    resourceType: 'AWS::IAM::User',
    properties: { UserName: userName },
    attributes: {},
    dependencies: [],
  };
  const key: ResourceState = {
    physicalId: 'AKIAEXAMPLEKEY',
    resourceType: 'AWS::IAM::AccessKey',
    properties: { UserName: USER_ID },
    attributes: {},
    dependencies: ['User'],
  };
  return {
    version: 8,
    stackName: 'TestStack',
    region: REGION,
    resources: { User: user, Key: key },
    outputs: {},
    lastModified: 1,
  };
}

function makeCtx(providerDelete: ReturnType<typeof vi.fn>) {
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
  };
}

/** What each delete's own log line reads as, through the logger's sink masker. */
async function linesOf(userName: string): Promise<Record<string, string | undefined>> {
  const lines: Record<string, string | undefined> = {};
  const providerDelete = vi.fn((logicalId: string, physicalId: string) => {
    const line = `Deleting ${logicalId} ${physicalId} of user ${USER_ID}`;
    lines[logicalId] = currentLogLineMasker()?.(line) ?? line;
    return Promise.resolve(undefined);
  });
  const result = await runDestroyForStack('TestStack', makeState(userName), makeCtx(providerDelete));
  expect(result.errorCount).toBe(0);
  expect(providerDelete).toHaveBeenCalledTimes(2);
  return lines;
}

describe('cdkd destroy masks a name derived from a secret (go-to-k/cdkd#3869)', () => {
  it("masks the secret-named resource's own delete line, and a reader's", async () => {
    const lines = await linesOf(REF);
    expect(lines['User']).toBe('Deleting User *** of user ***');
    // The access key's own id is no secret; the user name it holds is.
    expect(lines['Key']).toBe('Deleting Key AKIAEXAMPLEKEY of user ***');
  });

  it('negative control: an ordinary name prints as it is', async () => {
    const lines = await linesOf('plain-user-name');
    expect(lines['User']).toBe(`Deleting User ${USER_ID} of user ${USER_ID}`);
    expect(lines['Key']).toBe(`Deleting Key AKIAEXAMPLEKEY of user ${USER_ID}`);
  });

  it("masks the final-snapshot identifier a Snapshot delete derives from the name", async () => {
    // The identifier is derived from the id (lower-cased and suffixed), so it
    // is no literal of the reference: the judge's id spellings cover it.
    const state: StackState = {
      version: 8,
      stackName: 'TestStack',
      region: REGION,
      resources: {
        Db: {
          physicalId: 'Team-Secret-Db',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { DBInstanceIdentifier: REF },
          attributes: {},
          dependencies: [],
          deletionPolicy: 'Snapshot',
        } as ResourceState,
      },
      outputs: {},
      lastModified: 1,
    };
    let snapshotLine: string | undefined;
    let identifier: string | undefined;
    const providerDelete = vi.fn(
      (_l: string, _p: string, _t: string, _props: unknown, ctx: { finalSnapshotIdentifier?: string }) => {
        identifier = ctx.finalSnapshotIdentifier;
        const line = `Final snapshot ${identifier}`;
        snapshotLine = currentLogLineMasker()?.(line) ?? line;
        return Promise.resolve(undefined);
      }
    );
    const result = await runDestroyForStack('TestStack', state, makeCtx(providerDelete));
    expect(result.errorCount).toBe(0);
    // Premise: an identifier derived from the name was built and handed over.
    expect(identifier).toMatch(/^team-secret-db/);
    expect(snapshotLine).not.toContain('team-secret-db');
  });
});
