import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateKeyCommand,
  DescribeKeyCommand,
  DisabledException,
  DisableKeyCommand,
  DisableKeyRotationCommand,
  EnableKeyCommand,
  EnableKeyRotationCommand,
  PutKeyPolicyCommand,
  UpdateKeyDescriptionCommand,
} from '@aws-sdk/client-kms';

// Issue #1160: what an AWS::KMS::Key update sends for a property REMOVED from
// the template, pinned to a CloudFormation A/B (us-east-1, 2026-10-20):
// Description cleared, `Enabled: false` enabled, `EnableKeyRotation: true`
// turned off, RotationPeriodInDays reset to 365, KeyPolicy reset to the KMS
// default key policy -- each alone and beside another change.

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

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { KMSProvider } from '../../../src/provisioning/providers/kms-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const TYPE = 'AWS::KMS::Key';
const KEY_ID = '1234abcd-12ab-34cd-56ef-1234567890ab';
const ACCOUNT = '111122223333';
const CUSTOM_POLICY = {
  Version: '2012-10-17',
  Statement: [
    {
      Sid: 'Custom',
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${ACCOUNT}:root` },
      Action: 'kms:*',
      Resource: '*',
    },
  ],
};

let keyArn: string | undefined;

function commands(): unknown[] {
  return mockSend.mock.calls.map((c) => c[0]);
}
function names(): string[] {
  return commands().map((c) => (c as object).constructor.name);
}
function sent<T>(type: new (...args: never[]) => T): T[] {
  return commands().filter((c): c is T => c instanceof type);
}

describe('KMSProvider Key update on property removal (issue #1160)', () => {
  let provider: KMSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    keyArn = `arn:aws:kms:us-east-1:${ACCOUNT}:key/${KEY_ID}`;
    mockSend.mockImplementation((command: unknown) => {
      if (command instanceof DescribeKeyCommand) {
        return Promise.resolve({ KeyMetadata: { KeyId: KEY_ID, Arn: keyArn } });
      }
      return Promise.resolve({});
    });
    provider = new KMSProvider();
  });

  // The deploy engine's path: the caller injects `removalDefaults` and names
  // the removed keys in `UpdateContext.removedProperties`.
  async function deployUpdate(
    desired: Record<string, unknown>,
    previous: Record<string, unknown>
  ): Promise<void> {
    const removal = prepareRemovalForUpdate(provider, TYPE, desired, previous);
    await provider.update('Key', KEY_ID, TYPE, removal.properties, previous, removal.context);
  }

  describe('RotationPeriodInDays', () => {
    it.each([
      ['a direct call', false],
      ['the deploy caller', true],
    ])('a removed period with rotation still on resets to 365 (%s)', async (_label, viaCaller) => {
      const previous = { EnableKeyRotation: true, RotationPeriodInDays: 90 };
      const desired = { EnableKeyRotation: true };
      if (viaCaller) await deployUpdate(desired, previous);
      else await provider.update('Key', KEY_ID, TYPE, desired, previous);

      const calls = sent(EnableKeyRotationCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.input).toEqual({ KeyId: KEY_ID, RotationPeriodInDays: 365 });
    });

    it('a removed period beside a Description change still resets to 365', async () => {
      await deployUpdate(
        { Description: 'v2', EnableKeyRotation: true },
        { Description: 'v1', EnableKeyRotation: true, RotationPeriodInDays: 90 }
      );
      expect(sent(UpdateKeyDescriptionCommand)[0]!.input.Description).toBe('v2');
      expect(sent(EnableKeyRotationCommand).map((c) => c.input.RotationPeriodInDays)).toEqual([
        365,
      ]);
    });

    it('a period CHANGE with rotation still on is sent', async () => {
      await deployUpdate(
        { EnableKeyRotation: true, RotationPeriodInDays: 180 },
        { EnableKeyRotation: true, RotationPeriodInDays: 90 }
      );
      expect(sent(EnableKeyRotationCommand).map((c) => c.input.RotationPeriodInDays)).toEqual([
        180,
      ]);
    });

    it('an unchanged or never-declared period sends no rotation call', async () => {
      await deployUpdate(
        { Description: 'v2', EnableKeyRotation: true, RotationPeriodInDays: 90 },
        { Description: 'v1', EnableKeyRotation: true, RotationPeriodInDays: 90 }
      );
      await deployUpdate(
        { Description: 'v3', EnableKeyRotation: true },
        { Description: 'v2', EnableKeyRotation: true }
      );
      expect(sent(EnableKeyRotationCommand)).toHaveLength(0);
      expect(sent(DisableKeyRotationCommand)).toHaveLength(0);
    });

    it('a period removed together with EnableKeyRotation only turns rotation off', async () => {
      await deployUpdate({}, { EnableKeyRotation: true, RotationPeriodInDays: 90 });
      expect(names()).toEqual(['DisableKeyRotationCommand']);
    });

    it('enables the key BEFORE the rotation call when the same update enables it', async () => {
      await deployUpdate(
        { EnableKeyRotation: true },
        { Enabled: false, EnableKeyRotation: true, RotationPeriodInDays: 90 }
      );
      expect(names()).toEqual(['EnableKeyCommand', 'EnableKeyRotationCommand']);
      expect(sent(EnableKeyRotationCommand)[0]!.input.RotationPeriodInDays).toBe(365);
    });

    it("a string 'false' EnableKeyRotation never turns rotation on when the period is removed", async () => {
      await deployUpdate(
        { EnableKeyRotation: 'false' },
        { EnableKeyRotation: 'false', RotationPeriodInDays: 90 }
      );
      expect(sent(EnableKeyRotationCommand)).toHaveLength(0);
      expect(sent(DisableKeyRotationCommand)).toHaveLength(0);
    });

    it("a string 'true' EnableKeyRotation resets a removed period like a boolean", async () => {
      await deployUpdate(
        { EnableKeyRotation: 'true' },
        { EnableKeyRotation: 'true', RotationPeriodInDays: 90 }
      );
      expect(sent(EnableKeyRotationCommand).map((c) => c.input.RotationPeriodInDays)).toEqual([
        365,
      ]);
    });

    it("a string 'false' Enabled change disables the key, and an unchanged one sends nothing", async () => {
      await deployUpdate({ Enabled: 'false' }, { Enabled: true });
      expect(names()).toEqual(['DisableKeyCommand']);
      mockSend.mockClear();
      await deployUpdate({ Enabled: 'false', Description: 'v2' }, { Enabled: false });
      expect(sent(EnableKeyCommand)).toHaveLength(0);
      expect(sent(DisableKeyCommand)).toHaveLength(0);
    });

    it('disables the key AFTER the rotation call when the same update disables it', async () => {
      await deployUpdate(
        { Enabled: false, EnableKeyRotation: true },
        { EnableKeyRotation: true, RotationPeriodInDays: 90 }
      );
      expect(names()).toEqual(['EnableKeyRotationCommand', 'DisableKeyCommand']);
    });

    // CloudFormation's order (issue #1160, issuecomment-6287991009): the key
    // is disabled after the rotation call and BEFORE tags and the key policy,
    // so a policy denying kms:DisableKey still deploys.
    it('pins the CloudFormation order: rotation, DisableKey, tags, then the key policy', async () => {
      await deployUpdate(
        {
          Description: 'v2',
          Enabled: false,
          EnableKeyRotation: true,
          RotationPeriodInDays: 180,
          KeyPolicy: { ...CUSTOM_POLICY, Id: 'next' },
          Tags: [{ Key: 'k', Value: 'v' }],
        },
        {
          Description: 'v1',
          EnableKeyRotation: true,
          RotationPeriodInDays: 90,
          KeyPolicy: CUSTOM_POLICY,
        }
      );
      expect(names()).toEqual([
        'UpdateKeyDescriptionCommand',
        'EnableKeyRotationCommand',
        'DisableKeyCommand',
        'TagResourceCommand',
        'PutKeyPolicyCommand',
      ]);
    });

    it('pins EnableKey before the rotation call and the key policy last', async () => {
      await deployUpdate(
        { EnableKeyRotation: true, RotationPeriodInDays: 180, KeyPolicy: { ...CUSTOM_POLICY, Id: 'n' } },
        { Enabled: false, EnableKeyRotation: true, RotationPeriodInDays: 90, KeyPolicy: CUSTOM_POLICY }
      );
      expect(names()).toEqual(['EnableKeyCommand', 'EnableKeyRotationCommand', 'PutKeyPolicyCommand']);
    });

    it('refuses a rotation change on a disabled key with what the template must change', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof EnableKeyRotationCommand
          ? Promise.reject(
              new DisabledException({
                message: `arn:aws:kms:us-east-1:${ACCOUNT}:key/${KEY_ID} is disabled.`,
                $metadata: {},
              })
            )
          : Promise.resolve({})
      );
      const err = await deployUpdate(
        { Enabled: false, EnableKeyRotation: true, RotationPeriodInDays: 180 },
        { Enabled: false, EnableKeyRotation: true, RotationPeriodInDays: 90 }
      ).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toBe(
        'Failed to update KMS Key Key: the key is currently disabled in AWS, and KMS refuses a key rotation change on a disabled key (CloudFormation fails this update too). Enable the key first (declare Enabled: true, or enable it in AWS), or drop the rotation change from this update.'
      );
      expect(msg).not.toContain(KEY_ID);
      expect(msg).not.toContain(ACCOUNT);
      expect(isMarkedNonRetryable(err)).toBe(true);
      expect(names()).toEqual(['EnableKeyRotationCommand']);
    });

    it('right after its own EnableKey, a DisabledException stays the ordinary, retryable wrap', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof EnableKeyRotationCommand
          ? Promise.reject(new DisabledException({ message: 'is disabled.', $metadata: {} }))
          : Promise.resolve({})
      );
      const err = await deployUpdate(
        { EnableKeyRotation: true, RotationPeriodInDays: 180 },
        { Enabled: false, EnableKeyRotation: true, RotationPeriodInDays: 90 }
      ).then(
        () => undefined,
        (e: unknown) => e
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).not.toContain('currently disabled in AWS');
      expect((err as Error).message).toMatch(/^Failed to update KMS Key Key: /);
      expect(isMarkedNonRetryable(err)).toBe(false);
      expect(names()).toEqual(['EnableKeyCommand', 'EnableKeyRotationCommand']);
    });

    it('wraps any other rotation failure as before', async () => {
      mockSend.mockImplementation((command: unknown) =>
        command instanceof DisableKeyRotationCommand
          ? Promise.reject(new Error('socket hang up'))
          : Promise.resolve({})
      );
      await expect(deployUpdate({}, { EnableKeyRotation: true })).rejects.toThrow(
        'Failed to update KMS Key Key: socket hang up'
      );
    });

    it('drift --revert sends no rotation call for a period the desired bag does not carry', async () => {
      await provider.update(
        'Key',
        KEY_ID,
        TYPE,
        { EnableKeyRotation: true },
        { EnableKeyRotation: true, RotationPeriodInDays: 365 },
        { removedProperties: new Set<string>(), desiredFromAwsReadback: true }
      );
      expect(sent(EnableKeyRotationCommand)).toHaveLength(0);
      expect(sent(DisableKeyRotationCommand)).toHaveLength(0);
    });
  });

  describe('KeyPolicy', () => {
    function defaultPolicyFor(partition: string): unknown {
      return {
        Version: '2012-10-17',
        Id: 'key-default-1',
        Statement: [
          {
            Sid: 'Enable IAM User Permissions',
            Effect: 'Allow',
            Principal: { AWS: `arn:${partition}:iam::${ACCOUNT}:root` },
            Action: 'kms:*',
            Resource: '*',
          },
        ],
      };
    }

    it.each([
      ['a direct call', false],
      ['the deploy caller', true],
    ])('a removed KeyPolicy is reset to the KMS default key policy (%s)', async (_l, viaCaller) => {
      const previous = { Description: 'd', KeyPolicy: CUSTOM_POLICY };
      const desired = { Description: 'd' };
      if (viaCaller) await deployUpdate(desired, previous);
      else await provider.update('Key', KEY_ID, TYPE, desired, previous);

      const puts = sent(PutKeyPolicyCommand);
      expect(puts).toHaveLength(1);
      expect(puts[0]!.input.KeyId).toBe(KEY_ID);
      expect(puts[0]!.input.PolicyName).toBe('default');
      expect(JSON.parse(puts[0]!.input.Policy!)).toEqual(defaultPolicyFor('aws'));
    });

    it('names the partition and account from the key ARN', async () => {
      keyArn = `arn:aws-cn:kms:cn-north-1:${ACCOUNT}:key/${KEY_ID}`;
      await deployUpdate({ Description: 'v2' }, { Description: 'v1', KeyPolicy: CUSTOM_POLICY });
      const put = sent(PutKeyPolicyCommand)[0]!;
      expect(JSON.parse(put.input.Policy!)).toEqual(defaultPolicyFor('aws-cn'));
      expect(sent(UpdateKeyDescriptionCommand)[0]!.input.Description).toBe('v2');
    });

    it('refuses without a PutKeyPolicy when DescribeKey returns no ARN', async () => {
      keyArn = undefined;
      await expect(
        deployUpdate({ Description: 'd' }, { Description: 'd', KeyPolicy: CUSTOM_POLICY })
      ).rejects.toThrow(/Failed to update KMS Key Key/);
      expect(sent(PutKeyPolicyCommand)).toHaveLength(0);
    });

    it('drift --revert (no removed property) never resets an absent desired KeyPolicy', async () => {
      await provider.update(
        'Key',
        KEY_ID,
        TYPE,
        { Description: 'd' },
        { Description: 'd', KeyPolicy: CUSTOM_POLICY },
        { removedProperties: new Set<string>() }
      );
      expect(sent(PutKeyPolicyCommand)).toHaveLength(0);
      expect(sent(DescribeKeyCommand)).toHaveLength(0);
    });

    it('a KeyPolicy declared on neither side sends nothing', async () => {
      await deployUpdate({ Description: 'v2' }, { Description: 'v1' });
      expect(sent(PutKeyPolicyCommand)).toHaveLength(0);
      expect(sent(DescribeKeyCommand)).toHaveLength(0);
    });

    it('a changed KeyPolicy is put as declared', async () => {
      const next = { ...CUSTOM_POLICY, Id: 'next' };
      await deployUpdate({ KeyPolicy: next }, { KeyPolicy: CUSTOM_POLICY });
      const puts = sent(PutKeyPolicyCommand);
      expect(puts).toHaveLength(1);
      expect(JSON.parse(puts[0]!.input.Policy!)).toEqual(next);
    });
  });

  describe('create with string-typed booleans', () => {
    beforeEach(() => {
      mockSend.mockImplementation((command: unknown) => {
        if (command instanceof CreateKeyCommand) {
          return Promise.resolve({ KeyMetadata: { KeyId: KEY_ID, Arn: keyArn } });
        }
        return Promise.resolve({});
      });
    });

    it("'false' turns neither rotation on nor the key off; 'true' / 'false' act as booleans", async () => {
      await provider.create('Key', TYPE, { EnableKeyRotation: 'false', Enabled: 'true' });
      expect(names()).toEqual(['CreateKeyCommand']);
      mockSend.mockClear();
      await provider.create('Key', TYPE, { EnableKeyRotation: 'true', Enabled: 'false' });
      expect(names()).toEqual(['CreateKeyCommand', 'EnableKeyRotationCommand', 'DisableKeyCommand']);
    });
  });

  describe('properties whose existing reset already matches CloudFormation', () => {
    it('a removed Description is cleared', async () => {
      await deployUpdate({}, { Description: 'd' });
      expect(sent(UpdateKeyDescriptionCommand).map((c) => c.input)).toEqual([
        { KeyId: KEY_ID, Description: '' },
      ]);
    });

    it('a removed `Enabled: false` enables the key', async () => {
      await deployUpdate({}, { Enabled: false });
      expect(names()).toEqual(['EnableKeyCommand']);
    });

    it('a removed `EnableKeyRotation: true` turns rotation off', async () => {
      await deployUpdate({}, { EnableKeyRotation: true });
      expect(names()).toEqual(['DisableKeyRotationCommand']);
      expect(sent(DisableKeyCommand)).toHaveLength(0);
      expect(sent(EnableKeyCommand)).toHaveLength(0);
    });
  });
});
