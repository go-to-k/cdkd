import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeKeyCommand,
  PutKeyPolicyCommand,
  UpdateKeyDescriptionCommand,
} from '@aws-sdk/client-kms';

// Issue #5299: an AWS::KMS::Key update used to send nothing for a changed
// KeySpec / KeyUsage / MultiRegion / Origin and report success, and its
// PutKeyPolicy never carried BypassPolicyLockoutSafetyCheck. CloudFormation
// fails the update for each of the four (A/B, us-east-1, 2026-10-26).

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    KMSClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { KMSProvider } from '../../../../src/provisioning/providers/kms-provider.js';
import { ResourceUpdateNotSupportedError } from '../../../../src/utils/error-handler.js';

const TYPE = 'AWS::KMS::Key';
const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const POLICY_A = {
  Version: '2012-10-17',
  Statement: [{ Effect: 'Allow', Principal: { AWS: '*' }, Action: 'kms:*', Resource: '*' }],
};
const POLICY_B = {
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Allow', Principal: { AWS: '*' }, Action: 'kms:DescribeKey', Resource: '*' },
  ],
};

async function update(
  properties: Record<string, unknown>,
  previous: Record<string, unknown>
): Promise<unknown> {
  return new KMSProvider().update('MyKey', KEY_ID, TYPE, properties, previous);
}

// The refusal reads the live key first (a pre-fix record can hold a value the
// key never took); nothing else may be sent.
function onlyDescribeKey(): boolean {
  const sent = mockSend.mock.calls.map((c) => c[0]);
  return sent.length === 1 && sent[0] instanceof DescribeKeyCommand;
}

function liveKey(metadata: Record<string, unknown>): void {
  mockSend.mockImplementation(async (command: unknown) =>
    command instanceof DescribeKeyCommand ? { KeyMetadata: { KeyId: KEY_ID, ...metadata } } : {}
  );
}

