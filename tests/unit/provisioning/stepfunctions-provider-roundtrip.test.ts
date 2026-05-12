import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { UpdateStateMachineCommand } from '@aws-sdk/client-sfn';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-sfn', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    SFNClient: vi.fn().mockImplementation(() => ({
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

import { StepFunctionsProvider } from '../../../src/provisioning/providers/stepfunctions-provider.js';

const SM_ARN = 'arn:aws:states:us-east-1:123456789012:stateMachine:my-sm';
const RESOURCE_TYPE = 'AWS::StepFunctions::StateMachine';

interface UpdateInput {
  encryptionConfiguration?: { type?: unknown };
  loggingConfiguration?: {
    level?: string;
    includeExecutionData?: boolean;
    destinations?: Array<{ cloudWatchLogsLogGroup?: { logGroupArn?: string } }>;
  };
  tracingConfiguration?: { enabled?: boolean };
  roleArn?: string;
  definition?: string;
}

function findUpdateInput(): UpdateInput | undefined {
  const call = mockSend.mock.calls.find(
    (c: unknown[]) => c[0] instanceof UpdateStateMachineCommand
  );
  if (!call) return undefined;
  return (call[0] as UpdateStateMachineCommand).input as UpdateInput;
}

/**
 * Round-trip tests for `StepFunctionsProvider`. These mechanically guard the
 * three latent bug classes documented in
 * `docs/provider-development.md § 3b "Read-update round-trip test"`:
 *
 *   - Class 1 (type-discriminator-dependent fields): n/a for SFN —
 *     LoggingConfiguration / TracingConfiguration are valid on both STANDARD
 *     and EXPRESS workflows, so no discriminator gating is needed.
 *   - Class 2 (structurally-incomplete-when-empty): EncryptionConfiguration
 *     `{}` (no `Type`) is rejected by AWS as "Member must not be null", and
 *     LoggingConfiguration `{}` (no `Level`) would inadvertently disable
 *     logging if forwarded — both must fold to `undefined` on the wire.
 *   - Truthy gate: SFN `update()` does not gate any optional field with a
 *     truthy guard (RoleArn / Definition forwarded as-is), so the truthy-gate
 *     class is structurally absent. Documented here for future-proofing.
 */
