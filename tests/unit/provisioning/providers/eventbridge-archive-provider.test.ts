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

const interrupt = vi.hoisted(() => ({ on: false }));
vi.mock('../../../../src/provisioning/interrupt-watch.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../../../src/provisioning/interrupt-watch.js')
  >();
  return {
    ...actual,
    startInterruptWatch: (what: string) => ({
      isInterrupted: () => interrupt.on,
      onInterrupted: () => new actual.InterruptedWaitError(what),
      dispose: () => undefined,
    }),
  };
});

const warn = vi.fn();
vi.mock('../../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) { return this; }),
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
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';
import { isInterruptedWaitError } from '../../../../src/provisioning/interrupt-watch.js';
import { prepareRemovalForUpdate, removalWarning } from '../../../../src/provisioning/update-removal.js';
import { isMarkedNotGone as isNotGoneError } from '../../../../src/provisioning/not-gone.js';
import { createdBeforeFailure } from '../../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../../src/provisioning/created-resource-sink.js';

const TYPE = 'AWS::Events::Archive';
const BUS_ARN = 'arn:aws:events:us-east-1:123456789012:event-bus/my-bus';
const ARN = (name: string): string => `arn:aws:events:us-east-1:123456789012:archive/${name}`;
/** A second ARN, so a test can tell which response an attribute came from. */
const DESCRIBED_ARN = (name: string): string =>
  `arn:aws:events:us-east-1:123456789012:archive/described-${name}`;
const REGION_REFUSAL = /Refusing to .*eu-west-1/s;

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
    interrupt.on = false;
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
        .mockResolvedValueOnce({ ArchiveArn: DESCRIBED_ARN('arch'), State: 'CREATING' })
        .mockResolvedValueOnce({ ArchiveArn: DESCRIBED_ARN('arch'), State: 'ENABLED' });
      const result = await provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN });
      expect(sentOf(DescribeArchiveCommand)).toHaveLength(2);
      // The ARN of the last read, not the create response's.
      expect(result.attributes).toEqual({ Arn: DESCRIBED_ARN('arch') });
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
      const err = await provider
        .create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      expect(err).toBeInstanceOf(Error);
      expect(err!.message).toMatch(/entered CREATE_FAILED\./);
      // AWS's StateReason never reaches the thrown message (go-to-k/cdkd#2319).
      expect(err!.message).not.toMatch(/kms denied/);
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

    it('refuses a non-string ArchiveName before any call', async () => {
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: { 'Fn::Sub': 'x' }, SourceArn: BUS_ARN })
      ).rejects.toThrow(/ArchiveName of EventBridge archive Arch must be a string/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('fails a wait that runs out, naming the state, and deletes the archive', async () => {
      provider.stateWait = { pollIntervalMs: 1, timeoutMs: 0, sleep: () => Promise.resolve() };
      mockSend
        .mockResolvedValueOnce({ State: 'CREATING' })
        .mockResolvedValueOnce({ State: 'CREATING' })
        .mockResolvedValueOnce({});
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
      ).rejects.toThrow(/still CREATING/);
      expect(sentOf(DeleteArchiveCommand).map((c) => c.input)).toEqual([{ ArchiveName: 'arch' }]);
    });

    it('retires the archive once when a state read fails for good (AccessDenied)', async () => {
      mockSend
        .mockResolvedValueOnce({ State: 'CREATING' })
        .mockRejectedValueOnce(
          Object.assign(new Error('not authorized'), {
            name: 'AccessDeniedException',
            $fault: 'client',
            $metadata: { httpStatusCode: 400 },
          })
        )
        .mockResolvedValueOnce({});
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
      ).rejects.toThrow(/Failed to create EventBridge archive Arch/);
      expect(sentOf(DeleteArchiveCommand).map((c) => c.input)).toEqual([{ ArchiveName: 'arch' }]);
    });

    it('rethrows a throttle that lasts past the deadline, and retires the archive', async () => {
      provider.stateWait = { pollIntervalMs: 1, timeoutMs: 0, sleep: () => Promise.resolve() };
      const throttle = (): Error =>
        Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $metadata: { httpStatusCode: 400 },
        });
      mockSend
        .mockResolvedValueOnce({ State: 'CREATING' })
        .mockRejectedValueOnce(throttle())
        .mockResolvedValueOnce({});
      await expect(
        provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
      ).rejects.toThrow(/ThrottlingException/);
      expect(sentOf(DescribeArchiveCommand)).toHaveLength(1);
      expect(sentOf(DeleteArchiveCommand).map((c) => c.input)).toEqual([{ ArchiveName: 'arch' }]);
    });

    it('an interrupt during the state wait throws the interrupt and deletes nothing', async () => {
      interrupt.on = true;
      mockSend.mockResolvedValueOnce({ State: 'CREATING' }).mockResolvedValueOnce({ State: 'CREATING' });
      const err = await provider
        .create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(err)).toBe(true);
      expect(sentOf(DeleteArchiveCommand)).toHaveLength(0);
    });

    it('an interrupt during the transient-read backoff throws the interrupt and deletes nothing', async () => {
      interrupt.on = true;
      mockSend
        .mockResolvedValueOnce({ State: 'CREATING' })
        .mockRejectedValueOnce(
          Object.assign(new Error('Rate exceeded'), {
            name: 'ThrottlingException',
            $fault: 'client',
            $metadata: { httpStatusCode: 400 },
          })
        );
      const err = await provider
        .create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(err)).toBe(true);
      expect(sentOf(DescribeArchiveCommand)).toHaveLength(1);
      expect(sentOf(DeleteArchiveCommand)).toHaveLength(0);
    });

    it('keeps polling through a throttled state read instead of retiring the archive', async () => {
      mockSend
        .mockResolvedValueOnce({ State: 'CREATING' })
        .mockRejectedValueOnce(
          Object.assign(new Error('Rate exceeded'), {
            name: 'ThrottlingException',
            $fault: 'client',
            $metadata: { httpStatusCode: 400 },
          })
        )
        .mockResolvedValueOnce({ State: 'ENABLED', ArchiveArn: DESCRIBED_ARN('arch') });
      const result = await provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN });
      expect(result.attributes).toEqual({ Arn: DESCRIBED_ARN('arch') });
      expect(sentOf(DeleteArchiveCommand)).toHaveLength(0);
    });

    describe('the created-resource record (go-to-k/cdkd#5511 / #4583)', () => {
      const failingCreate = (cleanup: () => Promise<unknown>) => {
        mockSend
          .mockResolvedValueOnce({ State: 'CREATING' })
          .mockResolvedValueOnce({ State: 'CREATE_FAILED' })
          .mockImplementationOnce(cleanup);
      };
      const run = async (sink: CreatedResourceSink): Promise<unknown> =>
        collectCreatedResources(sink, () =>
          provider.create('Arch', TYPE, { ArchiveName: 'arch', SourceArn: BUS_ARN })
        ).catch((e: unknown) => e);

      it('reports the archive once CreateArchive returns', async () => {
        const sink = new CreatedResourceSink('Arch', TYPE);
        mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
        await run(sink);
        expect(sink.report).toEqual({ physicalId: 'arch' });
      });

      it('retracts the report when the cleanup deleted the archive', async () => {
        const sink = new CreatedResourceSink('Arch', TYPE);
        failingCreate(() => Promise.resolve({}));
        const err = await run(sink);
        expect(sink.report).toBeUndefined();
        expect(createdBeforeFailure(err, 'Arch', TYPE)).toBeUndefined();
      });

      it('retracts the report when the cleanup found the archive already gone', async () => {
        const sink = new CreatedResourceSink('Arch', TYPE);
        failingCreate(() =>
          Promise.reject(new ResourceNotFoundException({ message: 'gone', $metadata: {} }))
        );
        const err = await run(sink);
        expect(sink.report).toBeUndefined();
        expect(createdBeforeFailure(err, 'Arch', TYPE)).toBeUndefined();
      });

      it('names the survivor when the cleanup fails', async () => {
        const sink = new CreatedResourceSink('Arch', TYPE);
        failingCreate(() =>
          Promise.reject(Object.assign(new Error('boom'), { name: 'InternalException' }))
        );
        const err = await run(sink);
        expect(sink.report).toEqual({ physicalId: 'arch' });
        expect(createdBeforeFailure(err, 'Arch', TYPE)).toBe('arch');
      });
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

    it.each([
      ['KmsKeyIdentifier', { KmsKeyIdentifier: 'alias/k' }],
      ['RetentionDays', { RetentionDays: 9 }],
      ['EventPattern content', { EventPattern: { source: ['b'] } }],
    ])('sends UpdateArchive when only %s changes', async (_label, change) => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      await provider.update('Arch', 'arch', TYPE, { ...PREV, ...change }, PREV);
      expect(sentOf(UpdateArchiveCommand)).toHaveLength(1);
    });

    it.each([
      ['RetentionDays spelled as a string', { RetentionDays: '1' }],
      ['an EventPattern with its keys in another order', 'reordered'],
    ])('sends nothing for %s', async (_label, change) => {
      const prev = { ...PREV, EventPattern: { source: ['a'], account: ['1'] } };
      const next =
        change === 'reordered'
          ? { ...prev, EventPattern: { account: ['1'], source: ['a'] } }
          : { ...prev, ...(change as Record<string, unknown>) };
      await provider.update('Arch', 'arch', TYPE, next, prev);
      expect(mockSend).not.toHaveBeenCalled();
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

    it('leaves a removed Description, RetentionDays and KmsKeyIdentifier live, as CloudFormation does', async () => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      await provider.update(
        'Arch',
        'arch',
        TYPE,
        { ArchiveName: 'arch', SourceArn: BUS_ARN, EventPattern: { source: ['a'] } },
        { ...PREV, RetentionDays: 5, KmsKeyIdentifier: 'alias/k' }
      );
      // Measured CFn A/B (go-to-k/cdkd#6578): the removed fields stay live.
      expect(sentOf(UpdateArchiveCommand)[0]!.input).toEqual({
        ArchiveName: 'arch',
        EventPattern: '{"source":["a"]}',
      });
    });

    it('the update caller names a removed Description and the type in its warning', () => {
      const prev = { ...PREV };
      const { Description: _removed, ...desired } = prev;
      const prep = prepareRemovalForUpdate(provider, TYPE, desired, prev);
      expect(prep.unhandled).toEqual(['Description']);
      const line = removalWarning('Arch', TYPE, prep.unhandled);
      expect(line).toContain('Description');
      expect(line).toContain(TYPE);
    });

    it('declares only the create-only keys, so the caller names every other removed key', () => {
      expect([...provider.removalHandledInUpdate.get(TYPE)!]).toEqual(['ArchiveName', 'SourceArn']);
      expect((provider as { removalDefaults?: unknown }).removalDefaults).toBeUndefined();
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

    it('keeps the live retention for a malformed RetentionDays on a drift revert', async () => {
      mockSend.mockResolvedValueOnce({ State: 'ENABLED' });
      await provider.update(
        'Arch',
        'arch',
        TYPE,
        { ...PREV, Description: 'new', RetentionDays: 'x' },
        PREV,
        { desiredFromAwsReadback: true }
      );
      expect(sentOf(UpdateArchiveCommand)[0]!.input.RetentionDays).toBeUndefined();
    });

    it('refuses an update in another region than the record before any call', async () => {
      await expect(
        provider.update('Arch', 'arch', TYPE, { ...PREV, Description: 'new' }, PREV, {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow(REGION_REFUSAL);
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

    it('refuses a delete in another region than the record without sending DeleteArchive', async () => {
      await expect(
        provider.delete('Arch', 'arch', TYPE, undefined, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(REGION_REFUSAL);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('marks an untyped NotFound as not gone', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('no such archive'), { name: 'ArchiveNotFound', $fault: 'client' })
      );
      const err = await provider.delete('Arch', 'arch', TYPE).catch((e: unknown) => e);
      expect(isNotGoneError(err)).toBe(true);
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
      expect(result).toBe(RESOURCE_NOT_FOUND);
    });

    it('keeps an EventPattern that is not JSON as the string AWS returned', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveName: 'arch', EventPattern: 'not-json' });
      const result = (await provider.readCurrentState('arch', 'Arch', TYPE)) as Record<
        string,
        unknown
      >;
      expect(result['EventPattern']).toBe('not-json');
    });

    it('answers no attribute but Arn, without a call', async () => {
      await expect(provider.getAttribute('arch', TYPE, 'Name')).resolves.toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
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
      expect(sentOf(DescribeArchiveCommand)[0]!.input).toEqual({ ArchiveName: 'arch' });
    });

    it('prefers the --resource override over the template ArchiveName', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('override') });
      const result = await provider.import(
        input({
          knownPhysicalId: 'override',
          properties: { ArchiveName: 'named', SourceArn: BUS_ARN },
        })
      );
      expect(result?.physicalId).toBe('override');
      expect(sentOf(DescribeArchiveCommand)[0]!.input).toEqual({ ArchiveName: 'override' });
    });

    it('rethrows any failure but a missing archive', async () => {
      mockSend.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { name: 'AccessDeniedException' })
      );
      await expect(provider.import(input({ knownPhysicalId: 'arch' }))).rejects.toThrow(/denied/);
    });

    it('reads ArchiveName from the template', async () => {
      mockSend.mockResolvedValueOnce({ ArchiveArn: ARN('named') });
      const result = await provider.import(
        input({ properties: { ArchiveName: 'named', SourceArn: BUS_ARN } })
      );
      expect(result?.physicalId).toBe('named');
      expect(sentOf(DescribeArchiveCommand)[0]!.input).toEqual({ ArchiveName: 'named' });
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
