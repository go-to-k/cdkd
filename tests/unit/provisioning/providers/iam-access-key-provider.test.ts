import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateAccessKeyCommand,
  UpdateAccessKeyCommand,
  DeleteAccessKeyCommand,
  ListAccessKeysCommand,
  GetAccessKeyLastUsedCommand,
  NoSuchEntityException,
} from '@aws-sdk/client-iam';

const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    iam: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../../src/utils/logger.js', () => {
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

import { IAMAccessKeyProvider } from '../../../../src/provisioning/providers/iam-access-key-provider.js';
import { findSilentDropProperties } from '../../../../src/provisioning/property-coverage.js';
import { ProvisioningError } from '../../../../src/utils/error-handler.js';

const TYPE = 'AWS::IAM::AccessKey';
const KEY_ID = 'AKIAIOSFODNN7EXAMPLE';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

function notFound(): NoSuchEntityException {
  return new NoSuchEntityException({ message: 'not found', $metadata: {} });
}

/**
 * The empty `ListAccessKeys` page (issue #2039).
 *
 * `create()` now reads the user's existing keys BEFORE issuing
 * `CreateAccessKey`, and reads them again from the failure path to reconcile an
 * orphan its own attempt minted. Both are real SDK calls, so every positionally
 * primed queue below has to account for them or each `*Once` serves the wrong
 * call -- which is exactly the shift `.claude/rules/testing.md` documents.
 */
const NO_EXISTING_KEYS = { AccessKeyMetadata: [] };

function callsOf(commandClass: unknown): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof (commandClass as new (...args: never[]) => object))
    .map((c) => c[0].input as Record<string, unknown>);
}

