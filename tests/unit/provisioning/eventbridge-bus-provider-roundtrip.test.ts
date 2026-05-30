import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateEventBusCommand,
  UpdateEventBusCommand,
} from '@aws-sdk/client-eventbridge';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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

import { EventBridgeBusProvider } from '../../../src/provisioning/providers/eventbridge-bus-provider.js';

const RESOURCE_TYPE = 'AWS::Events::EventBus';
const BUS_NAME = 'my-bus';
const BUS_ARN = `arn:aws:events:us-east-1:0:event-bus/${BUS_NAME}`;

describe('EventBridgeBusProvider read-update round-trip', () => {
  let provider: EventBridgeBusProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeBusProvider();
  });

  it('Class 2 — DeadLetterConfig {Arn:""} placeholder never reaches AWS on round-trip', async () => {
    // Mechanical guard for Class 2 placeholder regression on
    // structurally-incomplete-when-empty fields. See
    // docs/provider-development.md § 3b "Read-update round-trip test".
    //
    // readCurrentState always-emits DeadLetterConfig: { Arn: '' } on
    // buses without a DLQ (the comparator's top-level walk is
    // state-keys-only, so the placeholder is required for drift
    // detection on console-side DLQ attach).
    //
    // cdkd drift --revert later round-trips that placeholder back
    // through update(). AWS rejects `DeadLetterConfig: { Arn: '' }` as
    // an invalid ARN. The fix sanitises at the wire layer in update()
    // (and create()): empty-Arn placeholder is dropped before reaching
    // UpdateEventBusCommand.

    // Build observed snapshot directly (matches what readCurrentState
    // would produce for a bus with no DLC; readCurrentState is
    // exercised by its own dedicated test file).
    const observed = {
      Name: BUS_NAME,
      Description: '',
      KmsKeyIdentifier: '',
      DeadLetterConfig: { Arn: '' },
      Tags: [] as Array<{ Key: string; Value: string }>,
    };

    // Force the dlc branch to fire by passing a different "old"
    // (otherwise dlcChanged is false and we'd never observe the bug).
    const previous = {
      ...observed,
      DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:0:dlq' },
    };

    mockSend.mockResolvedValue({ Arn: BUS_ARN }); // covers all sends

    await provider.update('L', BUS_NAME, RESOURCE_TYPE, observed, previous);

    // Assert: no UpdateEventBusCommand was sent with the empty-Arn
    // placeholder DeadLetterConfig (the AWS-rejection shape).
    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateEventBusCommand
    );
    for (const call of updateCalls) {
      const input = call[0].input as {
        DeadLetterConfig?: { Arn?: string };
      };
      if (input.DeadLetterConfig !== undefined) {
        // If DeadLetterConfig is present in the request, its Arn must
        // be a real (non-empty) ARN.
        expect(input.DeadLetterConfig.Arn).not.toBe('');
        expect(input.DeadLetterConfig.Arn).not.toBeUndefined();
      }
    }
  });

  it('Class 2 — create() also sanitises the DeadLetterConfig {Arn:""} placeholder', async () => {
    // Symmetric guard for create(): a deploy that resolves
    // DeadLetterConfig to the empty-Arn placeholder (e.g. via a
    // partially-resolved Fn::GetAtt or a state-replay path) must not
    // send the AWS-rejection shape to CreateEventBus either.
    mockSend.mockResolvedValue({ EventBusArn: BUS_ARN });

    await provider.create('L', RESOURCE_TYPE, {
      Name: BUS_NAME,
      DeadLetterConfig: { Arn: '' },
    });

    const createCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof CreateEventBusCommand
    );
    expect(createCalls).toHaveLength(1);
    const input = createCalls[0][0].input as {
      DeadLetterConfig?: { Arn?: string };
    };
    expect(input.DeadLetterConfig).toBeUndefined();
  });

  it('round-trip on no-drift snapshot is a logical no-op (zero UpdateEventBus calls)', async () => {
    // state == AWS implies update() makes no AWS-side mutations. The
    // structural guard that fires when someone changes update()'s diff
    // logic.
    const observed = {
      Name: BUS_NAME,
      Description: 'a custom bus',
      KmsKeyIdentifier: 'alias/aws/events',
      DeadLetterConfig: { Arn: 'arn:aws:sqs:us-east-1:0:dlq' },
      Tags: [{ Key: 'k', Value: 'v' }],
    };

    mockSend.mockResolvedValue({ Arn: BUS_ARN });

    await provider.update('L', BUS_NAME, RESOURCE_TYPE, observed, observed);

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateEventBusCommand
    );
    expect(updateCalls).toHaveLength(0);
  });

  it('truthy-gate guard — empty-string Description ("") reaches UpdateEventBus on revert', async () => {
    // Mechanical guard for the truthy-gate regression class. See
    // docs/provider-development.md § 3b "update() must gate optional
    // fields on `!== undefined`, not truthy".
    //
    // When state has Description: '' (deployed with no description)
    // and AWS has Description: 'some desc' (console-edit), --revert
    // pushes `Description: ''` back through update(). A truthy gate
    // would silently drop the empty string; AWS would keep the
    // console value; the next drift run would re-detect the same
    // drift (silent fail mode).
    const newProps = {
      Name: BUS_NAME,
      Description: '',
      KmsKeyIdentifier: '',
      DeadLetterConfig: { Arn: '' },
    };
    const oldProps = {
      Name: BUS_NAME,
      Description: 'console-set description',
      KmsKeyIdentifier: '',
      DeadLetterConfig: { Arn: '' },
    };

    mockSend.mockResolvedValue({ Arn: BUS_ARN });

    await provider.update('L', BUS_NAME, RESOURCE_TYPE, newProps, oldProps);

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateEventBusCommand
    );
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0][0].input as {
      Description?: string;
    };
    expect(input.Description).toBe('');
  });

  // ─── #609 backfill: LogConfig ─────────────────────────────────────

  it('LogConfig backfill — create() forwards LogConfig to CreateEventBus', async () => {
    mockSend.mockResolvedValueOnce({ EventBusArn: BUS_ARN });

    await provider.create('L', RESOURCE_TYPE, {
      Name: BUS_NAME,
      LogConfig: { Level: 'INFO', IncludeDetail: 'FULL' },
    });

    const createCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof CreateEventBusCommand
    );
    expect(createCalls).toHaveLength(1);
    const input = createCalls[0][0].input as {
      LogConfig?: { Level?: string; IncludeDetail?: string };
    };
    expect(input.LogConfig).toEqual({ Level: 'INFO', IncludeDetail: 'FULL' });
  });

  it('LogConfig backfill — create() omits LogConfig when absent', async () => {
    mockSend.mockResolvedValueOnce({ EventBusArn: BUS_ARN });

    await provider.create('L', RESOURCE_TYPE, { Name: BUS_NAME });

    const createCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof CreateEventBusCommand
    );
    const input = createCalls[0][0].input as { LogConfig?: unknown };
    expect(input.LogConfig).toBeUndefined();
  });

  it('LogConfig backfill — update() emits UpdateEventBus when LogConfig changes', async () => {
    mockSend.mockResolvedValue({ Arn: BUS_ARN });

    await provider.update(
      'L',
      BUS_NAME,
      RESOURCE_TYPE,
      { Name: BUS_NAME, LogConfig: { Level: 'TRACE', IncludeDetail: 'FULL' } },
      { Name: BUS_NAME, LogConfig: { Level: 'INFO', IncludeDetail: 'NONE' } }
    );

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateEventBusCommand
    );
    expect(updateCalls).toHaveLength(1);
    const input = updateCalls[0][0].input as {
      LogConfig?: { Level?: string; IncludeDetail?: string };
    };
    expect(input.LogConfig).toEqual({ Level: 'TRACE', IncludeDetail: 'FULL' });
  });

  it('LogConfig backfill — update() unchanged LogConfig produces zero UpdateEventBus calls', async () => {
    mockSend.mockResolvedValue({ Arn: BUS_ARN });

    const same = { Name: BUS_NAME, LogConfig: { Level: 'INFO', IncludeDetail: 'FULL' } };
    await provider.update('L', BUS_NAME, RESOURCE_TYPE, same, same);

    const updateCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateEventBusCommand
    );
    expect(updateCalls).toHaveLength(0);
  });
});
