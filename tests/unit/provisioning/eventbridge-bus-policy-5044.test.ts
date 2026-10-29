/**
 * Issue #5044: `AWS::Events::EventBus` `Policy` is applied, as CloudFormation
 * applies it (real A/B, bus + Policy + a separate AWS::Events::EventBusPolicy):
 *
 * - create: the whole document goes out through `PutPermission` `Policy`;
 * - update with a CHANGED Policy: the whole document replaces the bus policy
 *   (CFn wipes separate EventBusPolicy statements too; it does not merge);
 * - update with an UNCHANGED Policy: nothing is sent for it, so separate
 *   statements survive an update made for another property;
 * - Policy REMOVED from the template: CFn leaves the live policy untouched, so
 *   cdkd sends nothing either.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventBusCommand,
  PutPermissionCommand,
  UpdateEventBusCommand,
} from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();
const mockWarn = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { hasRedactedCause } from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';

const TYPE = 'AWS::Events::EventBus';
const NAME = 'my-bus';
const BUS_ARN = `arn:aws:events:us-east-1:111122223333:event-bus/${NAME}`;

function statement(sid: string): Record<string, unknown> {
  return {
    Sid: sid,
    Effect: 'Allow',
    Principal: { AWS: 'arn:aws:iam::111122223333:root' },
    Action: 'events:PutEvents',
    Resource: BUS_ARN,
  };
}

function policy(sid: string): Record<string, unknown> {
  return { Version: '2012-10-17', Statement: [statement(sid)] };
}

function putPermissionInputs(): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof PutPermissionCommand)
    .map((c) => (c[0] as PutPermissionCommand).input as Record<string, unknown>);
}

const CALLER_ARN = 'arn:aws:sts::111122223333:assumed-role/deployer/session-1';

/** An AWS-authored refusal naming the caller, as EventBridge words one. */
function accessDenied(): Error {
  return Object.assign(
    new Error(`User: ${CALLER_ARN} is not authorized to perform: events:PutPermission`),
    { name: 'AccessDeniedException', $fault: 'client', $metadata: { httpStatusCode: 400 } }
  );
}

function commandNames(): string[] {
  return mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
}

