import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { withRetry } from '../../../src/deployment/retry.js';

/**
 * go-to-k/cdkd#4945: `CreateAccessKey` takes no name and no idempotency token,
 * so a replay of a create that left its key behind mints a second key, which
 * fills the user's 2-key quota while the journal records one of them. An
 * implicit deny on `UpdateAccessKey` reads `not authorized to perform`, the
 * IAM-propagation pattern `withRetry` retries (an EXPLICIT deny is terminal
 * since go-to-k/cdkd#4969).
 */

const TYPE = 'AWS::IAM::AccessKey';
// Built at runtime so no literal access key id sits in the source.
const keyId = (n: number): string => ['AK', 'IA', `KEY${n}`].join('');
const DENY =
  'User: arn:aws:iam::123456789012:user/deployer is not authorized to perform: ' +
  'iam:UpdateAccessKey on resource: user alice because no identity-based policy allows the iam:UpdateAccessKey action';

let minted: string[];
let deleteFails: boolean;

beforeEach(() => {
  minted = [];
  deleteFails = true;
  mockSend.mockReset();
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'ListAccessKeysCommand':
        return Promise.resolve({
          AccessKeyMetadata: minted.map((id) => ({ AccessKeyId: id, CreateDate: new Date() })),
        });
      case 'CreateAccessKeyCommand': {
        if (minted.length >= 2) {
          const quota = new Error('Cannot exceed quota for AccessKeysPerUser: 2');
          quota.name = 'LimitExceededException';
          return Promise.reject(quota);
        }
        const id = keyId(minted.length + 1);
        minted.push(id);
        return Promise.resolve({ AccessKey: { AccessKeyId: id, SecretAccessKey: 'secret' } });
      }
      case 'DeleteAccessKeyCommand':
      case 'UpdateAccessKeyCommand': {
        if (command.constructor.name === 'DeleteAccessKeyCommand' && !deleteFails) {
          minted.pop();
          return Promise.resolve({});
        }
        const deny = new Error(DENY);
        deny.name = 'AccessDenied';
        return Promise.reject(deny);
      }
      default:
        return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
    }
  });
});

async function createUnderRetry(): Promise<unknown> {
  const provider = new IAMAccessKeyProvider();
  return withRetry(
    () => provider.create('MyKey', TYPE, { UserName: 'alice', Status: 'Inactive' }),
    'MyKey',
    { sleep: () => Promise.resolve() }
  ).then(
    () => undefined,
    (e: unknown) => e
  );
}

describe('IAMAccessKeyProvider: a create that left its key behind is not replayed (go-to-k/cdkd#4945)', () => {
  it('mints one key, journals it, and fails on the deny rather than the quota', async () => {
    const error = await createUnderRetry();

    expect(minted).toEqual([keyId(1)]);
    expect(createdBeforeFailure(error, 'MyKey', TYPE)).toBe(keyId(1));
    expect(String(error)).toContain('no identity-based policy allows');
    expect(String(error)).not.toContain('AccessKeysPerUser');
  });

  it('still retries when the cleanup deleted the key', async () => {
    deleteFails = false;
    const error = await createUnderRetry();

    // Retried to the end of the propagation budget, one key minted and
    // deleted per attempt, none left.
    expect(mockSend.mock.calls.filter(([c]) => c.constructor.name === 'CreateAccessKeyCommand').length).toBeGreaterThan(1);
    expect(minted).toEqual([]);
    expect(createdBeforeFailure(error, 'MyKey', TYPE)).toBeUndefined();
  });
});
