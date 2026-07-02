import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  AssociateKmsKeyCommand,
  DisassociateKmsKeyCommand,
  PutRetentionPolicyCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudWatchLogs: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: {
      send: vi.fn(() => Promise.resolve({ Account: '123456789012' })),
      config: { region: () => Promise.resolve('us-east-1') },
    },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

import { LogsLogGroupProvider } from '../../../src/provisioning/providers/logs-loggroup-provider.js';

const RESOURCE_TYPE = 'AWS::Logs::LogGroup';
const PHYSICAL_ID = '/cdkd/kms-update-test';
const KEY_A = 'arn:aws:kms:us-east-1:123456789012:key/aaaaaaaa-1111-2222-3333-444444444444';
const KEY_B = 'arn:aws:kms:us-east-1:123456789012:key/bbbbbbbb-1111-2222-3333-444444444444';

const sent = (Command: new (input: never) => unknown) =>
  mockSend.mock.calls.find((c) => c[0] instanceof Command)?.[0];

// A KmsKeyId change on an existing log group was previously silently DROPPED:
// update() had no branch for it (while ReplacementRulesRegistry classifies it
// as updateable), so the deploy reported success while AWS kept the old (or
// no) key, and state recorded the new one so the next diff saw no change.
// CloudFormation applies it in place via AssociateKmsKey / DisassociateKmsKey.
describe('LogsLogGroupProvider KmsKeyId update (silent-drop regression)', () => {
  let provider: LogsLogGroupProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockResolvedValue({});
    provider = new LogsLogGroupProvider();
  });

  it('associates the key when KmsKeyId is added', async () => {
    await provider.update('Lg', PHYSICAL_ID, RESOURCE_TYPE, { KmsKeyId: KEY_A }, {});

    const cmd = sent(AssociateKmsKeyCommand);
    expect(cmd).toBeDefined();
    expect(cmd.input).toEqual({ logGroupName: PHYSICAL_ID, kmsKeyId: KEY_A });
    expect(sent(DisassociateKmsKeyCommand)).toBeUndefined();
  });

  it('re-associates when the key changes (single Associate, no Disassociate window)', async () => {
    await provider.update('Lg', PHYSICAL_ID, RESOURCE_TYPE, { KmsKeyId: KEY_B }, { KmsKeyId: KEY_A });

    const cmd = sent(AssociateKmsKeyCommand);
    expect(cmd).toBeDefined();
    expect(cmd.input).toEqual({ logGroupName: PHYSICAL_ID, kmsKeyId: KEY_B });
    // A change must be ONE AssociateKmsKey — a disassociate-then-associate
    // sequence would open an unencrypted window CloudFormation doesn't have.
    expect(sent(DisassociateKmsKeyCommand)).toBeUndefined();
  });

  it('fires AFTER the LogGroupClass guard (a doomed class change mutates nothing)', async () => {
    await expect(
      provider.update(
        'Lg',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        { LogGroupClass: 'INFREQUENT_ACCESS', KmsKeyId: KEY_A },
        {}
      )
    ).rejects.toMatchObject({ name: 'ResourceUpdateNotSupportedError' });

    expect(sent(AssociateKmsKeyCommand)).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('disassociates when KmsKeyId is removed', async () => {
    await provider.update('Lg', PHYSICAL_ID, RESOURCE_TYPE, {}, { KmsKeyId: KEY_A });

    const cmd = sent(DisassociateKmsKeyCommand);
    expect(cmd).toBeDefined();
    expect(cmd.input).toEqual({ logGroupName: PHYSICAL_ID });
    expect(sent(AssociateKmsKeyCommand)).toBeUndefined();
  });

  it('issues no KMS call when the key is unchanged (other updates proceed)', async () => {
    await provider.update(
      'Lg',
      PHYSICAL_ID,
      RESOURCE_TYPE,
      { KmsKeyId: KEY_A, RetentionInDays: 7 },
      { KmsKeyId: KEY_A, RetentionInDays: 1 }
    );

    expect(sent(AssociateKmsKeyCommand)).toBeUndefined();
    expect(sent(DisassociateKmsKeyCommand)).toBeUndefined();
    expect(sent(PutRetentionPolicyCommand)).toBeDefined();
  });
});