describe('EventBridgeBusProvider Policy (issue #5044)', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockWarn.mockReset();
    mockSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd instanceof CreateEventBusCommand ? { EventBusArn: BUS_ARN } : {})
    );
    provider = new EventBridgeBusProvider();
  });

  describe('create', () => {
    it('applies an object Policy as its JSON document, after the bus exists', async () => {
      const doc = policy('allow-own-account');

      await provider.create('Bus', TYPE, { Name: NAME, Policy: doc });

      expect(putPermissionInputs()).toEqual([{ EventBusName: NAME, Policy: JSON.stringify(doc) }]);
      expect(commandNames()).toEqual(['CreateEventBusCommand', 'PutPermissionCommand']);
    });

    it('applies a JSON-string Policy unchanged', async () => {
      const doc = JSON.stringify(policy('allow-own-account'));

      await provider.create('Bus', TYPE, { Name: NAME, Policy: doc });

      expect(putPermissionInputs()).toEqual([{ EventBusName: NAME, Policy: doc }]);
    });

    it('sends no PutPermission when no Policy is declared', async () => {
      await provider.create('Bus', TYPE, { Name: NAME });

      expect(putPermissionInputs()).toEqual([]);
    });

    it('names the created bus on the error when PutPermission fails', async () => {
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateEventBusCommand) return Promise.resolve({ EventBusArn: BUS_ARN });
        if (cmd instanceof PutPermissionCommand) {
          return Promise.reject(new Error('policy refused'));
        }
        return Promise.resolve({});
      });

      const err = await provider
        .create('Bus', TYPE, { Name: NAME, Policy: policy('s') })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProvisioningError);
      expect(createdBeforeFailure(err, 'Bus', TYPE)).toBe(NAME);
      expect((err as ProvisioningError).physicalId).toBe(NAME);
      // A cdkd-authored / transport error keeps its text.
      expect((err as Error).message).toBe('Failed to create EventBus Bus: policy refused');
    });

    it('reports the created bus to the sink before PutPermission (#5511)', async () => {
      const sink = new CreatedResourceSink('Bus', TYPE);
      let atPutPermission: unknown = 'unset';
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateEventBusCommand) return Promise.resolve({ EventBusArn: BUS_ARN });
        if (cmd instanceof PutPermissionCommand) {
          atPutPermission = sink.report;
          return Promise.reject(new Error('policy refused'));
        }
        return Promise.resolve({});
      });

      await collectCreatedResources(sink, () =>
        provider.create('Bus', TYPE, { Name: NAME, Policy: policy('s') }).catch((e: unknown) => e)
      );

      expect(atPutPermission).toEqual({ physicalId: NAME });
      expect(sink.report).toEqual({ physicalId: NAME });
    });

    it('reports nothing when CreateEventBus itself fails (#5511)', async () => {
      const sink = new CreatedResourceSink('Bus', TYPE);
      mockSend.mockRejectedValue(new Error('LimitExceeded'));
      await collectCreatedResources(sink, () =>
        provider.create('Bus', TYPE, { Name: NAME }).catch((e: unknown) => e)
      );
      expect(sink.report).toBeUndefined();
    });

    it('keeps the caller ARN out of an AWS-authored PutPermission refusal (#2319)', async () => {
      const aws = accessDenied();
      mockSend.mockImplementation((cmd: unknown) => {
        if (cmd instanceof CreateEventBusCommand) return Promise.resolve({ EventBusArn: BUS_ARN });
        if (cmd instanceof PutPermissionCommand) return Promise.reject(aws);
        return Promise.resolve({});
      });

      const err = (await provider
        .create('Bus', TYPE, { Name: NAME, Policy: policy('s') })
        .catch((e: unknown) => e)) as ProvisioningError;

      expect(err).toBeInstanceOf(ProvisioningError);
      expect(err.message).toBe(`Failed to create EventBus Bus: AccessDeniedException. ${VERBOSE_POINTER}`);
      expect(err.message).not.toContain(CALLER_ARN);
      expect(err.cause).toBe(aws);
      expect(hasRedactedCause(err)).toBe(true);
      expect(err.physicalId).toBe(NAME);
      expect(createdBeforeFailure(err, 'Bus', TYPE)).toBe(NAME);
    });

    it('names no bus when CreateEventBus itself fails', async () => {
      mockSend.mockRejectedValue(new Error('create refused'));

      const err = await provider
        .create('Bus', TYPE, { Name: NAME, Policy: policy('s') })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ProvisioningError);
      expect(createdBeforeFailure(err, 'Bus', TYPE)).toBeUndefined();
      expect((err as ProvisioningError).physicalId).toBeUndefined();
      expect(putPermissionInputs()).toEqual([]);
    });
  });

  describe('update', () => {
    it('replaces the whole policy with a CHANGED document', async () => {
      const next = policy('new-sid');

      await provider.update(
        'Bus',
        NAME,
        TYPE,
        { Name: NAME, Policy: next },
        { Name: NAME, Policy: policy('old-sid') }
      );

      expect(putPermissionInputs()).toEqual([{ EventBusName: NAME, Policy: JSON.stringify(next) }]);
    });

    it('keeps the caller ARN out of an AWS-authored update refusal (#2319)', async () => {
      const aws = accessDenied();
      mockSend.mockRejectedValue(aws);

      const err = (await provider
        .update('Bus', NAME, TYPE, { Name: NAME, Policy: policy('b') }, { Name: NAME, Policy: policy('a') })
        .catch((e: unknown) => e)) as ProvisioningError;

      expect(err).toBeInstanceOf(ProvisioningError);
      expect(err.message).toBe(`Failed to update EventBus Bus: AccessDeniedException. ${VERBOSE_POINTER}`);
      expect(err.message).not.toContain(CALLER_ARN);
      expect(err.cause).toBe(aws);
      expect(hasRedactedCause(err)).toBe(true);
    });

    it('applies a Policy ADDED to a bus that had none', async () => {
      const next = policy('new-sid');

      await provider.update('Bus', NAME, TYPE, { Name: NAME, Policy: next }, { Name: NAME });

      expect(putPermissionInputs()).toEqual([{ EventBusName: NAME, Policy: JSON.stringify(next) }]);
    });

    it('sends nothing for an UNCHANGED Policy on an update made for another property', async () => {
      await provider.update(
        'Bus',
        NAME,
        TYPE,
        { Name: NAME, Description: 'new', Policy: policy('same') },
        { Name: NAME, Description: 'old', Policy: policy('same') }
      );

      expect(putPermissionInputs()).toEqual([]);
      // The update itself still ran, so the Policy arm was reached.
      expect(commandNames()).toEqual(['UpdateEventBusCommand']);
    });

    it('treats the same document as an object and as a JSON string as unchanged', async () => {
      await provider.update(
        'Bus',
        NAME,
        TYPE,
        { Name: NAME, Policy: JSON.stringify(policy('same'), null, 2) },
        { Name: NAME, Policy: policy('same') }
      );

      expect(putPermissionInputs()).toEqual([]);
    });

    it('treats the same document with its keys in another order as unchanged', async () => {
      const reordered = {
        Statement: [Object.fromEntries(Object.entries(statement('same')).reverse())],
        Version: '2012-10-17',
      };

      await provider.update(
        'Bus',
        NAME,
        TYPE,
        { Name: NAME, Policy: reordered },
        { Name: NAME, Policy: policy('same') }
      );

      expect(putPermissionInputs()).toEqual([]);
    });

    it('re-puts a Policy whose recorded side keeps a secret reference', async () => {
      // State keeps `{{resolve:...}}`; the desired side is resolved. The two
      // cannot be told apart from a re-pointed reference, so the declared
      // document is applied.
      const recorded = {
        Version: '2012-10-17',
        Statement: [{ ...statement('s'), Principal: { AWS: '{{resolve:ssm-secure:acct}}' } }],
      };
      const desired = policy('s');

      await provider.update(
        'Bus',
        NAME,
        TYPE,
        { Name: NAME, Policy: desired },
        { Name: NAME, Policy: recorded }
      );

      expect(putPermissionInputs()).toEqual([
        { EventBusName: NAME, Policy: JSON.stringify(desired) },
      ]);
    });
  });

  describe('removal from the template', () => {
    it('leaves the live policy untouched on a direct call, and says so', async () => {
      await provider.update('Bus', NAME, TYPE, { Name: NAME }, { Name: NAME, Policy: policy('s') });

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(mockWarn.mock.calls[0]![0]).toContain('Policy was removed from the template');
    });

    it('does not warn on drift --revert (empty removedProperties)', async () => {
      await provider.update('Bus', NAME, TYPE, { Name: NAME }, { Name: NAME, Policy: policy('s') }, {
        removedProperties: new Set(),
        desiredFromAwsReadback: true,
      });

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('does not warn when no Policy was declared before', async () => {
      await provider.update('Bus', NAME, TYPE, { Name: NAME, Description: 'd' }, { Name: NAME });

      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('leaves the live policy untouched through the deploy caller', async () => {
      const previous = { Name: NAME, Policy: policy('s') };
      const prep = prepareRemovalForUpdate(provider, TYPE, { Name: NAME }, previous);

      expect(prep.injected).toEqual([]);
      expect(prep.properties['Policy']).toBeUndefined();

      await provider.update('Bus', NAME, TYPE, prep.properties, previous, { ...prep.context });

      expect(mockSend).not.toHaveBeenCalled();
      expect(mockWarn).toHaveBeenCalledTimes(1);
    });

    it('declares no removal default for Policy', () => {
      expect(provider.removalDefaults.get(TYPE)?.has('Policy')).toBe(false);
    });
  });

  it('sends no UpdateEventBus for a Policy-only change', async () => {
    await provider.update(
      'Bus',
      NAME,
      TYPE,
      { Name: NAME, Policy: policy('b') },
      { Name: NAME, Policy: policy('a') }
    );

    expect(
      mockSend.mock.calls.filter((c) => c[0] instanceof UpdateEventBusCommand)
    ).toHaveLength(0);
  });
});
