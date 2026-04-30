import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-kms', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-kms')>();
  return {
    ...actual,
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

import { KMSProvider } from '../../../../src/provisioning/providers/kms-provider.js';
import {
  CreateKeyCommand,
  EnableKeyRotationCommand,
  DisableKeyRotationCommand,
  UpdateKeyDescriptionCommand,
  PutKeyPolicyCommand,
  ScheduleKeyDeletionCommand,
  CreateAliasCommand,
  UpdateAliasCommand,
  DeleteAliasCommand,
  NotFoundException,
} from '@aws-sdk/client-kms';

describe('KMSProvider', () => {
  let provider: KMSProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new KMSProvider();
  });

  // ─── AWS::KMS::Key ──────────────────────────────────────────────────

  describe('Key', () => {
    describe('create', () => {
      it('should create a KMS key and return keyId and Arn', async () => {
        mockSend.mockResolvedValue({
          KeyMetadata: { KeyId: 'key-123', Arn: 'arn:aws:kms:us-east-1:123456789012:key/key-123' },
        });

        const result = await provider.create('MyKey', 'AWS::KMS::Key', {
          Description: 'Test key',
        });

        expect(result.physicalId).toBe('key-123');
        expect(result.attributes).toEqual({
          Arn: 'arn:aws:kms:us-east-1:123456789012:key/key-123',
          KeyId: 'key-123',
        });
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateKeyCommand);
      });

      it('should enable key rotation when EnableKeyRotation is true', async () => {
        mockSend.mockResolvedValue({
          KeyMetadata: { KeyId: 'key-123', Arn: 'arn:aws:kms:us-east-1:123456789012:key/key-123' },
        });

        await provider.create('MyKey', 'AWS::KMS::Key', {
          Description: 'Test key',
          EnableKeyRotation: true,
        });

        expect(mockSend).toHaveBeenCalledTimes(2);
        expect(mockSend.mock.calls[0][0]).toBeInstanceOf(CreateKeyCommand);
        expect(mockSend.mock.calls[1][0]).toBeInstanceOf(EnableKeyRotationCommand);
        expect(mockSend.mock.calls[1][0].input).toEqual({ KeyId: 'key-123' });
      });

      it('should JSON.stringify KeyPolicy when it is an object', async () => {
        mockSend.mockResolvedValue({
          KeyMetadata: { KeyId: 'key-123', Arn: 'arn:aws:kms:us-east-1:123456789012:key/key-123' },
        });

        const keyPolicy = {
          Version: '2012-10-17',
          Statement: [{ Effect: 'Allow', Principal: '*', Action: 'kms:*', Resource: '*' }],
        };

        await provider.create('MyKey', 'AWS::KMS::Key', {
          KeyPolicy: keyPolicy,
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(CreateKeyCommand);
        expect(command.input.Policy).toBe(JSON.stringify(keyPolicy));
      });
    });

    describe('update', () => {
      it('should update description when changed', async () => {
        mockSend.mockResolvedValue({});

        await provider.update('MyKey', 'key-123', 'AWS::KMS::Key', {
          Description: 'New description',
        }, {
          Description: 'Old description',
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(UpdateKeyDescriptionCommand);
        expect(command.input).toEqual({
          KeyId: 'key-123',
          Description: 'New description',
        });
      });

      it('should enable key rotation when changed to true', async () => {
        mockSend.mockResolvedValue({});

        await provider.update('MyKey', 'key-123', 'AWS::KMS::Key', {
          EnableKeyRotation: true,
        }, {
          EnableKeyRotation: false,
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(EnableKeyRotationCommand);
        expect(command.input).toEqual({ KeyId: 'key-123' });
      });

      it('should disable key rotation when changed to false', async () => {
        mockSend.mockResolvedValue({});

        await provider.update('MyKey', 'key-123', 'AWS::KMS::Key', {
          EnableKeyRotation: false,
        }, {
          EnableKeyRotation: true,
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(DisableKeyRotationCommand);
        expect(command.input).toEqual({ KeyId: 'key-123' });
      });

      it('should update key policy when changed', async () => {
        mockSend.mockResolvedValue({});

        const newPolicy = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: '*', Action: 'kms:*', Resource: '*' }] };
        const oldPolicy = { Version: '2012-10-17', Statement: [{ Effect: 'Deny', Principal: '*', Action: 'kms:*', Resource: '*' }] };

        await provider.update('MyKey', 'key-123', 'AWS::KMS::Key', {
          KeyPolicy: newPolicy,
        }, {
          KeyPolicy: oldPolicy,
        });

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(PutKeyPolicyCommand);
        expect(command.input).toEqual({
          KeyId: 'key-123',
          PolicyName: 'default',
          Policy: JSON.stringify(newPolicy),
        });
      });
    });

    describe('delete', () => {
      it('should schedule key deletion with PendingWindowInDays 7', async () => {
        mockSend.mockResolvedValue({});

        await provider.delete('MyKey', 'key-123', 'AWS::KMS::Key');

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(ScheduleKeyDeletionCommand);
        expect(command.input).toEqual({
          KeyId: 'key-123',
          PendingWindowInDays: 7,
        });
      });

      it('should not throw when key is not found', async () => {
        mockSend.mockRejectedValueOnce(
          new NotFoundException({ $metadata: {}, message: 'not found' })
        );

        await expect(
          provider.delete('MyKey', 'key-123', 'AWS::KMS::Key')
        ).resolves.not.toThrow();

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ─── AWS::KMS::Alias ────────────────────────────────────────────────

  describe('Alias', () => {
    describe('create', () => {
      it('should create alias and return aliasName as physicalId', async () => {
        mockSend.mockResolvedValue({});

        const result = await provider.create('MyAlias', 'AWS::KMS::Alias', {
          AliasName: 'alias/my-key',
          TargetKeyId: 'key-123',
        });

        expect(result.physicalId).toBe('alias/my-key');
        expect(result.attributes).toEqual({});
        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(CreateAliasCommand);
        expect(command.input).toEqual({
          AliasName: 'alias/my-key',
          TargetKeyId: 'key-123',
        });
      });
    });

    describe('update', () => {
      it('should update alias target key', async () => {
        mockSend.mockResolvedValue({});

        const result = await provider.update('MyAlias', 'alias/my-key', 'AWS::KMS::Alias', {
          AliasName: 'alias/my-key',
          TargetKeyId: 'key-456',
        }, {
          AliasName: 'alias/my-key',
          TargetKeyId: 'key-123',
        });

        expect(result.physicalId).toBe('alias/my-key');
        expect(result.wasReplaced).toBe(false);
        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(UpdateAliasCommand);
        expect(command.input).toEqual({
          AliasName: 'alias/my-key',
          TargetKeyId: 'key-456',
        });
      });
    });

    describe('delete', () => {
      it('should delete alias', async () => {
        mockSend.mockResolvedValue({});

        await provider.delete('MyAlias', 'alias/my-key', 'AWS::KMS::Alias');

        expect(mockSend).toHaveBeenCalledTimes(1);
        const command = mockSend.mock.calls[0][0];
        expect(command).toBeInstanceOf(DeleteAliasCommand);
        expect(command.input).toEqual({
          AliasName: 'alias/my-key',
        });
      });

      it('should not throw when alias is not found', async () => {
        mockSend.mockRejectedValueOnce(
          new NotFoundException({ $metadata: {}, message: 'not found' })
        );

        await expect(
          provider.delete('MyAlias', 'alias/my-key', 'AWS::KMS::Alias')
        ).resolves.not.toThrow();

        expect(mockSend).toHaveBeenCalledTimes(1);
      });
    });
  });
});
