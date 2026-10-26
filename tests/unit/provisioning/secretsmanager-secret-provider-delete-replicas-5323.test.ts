// go-to-k/cdkd#5323: Secrets Manager refuses DeleteSecret on a primary that
// still has replica regions (InvalidParameterException, probed on real AWS).
// CloudFormation removes the replica regions first, then deletes the primary,
// so cdkd does the same on that refusal — and only on it.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DeleteSecretCommand,
  DescribeSecretCommand,
  RemoveRegionsFromReplicationCommand,
  InvalidParameterException,
  InvalidRequestException,
} from '@aws-sdk/client-secrets-manager';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    secretsManager: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SecretsManagerSecretProvider } from '../../../src/provisioning/providers/secretsmanager-secret-provider.js';

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:0:secret:my-secret-AbCdEf';
const TYPE = 'AWS::SecretsManager::Secret';

const replicaRefusal = (): InvalidParameterException =>
  new InvalidParameterException({
    $metadata: {},
    message: `You can't delete secret ${SECRET_ARN} that still has replica regions [us-west-2, eu-west-1].`,
  });

// The provider wraps a failure in a ProvisioningError naming only the error
// class; the AWS error itself rides `cause`.
async function causeOf(p: Promise<unknown>): Promise<unknown> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  return (err as { cause?: unknown }).cause;
}

function callNames(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
}

