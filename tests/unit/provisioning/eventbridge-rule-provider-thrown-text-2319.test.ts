import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const { mockSend, debug, warn } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  debug: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    eventBridge: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug,
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { ResourceNotFoundException } from '@aws-sdk/client-eventbridge';
import { EventBridgeRuleProvider } from '../../../src/provisioning/providers/eventbridge-rule-provider.js';
import {
  hasRedactedCause,
  isNameCollisionErrorFrom,
  isRetryableTransientError,
  retryClassificationText,
} from '../../../src/deployment/retryable-errors.js';
import { VERBOSE_POINTER } from '../../../src/utils/aws-failure-text.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';

// go-to-k/cdkd#2319: every create / update / delete wrap is persisted to
// `deployments/{runId}.jsonl`, so an AWS-authored failure is named by its class
// plus the --verbose pointer; AWS's text (the caller's role ARN) goes to the
// masked debug line and stays on `cause` for the retry classifiers.
const TYPE = 'AWS::Events::Rule';
const ARN = 'arn:aws:events:us-east-1:111122223333:rule/my-rule';
const DENIED =
  'User: arn:aws:sts::111122223333:assumed-role/deployer/s3cr3t is not authorized to perform: events:X';
const denied = (): Error =>
  Object.assign(new Error(DENIED), {
    name: 'AccessDeniedException',
    $fault: 'client',
    $metadata: { httpStatusCode: 400 },
  });
const mask = (t: string): string => t.replaceAll('s3cr3t', '***');
const debugLines = (): string[] => debug.mock.calls.map((c) => String(c[0]));
const warnLines = (): string[] => warn.mock.calls.map((c) => String(c[0]));
const notFound = (): Error =>
  new ResourceNotFoundException({ message: 'Rule my-rule does not exist.', $metadata: {} });

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a rejection');
}

const PROPS = { Name: 'my-rule', ScheduleExpression: 'rate(1 hour)' };
const TARGETS = [{ Id: 't1', Arn: 'arn:aws:sqs:us-east-1:111122223333:q' }];

const cases: Array<{ wrap: string; run: (p: EventBridgeRuleProvider) => Promise<unknown> }> = [
  {
    wrap: 'Failed to create EventBridge rule Rule',
    run: (p) => p.create('Rule', TYPE, PROPS, { maskSecrets: mask }),
  },
  {
    wrap: 'Failed to update EventBridge rule Rule',
    run: (p) =>
      p.update('Rule', ARN, TYPE, { ...PROPS, ScheduleExpression: 'rate(2 hours)' }, PROPS, {
        maskSecrets: mask,
      }),
  },
  {
    wrap: 'Failed to delete EventBridge rule Rule',
    run: (p) => p.delete('Rule', ARN, TYPE, undefined, { maskSecrets: mask }),
  },
];

