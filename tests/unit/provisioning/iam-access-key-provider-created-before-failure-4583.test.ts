import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { IAMAccessKeyProvider } from '../../../src/provisioning/providers/iam-access-key-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

const RESOURCE_TYPE = 'AWS::IAM::AccessKey';
const KEY_ID = 'AKIA0001';
const SECRET = 'wJalrXUtnFEMI-secret-must-never-surface';

interface Script {
  /** The CreateAccessKey response, or an error to reject with. */
  create: Record<string, unknown> | Error;
  updateFails?: boolean;
  cleanupDeleteFails?: boolean;
  /** `undefined` = ListAccessKeys fails (reconcile disarmed). */
  listAfterCreate?: string[];
  reconcileDeleteFails?: boolean;
}

function script(s: Script): void {
  let listCalls = 0;
  let deleteCalls = 0;
  mockSend.mockImplementation((command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'ListAccessKeysCommand': {
        listCalls++;
        if (listCalls === 1) return Promise.resolve({ AccessKeyMetadata: [] });
        if (s.listAfterCreate === undefined) return Promise.reject(new Error('AccessDenied'));
        return Promise.resolve({
          AccessKeyMetadata: s.listAfterCreate.map((id) => ({
            AccessKeyId: id,
            CreateDate: new Date(Date.now() + 60_000),
          })),
        });
      }
      case 'CreateAccessKeyCommand':
        return s.create instanceof Error ? Promise.reject(s.create) : Promise.resolve(s.create);
      case 'UpdateAccessKeyCommand':
        return s.updateFails ? Promise.reject(new Error('UpdateAccessKey boom')) : Promise.resolve({});
      case 'DeleteAccessKeyCommand': {
        deleteCalls++;
        const fails = deleteCalls === 1 ? s.cleanupDeleteFails : s.reconcileDeleteFails;
        return fails ? Promise.reject(new Error('DeleteAccessKey boom')) : Promise.resolve({});
      }
      default:
        return Promise.reject(new Error(`unexpected ${command.constructor.name}`));
    }
  });
}

async function createError(
  provider: IAMAccessKeyProvider,
  properties: Record<string, unknown> = { UserName: 'alice', Status: 'Inactive' }
): Promise<unknown> {
  try {
    await provider.create('MyKey', RESOURCE_TYPE, properties);
  } catch (error) {
    return error;
  }
  throw new Error('create() did not throw');
}

const FULL = { AccessKey: { AccessKeyId: KEY_ID, SecretAccessKey: SECRET } };

describe('IAMAccessKeyProvider created-before-failure mark (go-to-k/cdkd#4583)', () => {
  let provider: IAMAccessKeyProvider;

  beforeEach(() => {
    mockSend.mockReset();
    provider = new IAMAccessKeyProvider();
  });

  it('marks the key id (never the secret) when the Inactive wiring and both deletes failed', async () => {
    script({ create: FULL, updateFails: true, cleanupDeleteFails: true });

    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBe(KEY_ID);
    expect(String(error)).not.toContain(SECRET);
  });

  it('marks the key id when the reconcile listed the key but could not delete it', async () => {
    script({
      create: FULL,
      updateFails: true,
      cleanupDeleteFails: true,
      listAfterCreate: [KEY_ID],
      reconcileDeleteFails: true,
    });

    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBe(KEY_ID);
  });

  it('does not mark when the reconcile deleted the key the cleanup could not', async () => {
    script({
      create: FULL,
      updateFails: true,
      cleanupDeleteFails: true,
      listAfterCreate: [KEY_ID],
    });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark when the wiring cleanup deleted the key', async () => {
    script({ create: FULL, updateFails: true });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBeUndefined();
  });

  it('marks the key id a partial response minted when its cleanup failed', async () => {
    script({ create: { AccessKey: { AccessKeyId: KEY_ID } }, cleanupDeleteFails: true });

    const error = await createError(provider, { UserName: 'alice' });
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBe(KEY_ID);
  });

  it('does not mark a partial response whose key the cleanup deleted', async () => {
    script({ create: { AccessKey: { AccessKeyId: KEY_ID } } });

    const error = await createError(provider, { UserName: 'alice' });
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark when CreateAccessKey itself failed', async () => {
    script({ create: new Error('LimitExceeded') });

    const error = await createError(provider);
    expect(error).toBeInstanceOf(Error);
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBeUndefined();
  });

  it('does not mark a pre-flight refusal (no UserName)', async () => {
    const error = await createError(provider, {});
    expect(error).toBeInstanceOf(Error);
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'MyKey', RESOURCE_TYPE)).toBeUndefined();
  });
});