describe('StepFunctionsProvider read-update round-trip', () => {
  let provider: StepFunctionsProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new StepFunctionsProvider();
  });

  it('Class 2 — EncryptionConfiguration {} placeholder does NOT reach UpdateStateMachine', async () => {
    // Mock the AWS-minimum DescribeStateMachine response: required fields
    // only, every optional sub-config absent. readCurrentState should
    // emit `EncryptionConfiguration: {}` per the always-emit contract.
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      type: 'STANDARD',
      // No encryptionConfiguration on the wire
    });
    mockSend.mockResolvedValueOnce({ tags: [] });

    const observed = await provider.readCurrentState(SM_ARN, 'L', RESOURCE_TYPE);
    expect(observed?.['EncryptionConfiguration']).toEqual({});

    // Round-trip: pass the placeholder back through update() as both new
    // and old. With the Class 2 sanitize in mapEncryptionConfiguration,
    // the empty placeholder must fold to `undefined` on the wire so AWS
    // does not reject with "encryptionConfiguration.type: Member must
    // not be null".
    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({}); // UpdateStateMachine
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      revisionId: 'rev-1',
    }); // DescribeStateMachine after update

    await provider.update('L', SM_ARN, RESOURCE_TYPE, observed!, observed!);

    const input = findUpdateInput();
    expect(input).toBeDefined();
    expect(input?.encryptionConfiguration).toBeUndefined();
  });

  it('Class 2 — LoggingConfiguration {} placeholder does NOT reach UpdateStateMachine', async () => {
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      type: 'STANDARD',
      // No loggingConfiguration on the wire
    });
    mockSend.mockResolvedValueOnce({ tags: [] });

    const observed = await provider.readCurrentState(SM_ARN, 'L', RESOURCE_TYPE);
    expect(observed?.['LoggingConfiguration']).toEqual({});

    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      revisionId: 'rev-1',
    });

    await provider.update('L', SM_ARN, RESOURCE_TYPE, observed!, observed!);

    const input = findUpdateInput();
    // Empty placeholder => no inadvertent "set Level to OFF" mutation.
    expect(input?.loggingConfiguration).toBeUndefined();
  });

  it('Case mapping — populated LoggingConfiguration round-trips as SDK camelCase, not CFn PascalCase', async () => {
    // Regression for the case-mismatch bug in update(): previously the
    // CFn-PascalCase value from cdkd state (`{ Level: 'ALL' }`) was cast
    // straight to the SDK camelCase type (`{ level: 'ALL' }`) — the cast
    // is a no-op at runtime, so AWS received the wrong shape and silently
    // ignored Level / IncludeExecutionData / Destinations. With the
    // PascalCase->camelCase mapper in place, observed values must arrive
    // at the wire in the SDK shape.
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      type: 'STANDARD',
      loggingConfiguration: {
        level: 'ALL',
        includeExecutionData: true,
        destinations: [
          {
            cloudWatchLogsLogGroup: {
              logGroupArn: 'arn:aws:logs:us-east-1:123:log-group:/aws/sfn',
            },
          },
        ],
      },
      tracingConfiguration: { enabled: true },
    });
    mockSend.mockResolvedValueOnce({ tags: [] });

    const observed = await provider.readCurrentState(SM_ARN, 'L', RESOURCE_TYPE);
    // Pre-condition: readCurrentState surfaced the CFn (PascalCase) shape.
    expect(observed?.['LoggingConfiguration']).toEqual({
      Level: 'ALL',
      IncludeExecutionData: true,
      Destinations: [
        {
          CloudWatchLogsLogGroup: {
            LogGroupArn: 'arn:aws:logs:us-east-1:123:log-group:/aws/sfn',
          },
        },
      ],
    });

    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      revisionId: 'rev-1',
    });

    await provider.update('L', SM_ARN, RESOURCE_TYPE, observed!, observed!);

    const input = findUpdateInput();
    // Must be SDK camelCase — not CFn PascalCase. A regression here
    // (e.g. `{ Level: 'ALL' }`) would silently disable logging because
    // AWS would not recognize the field.
    expect(input?.loggingConfiguration).toEqual({
      level: 'ALL',
      includeExecutionData: true,
      destinations: [
        {
          cloudWatchLogsLogGroup: {
            logGroupArn: 'arn:aws:logs:us-east-1:123:log-group:/aws/sfn',
          },
        },
      ],
    });
    expect(input?.tracingConfiguration).toEqual({ enabled: true });
  });

  it('Truthy-gate class — RoleArn / Definition forwarded as-is on round-trip (no truthy filtering)', async () => {
    // SFN's update() does not currently apply a truthy gate to any
    // optional field, so the truthy-gate class is structurally absent.
    // Lock that in: an observed RoleArn must reach UpdateStateMachine
    // unchanged, and an observed (non-empty) Definition must round-trip
    // through buildDefinitionString to the SDK input.
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      type: 'STANDARD',
      roleArn: 'arn:aws:iam::123:role/sfn',
      definition: '{"StartAt":"P","States":{"P":{"Type":"Pass","End":true}}}',
    });
    mockSend.mockResolvedValueOnce({ tags: [] });

    const observed = await provider.readCurrentState(SM_ARN, 'L', RESOURCE_TYPE);

    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      revisionId: 'rev-1',
    });

    await provider.update('L', SM_ARN, RESOURCE_TYPE, observed!, observed!);

    const input = findUpdateInput();
    expect(input?.roleArn).toBe('arn:aws:iam::123:role/sfn');
    // Definition is the JSON-stringified form of the parsed object the
    // comparator uses — buildDefinitionString re-stringifies it.
    expect(typeof input?.definition).toBe('string');
    expect(JSON.parse(input!.definition!)).toEqual({
      StartAt: 'P',
      States: { P: { Type: 'Pass', End: true } },
    });
  });

  it('round-trip on no-drift snapshot does not produce an AWS-rejection-shaped UpdateStateMachine input', async () => {
    // End-to-end mechanical guard: take the AWS-minimum response, run
    // through readCurrentState, then update() with observed as both new
    // and old, and confirm the wire-side input contains nothing AWS
    // would reject.
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      type: 'STANDARD',
    });
    mockSend.mockResolvedValueOnce({ tags: [] });

    const observed = await provider.readCurrentState(SM_ARN, 'L', RESOURCE_TYPE);

    vi.clearAllMocks();
    mockSend.mockResolvedValueOnce({});
    mockSend.mockResolvedValueOnce({
      stateMachineArn: SM_ARN,
      name: 'my-sm',
      revisionId: 'rev-1',
    });

    await provider.update('L', SM_ARN, RESOURCE_TYPE, observed!, observed!);

    const input = findUpdateInput();
    expect(input).toBeDefined();

    // Class 2 rejection-shape checks:
    if (input?.encryptionConfiguration !== undefined) {
      // AWS rejects encryptionConfiguration without `type`.
      expect(input.encryptionConfiguration.type).toBeDefined();
    }
    if (input?.loggingConfiguration !== undefined) {
      // A logging configuration without `level` is meaningless on the wire.
      expect(input.loggingConfiguration.level).toBeDefined();
    }
    // No DescribeStateMachine ever returned PascalCase keys to the wire.
    if (input?.loggingConfiguration !== undefined) {
      expect(
        (input.loggingConfiguration as Record<string, unknown>)['Level']
      ).toBeUndefined();
    }
    if (input?.tracingConfiguration !== undefined) {
      expect(
        (input.tracingConfiguration as Record<string, unknown>)['Enabled']
      ).toBeUndefined();
    }
  });
});