describe('EventBridgeRuleProvider thrown wraps withhold AWS text (#2319)', () => {
  let provider: EventBridgeRuleProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockSend.mockReset();
    provider = new EventBridgeRuleProvider();
  });

  it.each(cases)('$wrap: an AWS-authored failure is named by its class', async (c) => {
    mockSend.mockRejectedValue(denied());

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: AccessDeniedException. ${VERBOSE_POINTER}`);
    expect(failure.message).not.toContain('111122223333');
    expect(failure.message).not.toContain('not authorized');
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    // `not authorized to perform` is retryable (IAM propagation), read on the chain.
    expect(isRetryableTransientError(failure, retryClassificationText(failure))).toBe(true);
    expect(debugLines()).toContain(`${c.wrap}: ${mask(DENIED)}`);
    expect(debugLines().join('\n')).not.toContain('s3cr3t');
  });

  it.each(cases)('$wrap: a cdkd-authored failure keeps its text, masked', async (c) => {
    mockSend.mockRejectedValue(new Error('socket hang up near s3cr3t'));

    const failure = await caught(c.run(provider));

    expect(failure.message).toBe(`${c.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('s3cr3t');
    // The mask changed the text, so the wrap is stamped (issue #4244).
    expect(hasRedactedCause(failure)).toBe(true);
  });

  it('a cdkd-authored failure the mask leaves alone is not stamped', async () => {
    mockSend.mockRejectedValue(new Error('socket hang up'));

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up`);
    expect(hasRedactedCause(failure)).toBe(false);
  });

  it('a non-Error throw is withheld, unstamped', async () => {
    mockSend.mockRejectedValue('raw s3cr3t value');

    const failure = await caught(provider.delete('Rule', ARN, TYPE));

    expect(failure.message).toBe(
      `Failed to delete EventBridge rule Rule: a non-Error value of type string. ${VERBOSE_POINTER}`
    );
    expect(failure.message).not.toContain('s3cr3t');
    expect(hasRedactedCause(failure)).toBe(false);
  });

  // A transport error the SDK retried carries `$metadata` with only the retry
  // counters (no `$fault`, no `httpStatusCode`): cdkd-side text, kept and masked.
  it('a retried transport error keeps its text, masked', async () => {
    mockSend.mockRejectedValue(
      Object.assign(new Error('socket hang up near s3cr3t'), {
        name: 'TimeoutError',
        $metadata: { attempts: 3, totalRetryDelay: 120 },
      })
    );

    const failure = await caught(cases[0]!.run(provider));

    expect(failure.message).toBe(`${cases[0]!.wrap}: socket hang up near ***`);
    expect(failure.message).not.toContain('TimeoutError');
    expect(failure.message).not.toContain(VERBOSE_POINTER);
    expect(failure.message).not.toContain('s3cr3t');
  });

  // PutRule is an upsert and raises no collision; the one "already exists" a
  // create can meet is the targets step's, after the rule was made. The wrap
  // restates it, and its auxiliary mark keeps it from reading as the rule's own
  // name collision (#3826).
  it('restates an "already exists" from PutTargets, still not the rule\'s collision', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'DescribeRuleCommand':
          throw notFound();
        case 'PutRuleCommand':
          return { RuleArn: ARN };
        case 'PutTargetsCommand':
          throw Object.assign(new Error('Target t1 already exists in account 111122223333'), {
            name: 'ResourceAlreadyExistsException',
            $fault: 'client',
            $metadata: { httpStatusCode: 400 },
          });
        case 'ListTargetsByRuleCommand':
          return { Targets: [] };
        default:
          return {};
      }
    });

    const failure = await caught(
      provider.create('Rule', TYPE, { ...PROPS, Targets: TARGETS }, { maskSecrets: mask })
    );

    expect(failure.message).toBe(
      `Failed to create EventBridge rule Rule: ResourceAlreadyExistsException. ${VERBOSE_POINTER} AWS reports that it already exists.`
    );
    expect(failure.message).not.toContain('111122223333');
    expect(isNameCollisionErrorFrom(failure, 'Rule')).toBe(false);
  });

  // The #5161 leak shape: the targets step failed after PutRule made the rule,
  // and the cleanup's DeleteRule is denied. The warning names the class, the
  // wrap keeps the created-before-failure mark for the failed-CREATE journal.
  it('a denied cleanup after PutRule is withheld at warn, the created mark kept', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'DescribeRuleCommand':
          throw notFound();
        case 'PutRuleCommand':
          return { RuleArn: ARN };
        case 'ListTargetsByRuleCommand':
          return { Targets: [] };
        default:
          throw denied();
      }
    });

    const failure = await caught(
      provider.create('Rule', TYPE, { ...PROPS, Targets: TARGETS }, { maskSecrets: mask })
    );

    expect(failure.message).toBe(
      `Failed to create EventBridge rule Rule: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect((failure.cause as Error).message).toBe(DENIED);
    expect(hasRedactedCause(failure)).toBe(true);
    expect(createdBeforeFailure(failure, 'Rule', TYPE)).toBe(ARN);
    const cleanupWarn = warnLines().find((w) => w.startsWith('Failed to clean up'));
    expect(cleanupWarn).toBeDefined();
    expect(cleanupWarn).toContain(
      `Failed to clean up partially-created EventBridge rule Rule (my-rule): AccessDeniedException. ${VERBOSE_POINTER} Manual deletion may be required before the next deploy`
    );
    expect(cleanupWarn).not.toContain('not authorized');
    expect(cleanupWarn).not.toContain('assumed-role');
    expect(debugLines()).toContain(
      `Failed to clean up partially-created EventBridge rule Rule (my-rule): ${mask(DENIED)}`
    );
    expect([...warnLines(), ...debugLines()].join('\n')).not.toContain('s3cr3t');
  });

  it('a cdkd-authored cleanup failure keeps its text at warn', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'DescribeRuleCommand':
          throw notFound();
        case 'PutRuleCommand':
          return { RuleArn: ARN };
        case 'ListTargetsByRuleCommand':
          throw new Error('socket hang up');
        default:
          throw denied();
      }
    });

    await caught(provider.create('Rule', TYPE, { ...PROPS, Targets: TARGETS }));

    const cleanupWarn = warnLines().find((w) => w.startsWith('Failed to clean up'));
    expect(cleanupWarn).toContain(
      'Failed to clean up partially-created EventBridge rule Rule (my-rule): socket hang up. Manual deletion may be required before the next deploy'
    );
  });

  // A refused DeleteRule after the targets were removed keeps its delete-started
  // mark through the class-only wrap (go-to-k/cdkd#4946).
  it('a denied DeleteRule after RemoveTargets is withheld, delete-started kept', async () => {
    mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
      switch (cmd.constructor.name) {
        case 'ListTargetsByRuleCommand':
          return { Targets: [{ Id: 't1' }] };
        case 'RemoveTargetsCommand':
          return {};
        default:
          throw denied();
      }
    });

    const failure = await caught(
      provider.delete('Rule', ARN, TYPE, undefined, { maskSecrets: mask })
    );

    expect(failure.message).toBe(
      `Failed to delete EventBridge rule Rule: AccessDeniedException. ${VERBOSE_POINTER}`
    );
    expect(isDeleteStarted(failure)).toBe(true);
    expect(hasRedactedCause(failure)).toBe(true);
  });
});