describe('KMS Key update: immutable properties (issue #5299)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  it('refuses when the live key holds the previous value', async () => {
    liveKey({ KeySpec: 'RSA_2048', KeyUsage: 'ENCRYPT_DECRYPT', MultiRegion: false, Origin: 'AWS_KMS' });
    const err = await update(
      { KeySpec: 'RSA_2048', KeyUsage: 'SIGN_VERIFY', Description: 'new' },
      { KeySpec: 'RSA_2048', KeyUsage: 'ENCRYPT_DECRYPT', Description: 'old' }
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(onlyDescribeKey()).toBe(true);
  });

  it('refuses when the live key cannot be read', async () => {
    mockSend.mockRejectedValue(new Error('AccessDeniedException'));
    const err = await update({ KeyUsage: 'SIGN_VERIFY' }, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(onlyDescribeKey()).toBe(true);
  });

  it('applies the rest when a pre-fix record differs but the live key already holds the desired value', async () => {
    // A cdkd before the fix recorded SIGN_VERIFY while the key kept
    // ENCRYPT_DECRYPT; the template is now put back to the live value.
    liveKey({ KeySpec: 'RSA_2048', KeyUsage: 'ENCRYPT_DECRYPT', MultiRegion: false, Origin: 'AWS_KMS' });
    await update(
      { KeySpec: 'RSA_2048', KeyUsage: 'ENCRYPT_DECRYPT', Description: 'new' },
      { KeySpec: 'RSA_2048', KeyUsage: 'SIGN_VERIFY', Description: 'old' }
    );
    const sent = mockSend.mock.calls.map((c) => c[0]);
    expect(sent.map((c) => (c as object).constructor.name)).toEqual([
      'DescribeKeyCommand',
      'UpdateKeyDescriptionCommand',
    ]);
  });

  it('treats a readback-shaped previous side (drift --revert) as no change', async () => {
    await update(
      { Description: 'new' },
      {
        KeySpec: 'SYMMETRIC_DEFAULT',
        KeyUsage: 'ENCRYPT_DECRYPT',
        MultiRegion: false,
        Origin: 'AWS_KMS',
        Description: 'old',
      }
    );
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(UpdateKeyDescriptionCommand);
  });

  it.each([
    ['KeySpec', { KeySpec: 'RSA_3072', KeyUsage: 'SIGN_VERIFY' }, { KeySpec: 'RSA_2048', KeyUsage: 'SIGN_VERIFY' }],
    ['KeyUsage', { KeySpec: 'RSA_2048', KeyUsage: 'SIGN_VERIFY' }, { KeySpec: 'RSA_2048', KeyUsage: 'ENCRYPT_DECRYPT' }],
    ['MultiRegion', { MultiRegion: true }, {}],
    ['MultiRegion', { MultiRegion: 'false' }, { MultiRegion: 'true' }],
    ['Origin', { Origin: 'EXTERNAL' }, {}],
    ['KeySpec', {}, { KeySpec: 'HMAC_256', KeyUsage: 'ENCRYPT_DECRYPT' }],
  ])('refuses a changed %s before any call, beside a Description change', async (name, next, prev) => {
    const err = await update(
      { ...next, Description: 'new' },
      { ...prev, Description: 'old' }
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((err as Error).message).toContain(`${name} changed`);
    expect((err as Error).message).toContain('--replace, plus --force-stateful-recreation unless');
    expect(onlyDescribeKey()).toBe(true);
  });

  it('names every changed property in one refusal', async () => {
    const err = await update(
      { KeySpec: 'HMAC_256', KeyUsage: 'GENERATE_VERIFY_MAC' },
      {}
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect((err as Error).message).toContain('KeySpec, KeyUsage changed');
    expect(onlyDescribeKey()).toBe(true);
  });

  it('prints no property value', async () => {
    const err = await update({ KeySpec: 'RSA_4096' }, { KeySpec: 'RSA_2048' }).catch(
      (e: unknown) => e
    );
    expect((err as Error).message).not.toContain('RSA_4096');
    expect((err as Error).message).not.toContain('RSA_2048');
  });

  it.each([
    [
      'declaring each default',
      { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', MultiRegion: false, Origin: 'AWS_KMS' },
      {},
    ],
    [
      'dropping each declared default',
      {},
      { KeySpec: 'SYMMETRIC_DEFAULT', KeyUsage: 'ENCRYPT_DECRYPT', MultiRegion: 'false', Origin: 'AWS_KMS' },
    ],
    ['an unchanged non-default set', { KeySpec: 'RSA_2048', KeyUsage: 'SIGN_VERIFY', MultiRegion: true }, { KeySpec: 'RSA_2048', KeyUsage: 'SIGN_VERIFY', MultiRegion: 'true' }],
  ])('treats %s as no change and applies the rest', async (_label, next, prev) => {
    await update({ ...next, Description: 'new' }, { ...prev, Description: 'old' });
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][0]).toBeInstanceOf(UpdateKeyDescriptionCommand);
  });
});

describe('KMS Key update: BypassPolicyLockoutSafetyCheck on PutKeyPolicy (issue #5299)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
  });

  function putInput(): Record<string, unknown> {
    const put = mockSend.mock.calls.map((c) => c[0]).find((c) => c instanceof PutKeyPolicyCommand);
    expect(put).toBeDefined();
    return (put as PutKeyPolicyCommand).input as unknown as Record<string, unknown>;
  }

  it.each([true, 'true'])('sends the declared bypass (%s) with a changed policy', async (bypass) => {
    await update(
      { KeyPolicy: POLICY_B, BypassPolicyLockoutSafetyCheck: bypass },
      { KeyPolicy: POLICY_A, BypassPolicyLockoutSafetyCheck: bypass }
    );
    expect(putInput()).toEqual({
      KeyId: KEY_ID,
      PolicyName: 'default',
      Policy: JSON.stringify(POLICY_B),
      BypassPolicyLockoutSafetyCheck: true,
    });
  });

  it.each([undefined, false, 'false'])('omits the bypass when it is %s', async (bypass) => {
    await update(
      { KeyPolicy: POLICY_B, BypassPolicyLockoutSafetyCheck: bypass },
      { KeyPolicy: POLICY_A }
    );
    expect(putInput()).not.toHaveProperty('BypassPolicyLockoutSafetyCheck');
  });

  it('a bypass change alone sends nothing, as the flag only qualifies a policy put', async () => {
    await update(
      { KeyPolicy: POLICY_A, BypassPolicyLockoutSafetyCheck: true },
      { KeyPolicy: POLICY_A }
    );
    expect(mockSend).not.toHaveBeenCalled();
  });
});
