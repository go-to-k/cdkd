import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PutRuleCommand,
  PutTargetsCommand,
  RemoveTargetsCommand,
} from '@aws-sdk/client-eventbridge';

// Mock AWS clients before importing the provider
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

import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';

const RULE_NAME = 'my-rule';
const RULE_ARN = `arn:aws:events:us-east-1:123456789012:rule/${RULE_NAME}`;

/**
 * Read-update round-trip tests for EventBridgeRuleProvider.
 *
 * See docs/provider-development.md § 3b "Read-update round-trip test" —
 * `cdkd drift --revert` ships `observedProperties` (= a previous
 * `readCurrentState` snapshot) back through `provider.update`. These
 * tests are the structural guard against the three latent bug classes:
 *
 *   - Class 1: type-discriminator-dependent fields (EventPattern vs
 *     ScheduleExpression are mutually exclusive — emitting the wrong
 *     one would have AWS reject "ValidationException: Parameter ... is
 *     not valid for the rule type").
 *   - Class 2: structurally-incomplete-when-empty fields (an empty
 *     EventPattern object would round-trip to `"{}"` JSON, which AWS
 *     `PutRule` rejects with "Parameter EventPattern is not valid").
 *   - Truthy-gate: `update()` MUST gate optional fields on `!==
 *     undefined`, not truthy. Empty `Description: ''` must reach
 *     `PutRuleCommand` so `--revert` can clear an AWS-side description.
 */
