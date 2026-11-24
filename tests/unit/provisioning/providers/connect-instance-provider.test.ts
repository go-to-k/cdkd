import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import {
  CreateInstanceCommand,
  DeleteInstanceCommand,
  DescribeInstanceAttributeCommand,
  DescribeInstanceCommand,
  ListInstanceAttributesCommand,
  ListInstancesCommand,
  InvalidRequestException,
  ResourceNotFoundException,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateInstanceAttributeCommand,
} from '@aws-sdk/client-connect';

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

import {
  CONNECT_INSTANCE_ASYNC_DEFAULTS,
  CONNECT_INSTANCE_ATTRIBUTE_TYPES,
  ConnectInstanceProvider,
} from '../../../../src/provisioning/providers/connect-instance-provider.js';
import { connectInstanceIdOf } from '../../../../src/provisioning/connect-instance-id.js';
import { RESOURCE_NOT_FOUND } from '../../../../src/types/resource.js';
import { createdBeforeFailure } from '../../../../src/provisioning/auxiliary-failure.js';
import { isInterruptedWaitError } from '../../../../src/provisioning/interrupt-watch.js';
import { isMarkedNotGone } from '../../../../src/provisioning/not-gone.js';

const TYPE = 'AWS::Connect::Instance';
const ID = '11111111-2222-3333-4444-555555555555';
const ARN = `arn:aws:connect:us-east-1:123456789012:instance/${ID}`;
const ROLE = 'arn:aws:iam::123456789012:role/aws-service-role/connect.amazonaws.com/AWSServiceRoleForAmazonConnect_x';
const CREATED = new Date('2026-11-24T00:00:00.000Z');

const notFound = (): ResourceNotFoundException =>
  new ResourceNotFoundException({ message: 'not found', $metadata: {} });

const mockSend = vi.fn();

function sentOf<T>(ctor: new (...args: never[]) => T): T[] {
  return mockSend.mock.calls.map((c) => c[0] as unknown).filter((c): c is T => c instanceof ctor);
}

function baseProps(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    IdentityManagementType: 'CONNECT_MANAGED',
    InstanceAlias: 'my-alias',
    Attributes: { InboundCalls: true, OutboundCalls: false, ContactflowLogs: true },
    ...extra,
  };
}

/**
 * Script a create: DescribeInstance answers `statuses` in turn (the last
 * repeats), DescribeInstanceAttribute fails not-found `attrNotFound` times.
 */
function scriptCreate(options: {
  statuses: string[];
  attrNotFound?: number;
  /** ListInstanceAttributes answers this many times before the async defaults read `true`. */
  defaultsPending?: number;
  /** Attribute types a default resets to `true` once ACTIVE is read (a late default). */
  lateDefaults?: string[];
  createdResponse?: { Id?: string; Arn?: string };
}): void {
  let describe = 0;
  let attr = options.attrNotFound ?? 0;
  let pending = options.defaultsPending ?? 0;
  const live = new Map<string, string>();
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof UpdateInstanceAttributeCommand) {
      live.set(String(cmd.input.AttributeType), String(cmd.input.Value));
      return Promise.resolve({});
    }
    if (cmd instanceof ListInstanceAttributesCommand) {
      if (attr > 0) {
        attr--;
        return Promise.reject(notFound());
      }
      const settled = pending-- <= 0;
      return Promise.resolve({
        Attributes: [
          ...CONNECT_INSTANCE_ASYNC_DEFAULTS.filter((t) => !live.has(t)).map((t) => ({
            AttributeType: t,
            Value: String(settled),
          })),
          ...[...live].map(([AttributeType, Value]) => ({ AttributeType, Value })),
        ],
      });
    }
    if (cmd instanceof CreateInstanceCommand) {
      return Promise.resolve(options.createdResponse ?? { Id: ID, Arn: ARN });
    }
    if (cmd instanceof DescribeInstanceCommand) {
      const status = options.statuses[Math.min(describe++, options.statuses.length - 1)];
      if (status === 'ACTIVE') for (const t of options.lateDefaults ?? []) live.set(t, 'true');
      return Promise.resolve({
        Instance: {
          Id: ID,
          Arn: ARN,
          InstanceStatus: status,
          CreatedTime: CREATED,
          ...(status === 'ACTIVE' ? { ServiceRole: ROLE } : {}),
          ...(status === 'CREATION_FAILED' ? { StatusReason: { Message: 'boom' } } : {}),
        },
      });
    }
    if (cmd instanceof DescribeInstanceAttributeCommand) {
      if (attr > 0) {
        attr--;
        return Promise.reject(notFound());
      }
      return Promise.resolve({ Attribute: { AttributeType: 'INBOUND_CALLS', Value: 'true' } });
    }
    return Promise.resolve({});
  });
}

