/**
 * go-to-k/cdkd#7015: `attributesReadAfterApply` is a sha256 over the stale-shape
 * check's inputs. When `cdkd scrub` rewrites one of those inputs (a CA
 * identifier spelled from a secret, now `***` / its expression), the stamp no
 * longer names what the record holds, so scrub drops it. A scrub that rewrites
 * only other leaves keeps it.
 *
 * Drives `scrubStack` with the REAL resolver against a mocked Secrets Manager.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';
import { staleShapeFingerprint } from '../../../../src/deployment/intrinsic-resolver/getatt-stale-shape.js';

const SECRETS = { ca: 'rds-ca-secretly-named-g1', pw: 'a-long-master-password-value' };

vi.mock('../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    secretsManager: {
      send: vi.fn(async () => ({ SecretString: JSON.stringify(SECRETS) })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));
vi.mock('@aws-sdk/client-secrets-manager', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  class FakeSecretsManagerClient {
    readonly config = { region: () => Promise.resolve('us-east-1') };
    constructor(_config?: unknown) {}
    async send(): Promise<unknown> {
      return { SecretString: JSON.stringify(SECRETS) };
    }
    destroy(): void {}
  }
  return { ...actual, SecretsManagerClient: FakeSecretsManagerClient };
});

import { scrubStack } from '../../../../src/cli/commands/scrub.js';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const CA_REF = '{{resolve:secretsmanager:db:SecretString:ca::}}';
const PW_REF = '{{resolve:secretsmanager:db:SecretString:pw::}}';

/** A stamped pre-#7006 record: the port contradicts, and AWS still reported it. */
function stampedRecord(caInProperties: string): ResourceState {
  const record = {
    physicalId: 'mydb',
    resourceType: 'AWS::RDS::DBInstance',
    properties: {
      Port: '5433',
      CACertificateIdentifier: caInProperties,
      MasterUserPassword: SECRETS.pw,
    },
    attributes: { 'Endpoint.Port': '5432', 'CertificateDetails.CAIdentifier': caInProperties },
    dependencies: [],
    provisionedBy: 'sdk',
  } as ResourceState;
  return { ...record, attributesReadAfterApply: staleShapeFingerprint(record)! };
}

async function scrubWith(caTemplate: string, record: ResourceState): Promise<ResourceState> {
  const template = {
    Resources: {
      Db: {
        Type: 'AWS::RDS::DBInstance',
        Properties: { Port: '5433', CACertificateIdentifier: caTemplate, MasterUserPassword: PW_REF },
      },
    },
    Outputs: {},
  } as unknown as CloudFormationTemplate;
  const state = {
    version: 11,
    region: 'us-east-1',
    stackName: 'S',
    resources: { Db: record },
    outputs: {},
    lastModified: 0,
  } as StackState;
  const saveState = vi.fn().mockResolvedValue('etag-2');
  await scrubStack(
    { stackName: 'S', template } as never,
    'us-east-1',
    {
      getState: vi.fn().mockResolvedValue({ state, etag: 'etag-1' }),
      saveState,
      purgeNoncurrentVersions: vi.fn().mockResolvedValue(undefined),
      listStacks: vi.fn().mockResolvedValue([]),
    } as never,
    {
      acquireLockWithRetry: vi.fn().mockResolvedValue(undefined),
      releaseLock: vi.fn().mockResolvedValue(undefined),
    } as never,
    { dryRun: false, logger } as never
  );
  expect(saveState).toHaveBeenCalled();
  return (saveState.mock.calls.at(-1)![2] as StackState).resources['Db']!;
}

describe('cdkd scrub and the stale-shape stamp (#7015)', () => {
  it('drops the stamp when it rewrites one of the check inputs', async () => {
    const saved = await scrubWith(CA_REF, stampedRecord(SECRETS.ca));
    expect(saved.properties['CACertificateIdentifier']).not.toBe(SECRETS.ca);
    expect(saved).not.toHaveProperty('attributesReadAfterApply');
  });

  it('control: keeps the stamp when it rewrites only another leaf', async () => {
    const record = stampedRecord('rds-ca-rsa2048-g1');
    const saved = await scrubWith('rds-ca-rsa2048-g1', record);
    expect(saved.properties['MasterUserPassword']).not.toBe(SECRETS.pw);
    expect(saved.attributesReadAfterApply).toBe(record.attributesReadAfterApply);
  });
});