describe('EventBridgeRuleProvider read-update round-trip', () => {
  let provider: EventBridgeRuleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new EventBridgeRuleProvider();
  });

  it("Class 1 — schedule-only rule does NOT send EventPattern to AWS on round-trip", async () => {
    // Schedule-only rule: observed snapshot has ScheduleExpression but
    // no EventPattern. Round-trip update must NOT ship EventPattern
    // (mutually exclusive with ScheduleExpression — AWS would reject).
    mockSend.mockResolvedValue({ RuleArn: RULE_ARN });

    const observed: Record<string, unknown> = {
      Name: RULE_NAME,
      Description: '',
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      Targets: [],
      Tags: [],
    };

    await provider.update('L', RULE_ARN, 'AWS::Events::Rule', observed, observed);

    const putRuleCall = mockSend.mock.calls.find((c) => c[0] instanceof PutRuleCommand);
    expect(putRuleCall).toBeDefined();
    const input = (putRuleCall![0] as PutRuleCommand).input;
    expect(input.EventPattern).toBeUndefined();
    expect(input.ScheduleExpression).toBe('rate(5 minutes)');
  });

  it("Class 1 — pattern-only rule does NOT send ScheduleExpression to AWS on round-trip", async () => {
    // Pattern-only rule: observed snapshot has EventPattern (parsed
    // back from the JSON string AWS returns) but no ScheduleExpression.
    // Round-trip update must NOT ship ScheduleExpression.
    mockSend.mockResolvedValue({ RuleArn: RULE_ARN });

    const observed: Record<string, unknown> = {
      Name: RULE_NAME,
      Description: '',
      EventPattern: { source: ['aws.ec2'], 'detail-type': ['EC2 Instance State-change Notification'] },
      State: 'ENABLED',
      Targets: [],
      Tags: [],
    };

    await provider.update('L', RULE_ARN, 'AWS::Events::Rule', observed, observed);

    const putRuleCall = mockSend.mock.calls.find((c) => c[0] instanceof PutRuleCommand);
    expect(putRuleCall).toBeDefined();
    const input = (putRuleCall![0] as PutRuleCommand).input;
    expect(input.ScheduleExpression).toBeUndefined();
    // EventPattern is JSON-stringified on the wire (PutRule accepts a
    // JSON string, not the parsed object).
    expect(typeof input.EventPattern).toBe('string');
    expect(JSON.parse(input.EventPattern as string)).toEqual({
      source: ['aws.ec2'],
      'detail-type': ['EC2 Instance State-change Notification'],
    });
  });

  it("Class 2 — observed EventPattern that is a valid object round-trips identity (no '{}' rejection shape)", async () => {
    // The structural guard: if a future readCurrentState change ever
    // emitted EventPattern as an empty placeholder `{}`, JSON.stringify
    // would produce `"{}"` and AWS PutRule would reject with "Parameter
    // EventPattern is not valid". Today readCurrentState does NOT emit
    // `{}` (the if-guard at line 451 only emits when AWS returns a
    // non-undefined string), so this test asserts the contract: when
    // EventPattern IS in the snapshot, it must be a non-empty object,
    // and the wire-layer JSON must not be the rejection shape `"{}"`.
    mockSend.mockResolvedValue({ RuleArn: RULE_ARN });

    const observed: Record<string, unknown> = {
      Name: RULE_NAME,
      Description: '',
      EventPattern: { source: ['custom.app'] },
      State: 'ENABLED',
      Targets: [],
      Tags: [],
    };

    await provider.update('L', RULE_ARN, 'AWS::Events::Rule', observed, observed);

    const putRuleCall = mockSend.mock.calls.find((c) => c[0] instanceof PutRuleCommand);
    expect(putRuleCall).toBeDefined();
    const input = (putRuleCall![0] as PutRuleCommand).input;
    expect(input.EventPattern).not.toBe('{}');
    expect(input.EventPattern).not.toBe('');
    expect(input.EventPattern).toBe('{"source":["custom.app"]}');
  });

  it("truthy-gate — empty Description ('') reaches PutRuleCommand input on round-trip", async () => {
    // readCurrentState always-emits `Description: ''` (placeholder for
    // a rule with no description). A truthy gate in update() would
    // silently drop the empty string and leave the AWS-side description
    // untouched — `cdkd drift --revert` would report `✓ reverted` while
    // the very next drift re-detects the same drift. This test asserts
    // `!== undefined` (not truthy) on Description.
    mockSend.mockResolvedValue({ RuleArn: RULE_ARN });

    const observed: Record<string, unknown> = {
      Name: RULE_NAME,
      Description: '',
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      Targets: [],
      Tags: [],
    };

    await provider.update('L', RULE_ARN, 'AWS::Events::Rule', observed, observed);

    const putRuleCall = mockSend.mock.calls.find((c) => c[0] instanceof PutRuleCommand);
    expect(putRuleCall).toBeDefined();
    const input = (putRuleCall![0] as PutRuleCommand).input;
    // Description: '' MUST reach the AWS API call. If a truthy gate
    // ever sneaks back in, this assertion fires: input.Description
    // would be undefined.
    expect(input.Description).toBe('');
  });

  it("round-trip on no-target snapshot does not fire a PutTargetsCommand", async () => {
    // observed has Targets: [] (always-emit placeholder for a rule
    // with no targets). update() should NOT call PutTargetsCommand —
    // PutTargetsCommand with Targets: [] would be rejected by AWS
    // ("Targets list must contain at least one element").
    mockSend.mockResolvedValue({ RuleArn: RULE_ARN });

    const observed: Record<string, unknown> = {
      Name: RULE_NAME,
      Description: '',
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      Targets: [],
      Tags: [],
    };

    await provider.update('L', RULE_ARN, 'AWS::Events::Rule', observed, observed);

    const putTargetsCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof PutTargetsCommand
    );
    expect(putTargetsCalls).toHaveLength(0);
    const removeTargetsCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof RemoveTargetsCommand
    );
    expect(removeTargetsCalls).toHaveLength(0);
  });

  it("round-trip on populated-target snapshot ships Targets verbatim (no shape mutation)", async () => {
    // Targets array contents (each target's EcsParameters /
    // BatchParameters / etc. — all Class 1 sub-shapes within the
    // target) flow identity from readCurrentState ←
    // ListTargetsByRuleCommand → update() → PutTargetsCommand. AWS's
    // ListTargets and PutTargets share the same Target shape, so the
    // round-trip is identity.
    mockSend.mockResolvedValue({ RuleArn: RULE_ARN });

    const targets = [
      {
        Id: 'Target1',
        Arn: 'arn:aws:lambda:us-east-1:123456789012:function:my-fn',
        Input: '{"foo":"bar"}',
      },
    ];
    const observed: Record<string, unknown> = {
      Name: RULE_NAME,
      Description: '',
      ScheduleExpression: 'rate(5 minutes)',
      State: 'ENABLED',
      Targets: targets,
      Tags: [],
    };

    await provider.update('L', RULE_ARN, 'AWS::Events::Rule', observed, observed);

    const putTargetsCall = mockSend.mock.calls.find(
      (c) => c[0] instanceof PutTargetsCommand
    );
    expect(putTargetsCall).toBeDefined();
    const input = (putTargetsCall![0] as PutTargetsCommand).input;
    expect(input.Targets).toEqual(targets);
  });
});