describe('ConnectInstanceProvider', () => {
  let provider: ConnectInstanceProvider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    interrupt.on = false;
    provider = new ConnectInstanceProvider();
    (provider as unknown as { client: unknown }).client = {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    };
    provider.instanceWait = { pollIntervalMs: 0, timeoutMs: 60_000, sleep: () => Promise.resolve() };
    delete process.env['CDKD_NO_WAIT'];
  });

  afterEach(() => {
    delete process.env['CDKD_NO_WAIT'];
  });

  it('maps every CFn Attributes member to its InstanceAttributeType', () => {
    expect(Object.keys(CONNECT_INSTANCE_ATTRIBUTE_TYPES)).toHaveLength(14);
    expect(new Set(Object.values(CONNECT_INSTANCE_ATTRIBUTE_TYPES)).size).toBe(14);
  });

  it('reads the instance id out of the ARN', () => {
    expect(connectInstanceIdOf(ARN)).toBe(ID);
    expect(connectInstanceIdOf(ID)).toBe(ID);
  });

  describe('create', () => {
    it('creates, waits for readiness, applies the other attributes, then waits for ACTIVE', async () => {
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS', 'CREATION_IN_PROGRESS', 'ACTIVE'], attrNotFound: 1 });

      const result = await provider.create('Inst', TYPE, baseProps({ Tags: [{ Key: 'k', Value: 'v' }] }));

      expect(result.physicalId).toBe(ARN);
      expect(result.attributes).toEqual({
        Id: ID,
        Arn: ARN,
        ServiceRole: ROLE,
        CreatedTime: CREATED.toISOString(),
        InstanceStatus: 'ACTIVE',
      });
      const [create] = sentOf(CreateInstanceCommand);
      expect(create?.input).toMatchObject({
        IdentityManagementType: 'CONNECT_MANAGED',
        InstanceAlias: 'my-alias',
        InboundCallsEnabled: true,
        OutboundCallsEnabled: false,
        Tags: { k: 'v' },
      });
      expect(create?.input.ClientToken).toEqual(expect.any(String));
      const updates = sentOf(UpdateInstanceAttributeCommand).map((c) => c.input);
      expect(updates).toEqual([{ InstanceId: ID, AttributeType: 'CONTACTFLOW_LOGS', Value: 'true' }]);
      // The attribute write comes after readiness, before the ACTIVE read.
      const order = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
      expect(order.indexOf('UpdateInstanceAttributeCommand')).toBeGreaterThan(
        order.lastIndexOf('DescribeInstanceAttributeCommand')
      );
    });

    it('writes the attributes only once the instance has set its own defaults', async () => {
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS', 'CREATION_IN_PROGRESS', 'CREATION_IN_PROGRESS', 'ACTIVE'], defaultsPending: 2 });

      await provider.create('Inst', TYPE, baseProps());

      const order = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
      const firstWrite = order.indexOf('UpdateInstanceAttributeCommand');
      // Two unsettled listings, then the settled one, then the write.
      expect(order.slice(0, firstWrite).filter((n) => n === 'ListInstanceAttributesCommand')).toHaveLength(3);
      expect(sentOf(DescribeInstanceAttributeCommand)).toHaveLength(0);
    });

    it('with no attribute to write waits only for readiness, not for the defaults', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS'], defaultsPending: 100 });

      await provider.create('Inst', TYPE, baseProps({ Attributes: { InboundCalls: true, OutboundCalls: true } }));

      expect(sentOf(DescribeInstanceAttributeCommand)).toHaveLength(1);
      expect(sentOf(ListInstanceAttributesCommand)).toHaveLength(0);
    });

    it('writes again, once ACTIVE, an attribute a late default overwrote', async () => {
      scriptCreate({
        statuses: ['CREATION_IN_PROGRESS', 'CREATION_IN_PROGRESS', 'ACTIVE'],
        lateDefaults: ['EARLY_MEDIA', 'CONTACTFLOW_LOGS'],
      });

      await provider.create(
        'Inst',
        TYPE,
        baseProps({ Attributes: { InboundCalls: true, OutboundCalls: true, EarlyMedia: false, ContactflowLogs: true } })
      );

      expect(sentOf(UpdateInstanceAttributeCommand).map((c) => `${c.input.AttributeType}=${c.input.Value}`)).toEqual([
        'EARLY_MEDIA=false',
        'CONTACTFLOW_LOGS=true',
        'EARLY_MEDIA=false',
      ]);
    });

    it('under --no-wait returns once the attributes are applied, without the ACTIVE wait', async () => {
      process.env['CDKD_NO_WAIT'] = 'true';
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS'] });

      const result = await provider.create('Inst', TYPE, baseProps());

      expect(result.physicalId).toBe(ARN);
      expect(result.attributes?.['ServiceRole']).toBeUndefined();
      expect(result.attributes?.['InstanceStatus']).toBeUndefined();
      expect(sentOf(UpdateInstanceAttributeCommand)).toHaveLength(1);
      expect(sentOf(DescribeInstanceCommand)).toHaveLength(1);
    });

    it('CREATION_FAILED fails the create and deletes the instance', async () => {
      scriptCreate({ statuses: ['CREATION_FAILED'] });

      await expect(provider.create('Inst', TYPE, baseProps())).rejects.toThrow(
        /Connect instance Inst entered CREATION_FAILED/
      );
      expect(sentOf(DeleteInstanceCommand).map((c) => c.input)).toEqual([{ InstanceId: ID }]);
    });

    it('waits out an alias a just-deleted instance still holds', async () => {
      scriptCreate({ statuses: ['ACTIVE'] });
      const base = mockSend.getMockImplementation()!;
      let refusals = 2;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateInstanceCommand && refusals-- > 0) {
          return Promise.reject(
            new InvalidRequestException({ message: 'Invalid Input. Instance alias is already used.', $metadata: {} })
          );
        }
        if (cmd instanceof ListInstancesCommand) return Promise.resolve({ InstanceSummaryList: [] });
        return base(cmd);
      });

      expect((await provider.create('Inst', TYPE, baseProps())).physicalId).toBe(ARN);
      const tokens = sentOf(CreateInstanceCommand).map((c) => c.input.ClientToken);
      expect(tokens).toHaveLength(3);
      expect(new Set(tokens).size).toBe(1);
    });

    it('fails at once on an alias a listed instance holds', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateInstanceCommand) {
          return Promise.reject(
            new InvalidRequestException({ message: 'Invalid Input. Instance alias is already used.', $metadata: {} })
          );
        }
        if (cmd instanceof ListInstancesCommand) {
          return Promise.resolve({ InstanceSummaryList: [{ Id: 'other', InstanceAlias: 'my-alias' }] });
        }
        return Promise.resolve({});
      });

      await expect(provider.create('Inst', TYPE, baseProps())).rejects.toThrow(/Failed to create Connect instance Inst/);
      expect(sentOf(CreateInstanceCommand)).toHaveLength(1);
    });

    it("throws the create's own alias refusal when the alias listing fails", async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateInstanceCommand) {
          return Promise.reject(
            new InvalidRequestException({ message: 'Invalid Input. Instance alias is already used.', $metadata: {} })
          );
        }
        if (cmd instanceof ListInstancesCommand) {
          return Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
        }
        return Promise.resolve({});
      });

      await expect(provider.create('Inst', TYPE, baseProps())).rejects.toThrow(/InvalidRequestException/);
      expect(sentOf(CreateInstanceCommand)).toHaveLength(1);
    });

    it('retries the cleanup delete of an instance too young to accept it', async () => {
      scriptCreate({ statuses: ['CREATION_FAILED'] });
      const base = mockSend.getMockImplementation()!;
      let refusals = 2;
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DeleteInstanceCommand && refusals-- > 0 ? Promise.reject(notFound()) : base(cmd)
      );

      const error = await provider.create('Inst', TYPE, baseProps()).catch((e: unknown) => e);
      expect(sentOf(DeleteInstanceCommand)).toHaveLength(3);
      expect(createdBeforeFailure(error, 'Inst', TYPE)).toBeUndefined();
    });

    it("keeps AWS's StatusReason out of the thrown message", async () => {
      scriptCreate({ statuses: ['CREATION_FAILED'] });
      const error = await provider.create('Inst', TYPE, baseProps()).catch((e: unknown) => e);
      expect(String(error)).not.toContain('boom');
    });

    it('retires the ClientToken of an instance its failed create deleted, so a retry creates afresh', async () => {
      scriptCreate({ statuses: ['CREATION_FAILED'] });
      await provider.create('Retry', TYPE, baseProps()).catch(() => undefined);
      await provider.create('Retry', TYPE, baseProps()).catch(() => undefined);
      const [first, second] = sentOf(CreateInstanceCommand).map((c) => c.input.ClientToken);
      expect(first).toEqual(expect.any(String));
      expect(second).not.toBe(first);
    });

    it('a failed cleanup delete names the survivor as created before the failure', async () => {
      scriptCreate({ statuses: ['CREATION_FAILED'] });
      const base = mockSend.getMockImplementation()!;
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DeleteInstanceCommand
          ? Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }))
          : base(cmd)
      );

      const error = await provider.create('Inst', TYPE, baseProps()).catch((e: unknown) => e);
      expect(createdBeforeFailure(error, 'Inst', TYPE)).toBe(ARN);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('aws connect delete-instance'));
    });

    it('an interrupted wait is rethrown without deleting the instance', async () => {
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS'], attrNotFound: 100 });
      interrupt.on = true;

      const error = await provider.create('Inst', TYPE, baseProps()).catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(sentOf(DeleteInstanceCommand)).toHaveLength(0);
    });

    it('a readiness wait that runs out fails the create and deletes the instance', async () => {
      // Readiness never comes (status reads, the attribute stays 404) and the
      // deadline is now: the 404 itself ends the wait.
      provider.instanceWait = { pollIntervalMs: 0, timeoutMs: 0, sleep: () => Promise.resolve() };
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS'], attrNotFound: 100 });

      await expect(provider.create('Inst', TYPE, baseProps())).rejects.toThrow(
        /Failed to create Connect instance Inst/
      );
      expect(sentOf(DeleteInstanceCommand)).toHaveLength(1);
    });

    it('an ACTIVE wait that runs out fails the create with the status it was left in', async () => {
      let now = 1_000_000;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
      provider.instanceWait = {
        pollIntervalMs: 1_000,
        timeoutMs: 10_000,
        sleep: (ms: number) => {
          now += ms;
          return Promise.resolve();
        },
      };
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS'] });
      try {
        await expect(provider.create('Inst', TYPE, baseProps())).rejects.toThrow(
          /Connect instance Inst was still CREATION_IN_PROGRESS when its ACTIVE wait ran out/
        );
      } finally {
        clock.mockRestore();
      }
      expect(sentOf(DeleteInstanceCommand)).toHaveLength(1);
    });

    it('retries an attribute write the instance is not ready for yet', async () => {
      scriptCreate({ statuses: ['CREATION_IN_PROGRESS', 'ACTIVE'] });
      const base = mockSend.getMockImplementation()!;
      let refusals = 2;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof UpdateInstanceAttributeCommand && refusals > 0) {
          refusals--;
          return Promise.reject(notFound());
        }
        return base(cmd);
      });

      await provider.create('Inst', TYPE, baseProps());
      expect(sentOf(UpdateInstanceAttributeCommand)).toHaveLength(3);
      expect(sentOf(DeleteInstanceCommand)).toHaveLength(0);
    });

    it.each([
      ['a missing Attributes', { Attributes: undefined }, /Attributes .* is required/],
      ['an unknown member', { Attributes: { InboundCalls: true, OutboundCalls: true, Nope: true } }, /Nope/],
      ['a non-boolean member', { Attributes: { InboundCalls: 'maybe', OutboundCalls: true } }, /InboundCalls/],
      ['a missing OutboundCalls', { Attributes: { InboundCalls: true } }, /must declare OutboundCalls/],
      ['a missing IdentityManagementType', { IdentityManagementType: undefined }, /IdentityManagementType is required/],
    ])('refuses %s before any call', async (_label, extra, message) => {
      await expect(provider.create('Inst', TYPE, baseProps(extra))).rejects.toThrow(message);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('accepts CFn string booleans', async () => {
      scriptCreate({ statuses: ['ACTIVE'] });
      await provider.create(
        'Inst',
        TYPE,
        baseProps({ Attributes: { InboundCalls: 'true', OutboundCalls: 'false' } })
      );
      expect(sentOf(CreateInstanceCommand)[0]?.input).toMatchObject({
        InboundCallsEnabled: true,
        OutboundCallsEnabled: false,
      });
      expect(sentOf(UpdateInstanceAttributeCommand)).toHaveLength(0);
    });
  });

  describe('update', () => {
    it('writes only the changed attributes and diffs tags', async () => {
      mockSend.mockResolvedValue({});
      const result = await provider.update(
        'Inst',
        ARN,
        TYPE,
        baseProps({
          Attributes: { InboundCalls: true, OutboundCalls: true, ContactflowLogs: true },
          Tags: [{ Key: 'a', Value: '2' }],
        }),
        baseProps({
          Attributes: { InboundCalls: true, OutboundCalls: false, ContactflowLogs: true },
          Tags: [
            { Key: 'a', Value: '1' },
            { Key: 'b', Value: 'x' },
          ],
        })
      );
      expect(result).toEqual({ physicalId: ARN, wasReplaced: false });
      expect(sentOf(UpdateInstanceAttributeCommand).map((c) => c.input)).toEqual([
        { InstanceId: ID, AttributeType: 'OUTBOUND_CALLS', Value: 'true' },
      ]);
      expect(sentOf(UntagResourceCommand)[0]?.input).toEqual({ resourceArn: ARN, tagKeys: ['b'] });
      expect(sentOf(TagResourceCommand)[0]?.input).toEqual({ resourceArn: ARN, tags: { a: '2' } });
    });

    it('leaves a removed attribute at its live value, with a warning', async () => {
      mockSend.mockResolvedValue({});
      await provider.update('Inst', ARN, TYPE, baseProps({ Attributes: { InboundCalls: true, OutboundCalls: false } }), baseProps());
      expect(sentOf(UpdateInstanceAttributeCommand)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('ContactflowLogs'));
    });

    it('sends nothing when nothing changed', async () => {
      await provider.update('Inst', ARN, TYPE, baseProps(), baseProps());
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('re-sends every declared attribute and tag when a failed update left them unsettled', async () => {
      mockSend.mockResolvedValue({});
      const markUnsettled = vi.fn();
      await provider.update(
        'Inst',
        ARN,
        TYPE,
        baseProps({ Tags: [{ Key: 'a', Value: '1' }] }),
        baseProps({ Tags: [{ Key: 'a', Value: '1' }] }),
        { unsettledProperties: new Set(['Attributes', 'Tags']), markUnsettled }
      );
      expect(sentOf(UpdateInstanceAttributeCommand).map((c) => c.input.AttributeType)).toEqual([
        'INBOUND_CALLS',
        'OUTBOUND_CALLS',
        'CONTACTFLOW_LOGS',
      ]);
      expect(sentOf(TagResourceCommand)[0]?.input).toEqual({ resourceArn: ARN, tags: { a: '1' } });
      expect(markUnsettled).toHaveBeenCalledWith('Attributes');
      expect(markUnsettled).toHaveBeenCalledWith('Tags');
    });

    it('marks Attributes unsettled before an attribute write', async () => {
      mockSend.mockRejectedValue(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
      const markUnsettled = vi.fn();
      await expect(
        provider.update(
          'Inst',
          ARN,
          TYPE,
          baseProps({ Attributes: { InboundCalls: false, OutboundCalls: false } }),
          baseProps(),
          { markUnsettled }
        )
      ).rejects.toThrow(/Failed to update Connect instance Inst/);
      expect(markUnsettled).toHaveBeenCalledWith('Attributes');
    });

    it('refuses a malformed template Attributes before any call', async () => {
      await expect(
        provider.update('Inst', ARN, TYPE, baseProps({ Attributes: { InboundCalls: 'maybe', OutboundCalls: true } }), baseProps())
      ).rejects.toThrow(/InboundCalls/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it.each([
      ['a rollback replay', { replayingState: true }],
      ['a drift revert', { desiredFromAwsReadback: true }],
    ])('applies the usable members of a malformed state-borne Attributes on %s, with a warning', async (_label, ctx) => {
      mockSend.mockResolvedValue({});
      await provider.update(
        'Inst',
        ARN,
        TYPE,
        baseProps({ Attributes: { InboundCalls: 'maybe', OutboundCalls: true, ContactflowLogs: true } }),
        baseProps({ Attributes: { InboundCalls: true, OutboundCalls: false, ContactflowLogs: true } }),
        ctx
      );
      expect(sentOf(UpdateInstanceAttributeCommand).map((c) => c.input)).toEqual([
        { InstanceId: ID, AttributeType: 'OUTBOUND_CALLS', Value: 'true' },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('only its usable members are applied'));
    });

    it('refuses an update from a client in another region than the record, before any write', async () => {
      await expect(
        provider.update('Inst', ARN, TYPE, baseProps({ Attributes: { InboundCalls: false, OutboundCalls: false } }), baseProps(), {
          expectedRegion: 'eu-west-1',
        })
      ).rejects.toThrow(/eu-west-1/);
      expect(sentOf(UpdateInstanceAttributeCommand)).toHaveLength(0);
    });
  });

  describe('getAttribute', () => {
    it('answers Arn and Id from the physical id, and the rest from DescribeInstance', async () => {
      mockSend.mockResolvedValue({
        Instance: { Id: ID, Arn: ARN, InstanceStatus: 'ACTIVE', ServiceRole: ROLE, CreatedTime: CREATED },
      });
      expect(await provider.getAttribute(ARN, TYPE, 'Arn')).toBe(ARN);
      expect(await provider.getAttribute(ARN, TYPE, 'Id')).toBe(ID);
      expect(mockSend).not.toHaveBeenCalled();
      expect(await provider.getAttribute(ARN, TYPE, 'ServiceRole')).toBe(ROLE);
      expect(await provider.getAttribute(ARN, TYPE, 'CreatedTime')).toBe(CREATED.toISOString());
    });
  });

  describe('delete', () => {
    it('deletes by instance id', async () => {
      mockSend.mockResolvedValue({});
      await provider.delete('Inst', ARN, TYPE);
      expect(sentOf(DeleteInstanceCommand).map((c) => c.input)).toEqual([{ InstanceId: ID }]);
    });

    it('retries a delete the instance answers not-found to while DescribeInstance still finds it', async () => {
      let refusals = 2;
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DeleteInstanceCommand && refusals-- > 0) return Promise.reject(notFound());
        if (cmd instanceof DescribeInstanceCommand) return Promise.resolve({ Instance: { Id: ID, Arn: ARN } });
        return Promise.resolve({});
      });
      await provider.delete('Inst', ARN, TYPE, undefined, { expectedRegion: 'us-east-1' });
      expect(sentOf(DeleteInstanceCommand)).toHaveLength(3);
    });

    it('never reads a not-found as gone while DescribeInstance still finds the instance', async () => {
      provider.instanceWait = { pollIntervalMs: 0, timeoutMs: 0, sleep: () => Promise.resolve() };
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DescribeInstanceCommand
          ? Promise.resolve({ Instance: { Id: ID, Arn: ARN } })
          : Promise.reject(notFound())
      );
      const error = await provider
        .delete('Inst', ARN, TYPE, undefined, { expectedRegion: 'us-east-1' })
        .catch((e: unknown) => e);
      expect(isMarkedNotGone(error)).toBe(true);
    });

    it('rethrows a Ctrl-C during the delete retry as the interrupt, not a delete failure', async () => {
      interrupt.on = true;
      mockSend.mockImplementation((cmd: unknown) =>
        cmd instanceof DescribeInstanceCommand
          ? Promise.resolve({ Instance: { Id: ID, Arn: ARN } })
          : Promise.reject(notFound())
      );
      const error = await provider
        .delete('Inst', ARN, TYPE, undefined, { expectedRegion: 'us-east-1' })
        .catch((e: unknown) => e);
      expect(isInterruptedWaitError(error)).toBe(true);
      expect(String(error)).not.toMatch(/Failed to delete/);
    });

    it('treats not-found as already deleted', async () => {
      mockSend.mockRejectedValue(notFound());
      await expect(provider.delete('Inst', ARN, TYPE, undefined, { expectedRegion: 'us-east-1' })).resolves.toBeUndefined();
    });

    it('refuses a not-found from a client in another region than the record', async () => {
      mockSend.mockRejectedValue(notFound());
      await expect(
        provider.delete('Inst', ARN, TYPE, undefined, { expectedRegion: 'eu-west-1' })
      ).rejects.toThrow(/eu-west-1/);
    });

    it('refuses a not-found from a client in another region than the ARN when no region is recorded', async () => {
      mockSend.mockRejectedValue(notFound());
      const other = ARN.replace('us-east-1', 'eu-west-1');
      await expect(provider.delete('Inst', other, TYPE)).rejects.toThrow(/eu-west-1/);
    });
  });

  describe('readCurrentState', () => {
    it('reads the instance, every attribute, and user tags', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof DescribeInstanceCommand) {
          return Promise.resolve({
            Instance: {
              Arn: ARN,
              IdentityManagementType: 'CONNECT_MANAGED',
              InstanceAlias: 'my-alias',
              Tags: { k: 'v', 'aws:cloudformation:stack-name': 's' },
            },
          });
        }
        if (cmd instanceof ListInstanceAttributesCommand) {
          return Promise.resolve({
            Attributes: [
              { AttributeType: 'INBOUND_CALLS', Value: 'true' },
              { AttributeType: 'CONTACTFLOW_LOGS', Value: 'false' },
            ],
          });
        }
        return Promise.resolve({});
      });
      expect(await provider.readCurrentState(ARN, 'Inst', TYPE)).toEqual({
        IdentityManagementType: 'CONNECT_MANAGED',
        InstanceAlias: 'my-alias',
        Attributes: { InboundCalls: true, ContactflowLogs: false },
        Tags: [{ Key: 'k', Value: 'v' }],
      });
    });

    it('answers RESOURCE_NOT_FOUND for a gone instance', async () => {
      mockSend.mockRejectedValue(notFound());
      expect(await provider.readCurrentState(ARN, 'Inst', TYPE)).toBe(RESOURCE_NOT_FOUND);
    });
  });

  describe('import', () => {
    const input = (extra: Record<string, unknown> = {}) => ({
      logicalId: 'Inst',
      resourceType: TYPE,
      stackName: 's',
      region: 'us-east-1',
      properties: baseProps(),
      ...extra,
    });

    it('verifies an explicit id and records the ARN', async () => {
      mockSend.mockResolvedValue({ Instance: { Id: ID, Arn: ARN, InstanceStatus: 'ACTIVE' } });
      const result = await provider.import(input({ knownPhysicalId: ID }));
      expect(result?.physicalId).toBe(ARN);
      expect(sentOf(DescribeInstanceCommand)[0]?.input).toEqual({ InstanceId: ID });
    });

    it('finds the instance by InstanceAlias', async () => {
      mockSend.mockResolvedValue({
        InstanceSummaryList: [
          { Id: 'other', Arn: 'arn:other', InstanceAlias: 'other' },
          { Id: ID, Arn: ARN, InstanceAlias: 'my-alias' },
        ],
      });
      expect((await provider.import(input()))?.physicalId).toBe(ARN);
      expect(sentOf(ListInstancesCommand)).toHaveLength(1);
    });

    it('returns null when nothing matches', async () => {
      mockSend.mockResolvedValue({ InstanceSummaryList: [] });
      expect(await provider.import(input())).toBeNull();
    });
  });
});