describe('SecretsManagerSecretProvider delete() with replica regions (issue #5323)', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new SecretsManagerSecretProvider();
  });

  it('removes every replica region, then deletes the primary', async () => {
    let deletes = 0;
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) {
        deletes += 1;
        return deletes === 1 ? Promise.reject(replicaRefusal()) : Promise.resolve({});
      }
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.resolve({
          ReplicationStatus: [{ Region: 'us-west-2' }, { Region: 'eu-west-1' }],
        });
      }
      return Promise.resolve({});
    });

    await provider.delete('L', SECRET_ARN, TYPE);

    expect(callNames()).toEqual([
      'DeleteSecretCommand',
      'DescribeSecretCommand',
      'RemoveRegionsFromReplicationCommand',
      'DeleteSecretCommand',
    ]);
    const remove = mockSend.mock.calls.find((c) => c[0] instanceof RemoveRegionsFromReplicationCommand)!;
    expect(remove[0].input).toEqual({
      SecretId: SECRET_ARN,
      RemoveReplicaRegions: ['us-west-2', 'eu-west-1'],
    });
    const lastDelete = mockSend.mock.calls.at(-1)!;
    expect(lastDelete[0].input).toEqual({ SecretId: SECRET_ARN, ForceDeleteWithoutRecovery: true });
  });

  it('makes no extra call when the delete succeeds', async () => {
    mockSend.mockResolvedValue({});

    await provider.delete('L', SECRET_ARN, TYPE);

    expect(callNames()).toEqual(['DeleteSecretCommand']);
  });

  it('rethrows the refusal when the secret reports no replica region', async () => {
    const refusal = replicaRefusal();
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) return Promise.reject(refusal);
      if (cmd instanceof DescribeSecretCommand) return Promise.resolve({ ReplicationStatus: [] });
      return Promise.resolve({});
    });

    expect(await causeOf(provider.delete('L', SECRET_ARN, TYPE))).toBe(refusal);
    expect(callNames()).toEqual(['DeleteSecretCommand', 'DescribeSecretCommand']);
  });

  it('rethrows the refusal, not the read failure, when DescribeSecret fails', async () => {
    const refusal = replicaRefusal();
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) return Promise.reject(refusal);
      if (cmd instanceof DescribeSecretCommand) return Promise.reject(new Error('read throttled'));
      return Promise.resolve({});
    });

    expect(await causeOf(provider.delete('L', SECRET_ARN, TYPE))).toBe(refusal);
    expect(callNames()).toEqual(['DeleteSecretCommand', 'DescribeSecretCommand']);
  });

  it('does not touch replicas on any other delete failure', async () => {
    const other = new InvalidRequestException({ $metadata: {}, message: 'other refusal' });
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DeleteSecretCommand ? Promise.reject(other) : Promise.resolve({})
    );

    expect(await causeOf(provider.delete('L', SECRET_ARN, TYPE))).toBe(other);
    expect(callNames()).toEqual(['DeleteSecretCommand']);
  });

  it('does not touch replicas on an InvalidParameterException about anything else', async () => {
    const other = new InvalidParameterException({ $metadata: {}, message: 'some other parameter' });
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) return Promise.reject(other);
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.resolve({ ReplicationStatus: [{ Region: 'us-west-2' }] });
      }
      return Promise.resolve({});
    });

    expect(await causeOf(provider.delete('L', SECRET_ARN, TYPE))).toBe(other);
    expect(callNames()).toEqual(['DeleteSecretCommand']);
  });

  it('names the replica-removal step and the manual next step when RemoveRegions rejects', async () => {
    const denied = new InvalidRequestException({ $metadata: {}, message: 'region opted out' });
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) return Promise.reject(replicaRefusal());
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.resolve({
          ReplicationStatus: [{ Region: 'us-west-2' }, { Region: 'eu-west-1' }],
        });
      }
      if (cmd instanceof RemoveRegionsFromReplicationCommand) return Promise.reject(denied);
      return Promise.resolve({});
    });

    const err = await provider.delete('L', SECRET_ARN, TYPE).then(
      () => undefined,
      (e: unknown) => e as Error & { cause?: unknown }
    );
    expect(err?.cause).toBe(denied);
    expect(err?.message).toContain('removing its replica regions us-west-2 eu-west-1 first');
    expect(err?.message).toContain(
      `aws secretsmanager remove-regions-from-replication --secret-id ${SECRET_ARN} --remove-replica-regions us-west-2 eu-west-1`
    );
    expect(err?.message).toContain('re-run destroy');
    // No second DeleteSecret after the removal failed.
    expect(callNames()).toEqual([
      'DeleteSecretCommand',
      'DescribeSecretCommand',
      'RemoveRegionsFromReplicationCommand',
    ]);
  });

  it('masks a secret-derived physical id in the manual next step', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) return Promise.reject(replicaRefusal());
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.resolve({ ReplicationStatus: [{ Region: 'us-west-2' }] });
      }
      if (cmd instanceof RemoveRegionsFromReplicationCommand) {
        return Promise.reject(new InvalidRequestException({ $metadata: {}, message: 'denied' }));
      }
      return Promise.resolve({});
    });

    const err = await provider
      .delete('L', SECRET_ARN, TYPE, undefined, {
        maskSecrets: (t: string) => t.split('my-secret').join('***'),
      } as never)
      .then(
        () => undefined,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain('--secret-id arn:aws:secretsmanager:us-east-1:0:secret:***-AbCdEf');
    expect(err?.message).not.toContain('my-secret');
  });

  it('a failed second delete does not claim the replica removal failed', async () => {
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) {
        return mockSend.mock.calls.filter((c) => c[0] instanceof DeleteSecretCommand).length === 1
          ? Promise.reject(replicaRefusal())
          : Promise.reject(new InvalidRequestException({ $metadata: {}, message: 'x' }));
      }
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.resolve({ ReplicationStatus: [{ Region: 'us-west-2' }] });
      }
      return Promise.resolve({});
    });

    const err = await provider.delete('L', SECRET_ARN, TYPE).then(
      () => undefined,
      (e: unknown) => e as Error
    );
    expect(err?.message).not.toContain('remove-regions-from-replication');
  });

  it('surfaces a failed second delete', async () => {
    const second = new InvalidRequestException({ $metadata: {}, message: 'second refusal' });
    mockSend.mockImplementation((cmd: unknown) => {
      if (cmd instanceof DeleteSecretCommand) {
        return mockSend.mock.calls.filter((c) => c[0] instanceof DeleteSecretCommand).length === 1
          ? Promise.reject(replicaRefusal())
          : Promise.reject(second);
      }
      if (cmd instanceof DescribeSecretCommand) {
        return Promise.resolve({ ReplicationStatus: [{ Region: 'us-west-2' }] });
      }
      return Promise.resolve({});
    });

    expect(await causeOf(provider.delete('L', SECRET_ARN, TYPE))).toBe(second);
  });
});