describe('IAMAccessKeyProvider', () => {
  let provider: IAMAccessKeyProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new IAMAccessKeyProvider();
  });

  it('opts out of CC API fallback (NON_PROVISIONABLE type)', () => {
    expect(provider.disableCcApiFallback).toBe(true);
  });

  it('keeps Serial out of the silent-drop set (a drop would pre-flight HARD-REJECT serial users)', () => {
    // On a NON_PROVISIONABLE type with disableCcApiFallback, every silent-drop
    // property trips the #614 auto-route viability guard and rejects the
    // template pre-flight. Serial's whole CFn semantic (change -> new key) is
    // the registry-schema createOnly replacement classification, so it MUST
    // stay declared handled. A future "more honest" move of Serial to
    // unhandledByDesign would regenerate cleanly and stay green everywhere
    // except here.
    expect(provider.handledProperties.get(TYPE)?.has('Serial')).toBe(true);
    expect(
      findSilentDropProperties(TYPE, { UserName: 'u', Serial: 1, Status: 'Active' })
    ).toEqual([]);
  });

  describe('create', () => {
    it('creates the key and caches SecretAccessKey + Id as attributes', async () => {
      mockSend.mockResolvedValueOnce(NO_EXISTING_KEYS).mockResolvedValueOnce({
        AccessKey: { AccessKeyId: KEY_ID, SecretAccessKey: SECRET, Status: 'Active' },
      });

      const result = await provider.create('CiKey', TYPE, { UserName: 'ci-user' });

      const creates = callsOf(CreateAccessKeyCommand);
      expect(creates).toHaveLength(1);
      expect(creates[0]!['UserName']).toBe('ci-user');
      expect(result.physicalId).toBe(KEY_ID);
      expect(result.attributes).toEqual({ SecretAccessKey: SECRET, Id: KEY_ID });
      // Active status needs no follow-up UpdateAccessKey
      expect(callsOf(UpdateAccessKeyCommand)).toHaveLength(0);
    });

    it('applies Status: Inactive with a follow-up UpdateAccessKey', async () => {
      mockSend
        .mockResolvedValueOnce(NO_EXISTING_KEYS)
        .mockResolvedValueOnce({ AccessKey: { AccessKeyId: KEY_ID, SecretAccessKey: SECRET } })
        .mockResolvedValueOnce({});

      const result = await provider.create('CiKey', TYPE, {
        UserName: 'ci-user',
        Status: 'Inactive',
      });

      const updates = callsOf(UpdateAccessKeyCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        UserName: 'ci-user',
        AccessKeyId: KEY_ID,
        Status: 'Inactive',
      });
      expect(result.physicalId).toBe(KEY_ID);
    });

    it('deletes the just-created key when the Inactive status wiring fails', async () => {
      mockSend
        .mockResolvedValueOnce(NO_EXISTING_KEYS)
        .mockResolvedValueOnce({ AccessKey: { AccessKeyId: KEY_ID, SecretAccessKey: SECRET } })
        .mockRejectedValueOnce(new Error('throttled'))
        .mockResolvedValueOnce({})
        // The reconcile's read: the inner cleanup already deleted the key.
        .mockResolvedValueOnce(NO_EXISTING_KEYS);

      await expect(
        provider.create('CiKey', TYPE, { UserName: 'ci-user', Status: 'Inactive' })
      ).rejects.toThrow(ProvisioningError);

      const deletes = callsOf(DeleteAccessKeyCommand);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toMatchObject({ UserName: 'ci-user', AccessKeyId: KEY_ID });
    });

    it('rejects a missing UserName without calling AWS', async () => {
      await expect(provider.create('CiKey', TYPE, {})).rejects.toThrow(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('wraps SDK errors in ProvisioningError', async () => {
      mockSend
        .mockResolvedValueOnce(NO_EXISTING_KEYS)
        .mockRejectedValueOnce(new Error('LimitExceeded'))
        .mockResolvedValueOnce(NO_EXISTING_KEYS);
      await expect(provider.create('CiKey', TYPE, { UserName: 'ci-user' })).rejects.toThrow(
        ProvisioningError
      );
    });

    it('wraps a create response missing AccessKeyId/SecretAccessKey and cleans up a minted key', async () => {
      mockSend
        .mockResolvedValueOnce(NO_EXISTING_KEYS)
        .mockResolvedValueOnce({ AccessKey: { AccessKeyId: KEY_ID } })
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(NO_EXISTING_KEYS);
      await expect(provider.create('CiKey', TYPE, { UserName: 'ci-user' })).rejects.toThrow(
        /no AccessKeyId\/SecretAccessKey/
      );
      // A key WAS minted (AccessKeyId present) — it must be deleted so the
      // retry / next deploy does not hit the 2-keys-per-user quota.
      const deletes = callsOf(DeleteAccessKeyCommand);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toMatchObject({ UserName: 'ci-user', AccessKeyId: KEY_ID });
    });

    it('skips cleanup when the create response carries no AccessKeyId at all', async () => {
      mockSend
        .mockResolvedValueOnce(NO_EXISTING_KEYS)
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce(NO_EXISTING_KEYS);
      await expect(provider.create('CiKey', TYPE, { UserName: 'ci-user' })).rejects.toThrow(
        /no AccessKeyId\/SecretAccessKey/
      );
      expect(callsOf(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    it('propagates the ORIGINAL status-wiring error even when the compensating delete also fails', async () => {
      mockSend
        .mockResolvedValueOnce(NO_EXISTING_KEYS)
        .mockResolvedValueOnce({ AccessKey: { AccessKeyId: KEY_ID, SecretAccessKey: SECRET } })
        .mockRejectedValueOnce(new Error('status wiring failed'))
        .mockRejectedValueOnce(new Error('cleanup also failed'))
        .mockResolvedValueOnce(NO_EXISTING_KEYS);

      await expect(
        provider.create('CiKey', TYPE, { UserName: 'ci-user', Status: 'Inactive' })
      ).rejects.toThrow(/status wiring failed/);
    });
  });

  describe('update', () => {
    it('sends the desired status and omits attributes so the cached secret survives', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.update(
        'CiKey',
        KEY_ID,
        TYPE,
        { UserName: 'ci-user', Status: 'Inactive' },
        { UserName: 'ci-user', Status: 'Active' }
      );

      const updates = callsOf(UpdateAccessKeyCommand);
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        UserName: 'ci-user',
        AccessKeyId: KEY_ID,
        Status: 'Inactive',
      });
      expect(result).toEqual({ physicalId: KEY_ID, wasReplaced: false });
      expect('attributes' in result).toBe(false);
    });

    it('resets a REMOVED Status to the CFn default Active', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.update(
        'CiKey',
        KEY_ID,
        TYPE,
        { UserName: 'ci-user' },
        { UserName: 'ci-user', Status: 'Inactive' }
      );

      expect(callsOf(UpdateAccessKeyCommand)[0]!['Status']).toBe('Active');
    });

    it('wraps SDK errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('boom'));
      await expect(
        provider.update('CiKey', KEY_ID, TYPE, { UserName: 'ci-user' }, { UserName: 'ci-user' })
      ).rejects.toThrow(ProvisioningError);
    });
  });

  describe('delete', () => {
    it('deletes with the state-recorded UserName', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete('CiKey', KEY_ID, TYPE, { UserName: 'ci-user' });

      const deletes = callsOf(DeleteAccessKeyCommand);
      expect(deletes).toHaveLength(1);
      expect(deletes[0]).toMatchObject({ UserName: 'ci-user', AccessKeyId: KEY_ID });
      expect(callsOf(GetAccessKeyLastUsedCommand)).toHaveLength(0);
    });

    it('recovers UserName via GetAccessKeyLastUsed when properties are absent', async () => {
      mockSend.mockResolvedValueOnce({ UserName: 'recovered-user' }).mockResolvedValueOnce({});

      await provider.delete('CiKey', KEY_ID, TYPE);

      expect(callsOf(GetAccessKeyLastUsedCommand)[0]!['AccessKeyId']).toBe(KEY_ID);
      expect(callsOf(DeleteAccessKeyCommand)[0]).toMatchObject({
        UserName: 'recovered-user',
        AccessKeyId: KEY_ID,
      });
    });

    it('never sends DeleteAccessKey without an owning UserName (would target the caller identity)', async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(provider.delete('CiKey', KEY_ID, TYPE)).rejects.toThrow(
        /cannot resolve the owning user/
      );
      expect(callsOf(DeleteAccessKeyCommand)).toHaveLength(0);
    });

    it('treats NoSuchEntity as idempotent success', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete('CiKey', KEY_ID, TYPE, { UserName: 'ci-user' }, { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
    });

    it('rejects NoSuchEntity when the client region does not match the state-recorded region', async () => {
      mockSend.mockRejectedValueOnce(notFound());

      await expect(
        provider.delete(
          'CiKey',
          KEY_ID,
          TYPE,
          { UserName: 'ci-user' },
          { expectedRegion: 'eu-west-1' }
        )
      ).rejects.toThrow(/region/i);
    });

    it('wraps other SDK errors in ProvisioningError', async () => {
      mockSend.mockRejectedValueOnce(new Error('DeleteConflict'));
      await expect(provider.delete('CiKey', KEY_ID, TYPE, { UserName: 'ci-user' })).rejects.toThrow(
        ProvisioningError
      );
    });
  });

  describe('getAttribute', () => {
    it('returns the physical id for Id', async () => {
      await expect(provider.getAttribute(KEY_ID, TYPE, 'Id')).resolves.toBe(KEY_ID);
    });

    it('fails loudly for SecretAccessKey (create-time-only, never readable)', async () => {
      await expect(provider.getAttribute(KEY_ID, TYPE, 'SecretAccessKey')).rejects.toThrow(
        /cannot be read back/
      );
    });

    it('rejects unknown attributes', async () => {
      await expect(provider.getAttribute(KEY_ID, TYPE, 'Nope')).rejects.toThrow(ProvisioningError);
    });
  });

  describe('readCurrentState', () => {
    it('resolves the owning user and returns UserName + Status', async () => {
      mockSend
        .mockResolvedValueOnce({ UserName: 'ci-user' })
        .mockResolvedValueOnce({
          AccessKeyMetadata: [
            { AccessKeyId: 'AKIAOTHER', Status: 'Active' },
            { AccessKeyId: KEY_ID, Status: 'Inactive' },
          ],
          IsTruncated: false,
        });

      await expect(provider.readCurrentState(KEY_ID, 'CiKey', TYPE)).resolves.toEqual({
        UserName: 'ci-user',
        Status: 'Inactive',
      });
    });

    it('follows ListAccessKeys pagination', async () => {
      mockSend
        .mockResolvedValueOnce({ UserName: 'ci-user' })
        .mockResolvedValueOnce({
          AccessKeyMetadata: [{ AccessKeyId: 'AKIAOTHER', Status: 'Active' }],
          IsTruncated: true,
          Marker: 'page2',
        })
        .mockResolvedValueOnce({
          AccessKeyMetadata: [{ AccessKeyId: KEY_ID, Status: 'Active' }],
          IsTruncated: false,
        });

      await expect(provider.readCurrentState(KEY_ID, 'CiKey', TYPE)).resolves.toEqual({
        UserName: 'ci-user',
        Status: 'Active',
      });
      expect(callsOf(ListAccessKeysCommand)[1]!['Marker']).toBe('page2');
    });

    it('returns undefined when the key is gone', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(provider.readCurrentState(KEY_ID, 'CiKey', TYPE)).resolves.toBeUndefined();
    });

    it('returns undefined when the key is not in the user listing', async () => {
      mockSend
        .mockResolvedValueOnce({ UserName: 'ci-user' })
        .mockResolvedValueOnce({ AccessKeyMetadata: [], IsTruncated: false });
      await expect(provider.readCurrentState(KEY_ID, 'CiKey', TYPE)).resolves.toBeUndefined();
    });

    it('returns undefined when GetAccessKeyLastUsed carries no UserName', async () => {
      mockSend.mockResolvedValueOnce({});
      await expect(provider.readCurrentState(KEY_ID, 'CiKey', TYPE)).resolves.toBeUndefined();
      expect(callsOf(ListAccessKeysCommand)).toHaveLength(0);
    });

    it('treats NoSuchEntity from ListAccessKeys as gone (user deleted mid-read)', async () => {
      mockSend.mockResolvedValueOnce({ UserName: 'ci-user' }).mockRejectedValueOnce(notFound());
      await expect(provider.readCurrentState(KEY_ID, 'CiKey', TYPE)).resolves.toBeUndefined();
    });
  });

  describe('getDriftUnknownPaths', () => {
    it('declares Serial unreadable (no read API)', () => {
      expect(provider.getDriftUnknownPaths('AWS::IAM::AccessKey')).toEqual(['Serial']);
      expect(provider.getDriftUnknownPaths('AWS::Other::Type')).toEqual([]);
    });
  });

  describe('import', () => {
    it('verifies an explicit override via GetAccessKeyLastUsed', async () => {
      mockSend.mockResolvedValueOnce({ UserName: 'ci-user' });

      await expect(
        provider.import({ logicalId: 'CiKey', resourceType: TYPE, stackName: 'S', region: 'us-east-1', properties: {}, knownPhysicalId: KEY_ID })
      ).resolves.toEqual({ physicalId: KEY_ID, attributes: { Id: KEY_ID } });
      expect(callsOf(GetAccessKeyLastUsedCommand)[0]!['AccessKeyId']).toBe(KEY_ID);
    });

    it('returns null when the override does not exist', async () => {
      mockSend.mockRejectedValueOnce(notFound());
      await expect(
        provider.import({ logicalId: 'CiKey', resourceType: TYPE, stackName: 'S', region: 'us-east-1', properties: {}, knownPhysicalId: KEY_ID })
      ).resolves.toBeNull();
    });

    it('returns null without an explicit override (no auto-lookup exists)', async () => {
      await expect(
        provider.import({ logicalId: 'CiKey', resourceType: TYPE, stackName: 'S', region: 'us-east-1', properties: { UserName: 'u' } })
      ).resolves.toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
