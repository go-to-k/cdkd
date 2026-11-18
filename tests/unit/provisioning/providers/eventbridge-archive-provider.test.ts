import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateArchiveCommand,
  DeleteArchiveCommand,
  DescribeArchiveCommand,
  ResourceNotFoundException,
  UpdateArchiveCommand,
} from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

const warn = vi.fn();
vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
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

import { EventBridgeArchiveProvider } from '../../../../src/provisioning/providers/eventbridge-archive-provider.js';
import { withStackScope, stackInstanceNameSuffix } from '../../../../src/provisioning/resource-name.js';
import { applyDefaultNameForFallback } from '../../../../src/provisioning/resource-name.js';

const TYPE = 'AWS::Events::Archive';
const BUS_ARN = 'arn:aws:events:us-east-1:123456789012:event-bus/my-bus';
const ARN = (name: string): string => `arn:aws:events:us-east-1:123456789012:archive/${name}`;

function sentOf<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0] as unknown).filter((c): c is T => c instanceof ctor);
}

describe('EventBridgeArchiveProvider', () => {
  let provider: EventBridgeArchiveProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new EventBridgeArchiveProvider();
    provider.stateWait = { pollIntervalMs: 1, timeoutMs: 1_000, sleep: () => Promise.resolve() };
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  describe('create', () => {
    it('sends every property, stringifying an object EventPattern, and returns the name and Arn', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'ENABLED' });

      const result = await provider.create('Arch', TYPE, {
        ArchiveName: 'arch',
        SourceArn: BUS_ARN,
        Description: 'd',
        EventPattern: { account: ['123456789012'] },
        RetentionDays: '7',
        KmsKeyIdentifier: 'alias/k',
      });

      const [create] = sentOf(CreateArchiveCommand);
      expect(create!.input).toEqual({
        ArchiveName: 'arch',
        EventSourceArn: BUS_ARN,
        Description: 'd',
        EventPattern: '{"account":["123456789012"]}',
        RetentionDays: 7,
        KmsKeyIdentifier: 'alias/k',
      });
      expect(result).toEqual({ physicalId: 'arch', attributes: { Arn: ARN('arch') } });
      // ENABLED on the create response: no DescribeArchive poll.
      expect(sentOf(DescribeArchiveCommand)).toHaveLength(0);
    });

    it('passes a string EventPattern through as written', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'ENABLED' });
      await provider.create('Arch', TYPE, {
        ArchiveName: 'arch',
        SourceArn: BUS_ARN,
        EventPattern: '{"source":["a"]}',
      });
      expect(sentOf(CreateArchiveCommand)[0]!.input.EventPattern).toBe('{"source":["a"]}');
    });

    it('generates the same name the Cloud Control route fills when ArchiveName is absent', async () => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      const id = 'abcdef0123456789';
      const scope = {
        stackName: 'MyStack',
        stackInstanceId: id,
        nameGenerations: new Map([['Arch', 1]]),
      };
      const result = await withStackScope(scope, () =>
        provider.create('Arch', TYPE, { SourceArn: BUS_ARN })
      );
      const name = sentOf(CreateArchiveCommand)[0]!.input.ArchiveName!;
      expect(name).toBe(`MyStack-Arch-${stackInstanceNameSuffix(id, 'Arch', 1)}`);
      expect(name).toBe(
        withStackScope(scope, () => applyDefaultNameForFallback('Arch', TYPE, {}))['ArchiveName']
      );
      expect(name.length).toBeLessThanOrEqual(48);
      expect(result.physicalId).toBe(name);
    });

    it('caps a generated name at 48 characters', async () => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      await withStackScope(
        {
          stackName: 'AVeryLongStackNameThatGoesOnAndOn',
          stackInstanceId: 'abcdef0123456789',
          nameGenerations: new Map(),
        },
        () => provider.create('AVeryLongArchiveLogicalId1234ABCD', TYPE, { SourceArn: BUS_ARN })
      );
      const name = sentOf(CreateArchiveCommand)[0]!.input.ArchiveName!;
      expect(name.length).toBeLessThanOrEqual(48);
      expect(name).toMatch(/^[.\-_A-Za-z0-9]+$/);
    });

    it('refuses a missing SourceArn before any call', async () => {
      await expect(provider.create('Arch', TYPE, { ArchiveName: 'arch' })).rejects.toThrow(
        /SourceArn is required/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('refuses a RetentionDays that is not an integer >= 0 before any call', async () => {
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'a', SourceArn: BUS_ARN, RetentionDays: -1 })
      ).rejects.toThrow(/RetentionDays of Arch must be an integer >= 0/);
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'a', SourceArn: BUS_ARN, RetentionDays: 'x' })
      ).rejects.toThrow(/RetentionDays/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('waits for ENABLED when the create returns CREATING', async () => {
      mockSend
        .mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'CREATING' })
        .mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'CREATING' })
        .mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'ENABLED' });
      const result = await provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN });
      expect(sentOf(DescribeArchiveCommand)).toHaveLength(2);
      expect(result.attributes).toEqual({ Arn: ARN('arch') });
    });

    it('skips the wait under CDKD_NO_WAIT', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'CREATING' });
      const result = await provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN });
      expect(sentOf(DescribeArchiveCommand)).toHaveLength(0);
      expect(result.attributes).toEqual({ Arn: ARN('arch') });
    });

    it('fails on CREATE_FAILED and deletes the archive it created', async () => {
      mockSend
        .mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'CREATING' })
        .mockResolvedValueOnce({ State: 'CREATE_FAILED', StateReason: 'kms denied' })
        .mockResolvedValueOnce({});
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
      ).rejects.toThrow(/entered CREATE_FAILED: kms denied/);
      expect(sentOf(DeleteArchiveCommand).map((c) => c.input)).toEqual([{ ArchiveName: 'arch' }]);
    });

    it('warns with the manual command when deleting the failed archive fails too', async () => {
      mockSend
        .mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'CREATING' })
        .mockResolvedValueOnce({ State: 'CREATE_FAILED' })
        .mockRejectedValueOnce(Object.assign(new Error('boom'), { name: 'InternalException' }));
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
      ).rejects.toThrow(/CREATE_FAILED/);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('aws events delete-archive --archive-name arch')
      );
    });

    it('a CreateArchive failure deletes nothing', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('Archive arch already exists.'), {
          name: 'ResourceAlreadyExistsException',
          $fault: 'client',
        })
      );
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
      ).rejects.toThrow(/Failed to create EventBridge archive Arch/);
      expect(sentOf(DeleteArchiveCommand)).toHaveLength(0);
    });
  });

  describe('update', () => {
    const PREV = {
      ArchiveName: 'arch',
      SourceArn: BUS_ARN,
      Description: 'old',
      EventPattern: { source: ['a'] },
      RetentionDays: 1,
    };

    it('sends UpdateArchive with the desired values when a mutable property changed', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('arch'), State: 'ENABLED' });
      const result = await provider.update(
        'Arch',
        'arch',
        TYPE,
        { ...PREV, Description: 'new', RetentionDays: 3 },
        PREV
      );
      expect(sentOf(UpdateArchiveCommand)[0]!.input).toEqual({
        ArchiveName: 'arch',
        Description: 'new',
        EventPattern: '{"source":["a"]}',
        RetentionDays: 3,
      });
      expect(result).toEqual({ physicalId: 'arch', wasReplaced: false, attributes: { Arn: ARN('arch') } });
    });

    it('sends nothing when only the EventPattern spelling differs', async () => {
      const result = await provider.update(
        'Arch',
        'arch',
        TYPE,
        { ...PREV, EventPattern: '{"source":["a"]}' },
        PREV
      );
      expect(mockSend).not.toHaveBeenCalled();
      expect(result.wasReplaced).toBe(false);
    });

    it('resets a removed Description, RetentionDays and KmsKeyIdentifier', async () => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      await provider.update(
        'Arch',
        'arch',
        TYPE,
        { ArchiveName: 'arch', SourceArn: BUS_ARN, EventPattern: { source: ['a'] } },
        { ...PREV, RetentionDays: 5, KmsKeyIdentifier: 'alias/k' }
      );
      expect(sentOf(UpdateArchiveCommand)[0]!.input).toEqual({
        ArchiveName: 'arch',
        Description: '',
        EventPattern: '{"source":["a"]}',
        RetentionDays: 0,
        KmsKeyIdentifier: '',
      });
    });

    it('declares the create-only keys as handled, so a removed EventPattern is named by the caller', () => {
      expect([...provider.removalHandledInUpdate.get(TYPE)!]).toEqual(['ArchiveName', 'SourceArn']);
      expect(provider.removalDefaults.get(TYPE)!.has('EventPattern')).toBe(false);
    });

    it('waits for UPDATING to settle and fails on UPDATE_FAILED', async () => {
      mockSend
        .mockResolvedValueOnce({ State: 'UPDATING' })
        .mockResolvedValueOnce({ State: 'UPDATE_FAILED' });
      await expect(
        provider.update('Arch', 'arch', TYPE, { ...PREV, Description: 'new' }, PREV)
      ).rejects.toThrow(/entered UPDATE_FAILED/);
    });

    it('refuses a malformed template RetentionDays before any call', async () => {
      await expect(
        provider.update('Arch', 'arch', TYPE, { ...PREV, RetentionDays: 'x' }, PREV)
      ).rejects.toThrow(/RetentionDays/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('keeps the live retention for a malformed state-borne RetentionDays on a replay', async () => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      await provider.update(
        'Arch',
        'arch',
        TYPE,
        { ...PREV, Description: 'new', RetentionDays: 'x' },
        PREV,
        { replayingState: true }
      );
      expect(sentOf(UpdateArchiveCommand)[0]!.input.RetentionDays).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('keeps its current retention'));
    });

    it('refuses an update in another region than the record before any call', async () => {
      await expect(
        provider.update('Arch', 'arch', TYPE, { ...PREV, Description: 'new' }, PREV, {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('calls DeleteArchive', async () => {
      mockSend.mockResolvedValueOnce({});
      await provider.delete('Arch', 'arch', TYPE);
      expect(sentOf(DeleteArchiveCommand).map((c) => c.input)).toEqual([{ ArchiveName: 'arch' }]);
    });

    it('treats ResourceNotFoundException as already deleted in the expected region', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );
      await expect(
        provider.delete('Arch', 'arch', TYPE, undefined, { expectedRegion: 'us-east-1' })
      ).resolves.toBeUndefined();
    });

    it('refuses the not-found shortcut when the client region differs from the record', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );
      await expect(
        provider.delete('Arch', 'arch', TYPE, undefined, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow();
    });

    it('wraps any other failure', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('nope'), { name: 'InternalException', $fault: 'server' })
      );
      await expect(provider.delete('Arch', 'arch', TYPE)).rejects.toThrow(
        /Failed to delete EventBridge archive Arch/
      );
    });
  });

  describe('getAttribute / readCurrentState', () => {
    it('reads Arn from DescribeArchive', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('arch') });
      await expect(provider.getAttribute('arch', TYPE, 'Arn')).resolves.toBe(ARN('arch'));
    });

    it('reports the archive in CFn shape with the absent-value placeholders', async () => {
      mockSend.mockResolvedValueOnce({
        ArchiveName: 'arch',
        EventSourceArn: BUS_ARN,
        EventPattern: '{"source":["a"]}',
        State: 'ENABLED',
      });
      await expect(provider.readCurrentState('arch', 'Arch', TYPE)).resolves.toEqual({
        ArchiveName: 'arch',
        SourceArn: BUS_ARN,
        Description: '',
        EventPattern: { source: ['a'] },
        RetentionDays: 0,
        KmsKeyIdentifier: '',
      });
    });

    it('reports a gone archive as not found', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );
      const result = await provider.readCurrentState('arch', 'Arch', TYPE);
      expect(typeof result).toBe('symbol');
    });
  });

  describe('import', () => {
    const input = (overrides: Record<string, unknown> = {}) => ({
      logicalId: 'Arch',
      resourceType: TYPE,
      stackName: 'MyStack',
      region: 'us-east-1',
      properties: { SourceArn: BUS_ARN },
      ...overrides,
    });

    it('verifies an explicit name with DescribeArchive', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('arch') });
      await expect(provider.import(input({ knownPhysicalId: 'arch' }))).resolves.toEqual({
        physicalId: 'arch',
        attributes: { Arn: ARN('arch') },
      });
    });

    it('reads ArchiveName from the template', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('named') });
      const result = await provider.import(
        input({ properties: { ArchiveName: 'named', SourceArn: BUS_ARN } })
      );
      expect(result?.physicalId).toBe('named');
    });

    it('returns null for a missing archive', async () => {
      mockSend.mockRejectedValueOnce(
        new ResourceNotFoundException({ message: 'not found', $metadata: {} })
      );
      await expect(provider.import(input({ knownPhysicalId: 'gone' }))).resolves.toBeNull();
    });

    it('returns null without any call when no name is known (archives carry no tags)', async () => {
      await expect(provider.import(input({ cdkPath: 'MyStack/Arch' }))).resolves.toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
