/**
 * go-to-k/cdkd#7194: `--mask-unpositioned` masks an unverifiable orphan AFTER
 * its ordinary stored-record scrub, so a secret attribute KEY that scrub
 * drops (it never masks keys) is dropped from a masked record too.
 *
 * Drives `scrubStack` with the REAL resolver against a mocked Secrets Manager.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { ResourceState, StackState } from '../../../../src/types/state.js';
import type { CloudFormationTemplate } from '../../../../src/types/resource.js';

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
const PW_REF = '{{resolve:secretsmanager:db:SecretString:pw::}}';

describe('cdkd scrub --mask-unpositioned runs after the stored-record scrub (go-to-k/cdkd#7194)', () => {
  it("drops a custom resource attribute KEY holding this run's secret, as a plain scrub does", async () => {
    const template = {
      Parameters: { Pw: { Type: 'String', NoEcho: true, Default: 'q7' } },
      Resources: {
        Db: {
          Type: 'AWS::RDS::DBInstance',
          Properties: { MasterUserPassword: PW_REF, DBName: { Ref: 'Pw' } },
        },
      },
      Outputs: {},
    } as unknown as CloudFormationTemplate;
    const gone: ResourceState = {
      physicalId: 'gone-cr-7194',
      resourceType: 'Custom::Thing7194',
      properties: { ServiceToken: 'arn:aws:lambda:us-east-1:123456789012:function:f', Note: 'n' },
      attributes: { [`k-${SECRETS.pw}`]: 'v', Plain: 'p' },
    };
    const state = {
      version: 18,
      region: 'us-east-1',
      stackName: 'S',
      resources: {
        Db: {
          physicalId: 'mydb',
          resourceType: 'AWS::RDS::DBInstance',
          properties: { MasterUserPassword: PW_REF, DBName: '***' },
          noEchoLeaves: [['DBName']],
          attributes: {},
          dependencies: [],
        },
      },
      outputs: {},
      lastModified: 0,
      orphans: [{ logicalId: 'GoneCr', orphanedAt: 1, state: gone }],
    } as unknown as StackState;
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
      { dryRun: false, maskUnpositioned: true, logger } as never
    );
    expect(saveState).toHaveBeenCalled();
    const saved = saveState.mock.calls.at(-1)![2] as StackState;
    const row = saved.orphans![0]!.state;
    expect(Object.keys(row.attributes ?? {}).some((key) => key.includes(SECRETS.pw))).toBe(false);
    expect(row.attributes?.['Plain']).toBe('***');
    expect(JSON.stringify(saved)).not.toContain(SECRETS.pw);
  });
});
