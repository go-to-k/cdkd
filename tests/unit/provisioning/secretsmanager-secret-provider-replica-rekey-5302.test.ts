// go-to-k/cdkd#5302: a real CloudFormation A/B showed that changing
// `ReplicaRegions[].KmsKeyId` for a region the secret already replicates to is
// applied IN PLACE: CloudFormation calls ReplicateSecretToRegions for that
// region with the new key (or with no key when `KmsKeyId` is removed, which
// re-keys the replica to the AWS managed key) and never calls
// RemoveRegionsFromReplication. cdkd must send the same call.
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ReplicateSecretToRegionsCommand,
  RemoveRegionsFromReplicationCommand,
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
const KEY_A = 'arn:aws:kms:us-west-2:0:key/aaaa';
const KEY_B = 'arn:aws:kms:us-west-2:0:key/bbbb';

type Replica = { Region: string; KmsKeyId?: string };

function replicateCalls(): Replica[][] {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ReplicateSecretToRegionsCommand)
    .map((c) => (c[0].input as { AddReplicaRegions: Replica[] }).AddReplicaRegions);
}

function removeCalls(): unknown[] {
  return mockSend.mock.calls.filter((c) => c[0] instanceof RemoveRegionsFromReplicationCommand);
}

describe('SecretsManagerSecretProvider update() replica re-key (issue #5302)', () => {
  let provider: SecretsManagerSecretProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new SecretsManagerSecretProvider();
  });

  async function update(next: Replica[] | undefined, prev: Replica[] | undefined): Promise<void> {
    await provider.update(
      'L',
      SECRET_ARN,
      TYPE,
      { Name: 'my-secret', ...(next ? { ReplicaRegions: next } : {}) },
      { Name: 'my-secret', ...(prev ? { ReplicaRegions: prev } : {}) }
    );
  }

  it('re-sends a kept region whose KmsKeyId changed, without removing it', async () => {
    await update([{ Region: 'us-west-2', KmsKeyId: KEY_B }], [{ Region: 'us-west-2', KmsKeyId: KEY_A }]);

    expect(replicateCalls()).toEqual([[{ Region: 'us-west-2', KmsKeyId: KEY_B }]]);
    expect(removeCalls()).toHaveLength(0);
  });

  it('re-sends a kept region whose KmsKeyId was removed, with no key (the AWS managed key)', async () => {
    await update([{ Region: 'us-west-2' }], [{ Region: 'us-west-2', KmsKeyId: KEY_A }]);

    expect(replicateCalls()).toEqual([[{ Region: 'us-west-2', KmsKeyId: undefined }]]);
    expect(removeCalls()).toHaveLength(0);
  });

  it('re-sends a kept region whose KmsKeyId was added', async () => {
    await update([{ Region: 'us-west-2', KmsKeyId: KEY_A }], [{ Region: 'us-west-2' }]);

    expect(replicateCalls()).toEqual([[{ Region: 'us-west-2', KmsKeyId: KEY_A }]]);
    expect(removeCalls()).toHaveLength(0);
  });

  it('leaves an unchanged region alone when another region is re-keyed or added', async () => {
    await update(
      [
        { Region: 'eu-west-1', KmsKeyId: KEY_A },
        { Region: 'us-west-2', KmsKeyId: KEY_B },
        { Region: 'ap-northeast-1' },
      ],
      [
        { Region: 'us-west-2', KmsKeyId: KEY_A },
        { Region: 'eu-west-1', KmsKeyId: KEY_A },
      ]
    );

    expect(replicateCalls()).toEqual([
      [{ Region: 'us-west-2', KmsKeyId: KEY_B }, { Region: 'ap-northeast-1' }],
    ]);
    expect(removeCalls()).toHaveLength(0);
  });

  it('sends nothing when the same regions and keys are only reordered', async () => {
    await update(
      [
        { Region: 'eu-west-1' },
        { Region: 'us-west-2', KmsKeyId: KEY_A },
      ],
      [
        { Region: 'us-west-2', KmsKeyId: KEY_A },
        { Region: 'eu-west-1' },
      ]
    );

    expect(replicateCalls()).toHaveLength(0);
    expect(removeCalls()).toHaveLength(0);
  });

  it('treats a default-key replica in readCurrentState shape (the AWS managed alias) as unchanged', async () => {
    // A `drift --revert` base reads the replica back as
    // `{ Region, KmsKeyId: 'alias/aws/secretsmanager' }`; the template omits the key.
    await update(
      [{ Region: 'us-west-2' }, { Region: 'eu-west-1', KmsKeyId: 'alias/aws/secretsmanager' }],
      [
        { Region: 'us-west-2', KmsKeyId: 'alias/aws/secretsmanager' },
        { Region: 'eu-west-1', KmsKeyId: '' },
        { Region: 'ap-northeast-1' },
      ]
    );

    expect(replicateCalls()).toHaveLength(0);
  });

  it('still re-keys from the AWS managed alias to a customer managed key', async () => {
    await update(
      [{ Region: 'us-west-2', KmsKeyId: KEY_A }],
      [{ Region: 'us-west-2', KmsKeyId: 'alias/aws/secretsmanager' }]
    );

    expect(replicateCalls()).toEqual([[{ Region: 'us-west-2', KmsKeyId: KEY_A }]]);
  });

  it("sends no key, never '', when a kept region moves to readCurrentState's '' placeholder", async () => {
    // '' compares equal to no key, so from a customer managed key it re-keys
    // to the AWS managed key, and the wire carries no '' (AWS rejects it).
    await update(
      [{ Region: 'us-west-2', KmsKeyId: '' }],
      [{ Region: 'us-west-2', KmsKeyId: KEY_A }]
    );

    expect(replicateCalls()).toEqual([[{ Region: 'us-west-2', KmsKeyId: undefined }]]);
  });

  it('still removes a region that left the list and replicates a new one', async () => {
    await update([{ Region: 'eu-west-1', KmsKeyId: KEY_B }], [{ Region: 'us-west-2', KmsKeyId: KEY_A }]);

    expect(removeCalls()).toHaveLength(1);
    expect(
      (removeCalls()[0] as [{ input: { RemoveReplicaRegions: string[] } }])[0].input
        .RemoveReplicaRegions
    ).toEqual(['us-west-2']);
    expect(replicateCalls()).toEqual([[{ Region: 'eu-west-1', KmsKeyId: KEY_B }]]);
  });
});
