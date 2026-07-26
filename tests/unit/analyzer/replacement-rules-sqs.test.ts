import { describe, it, expect } from 'vite-plus/test';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';

/**
 * Pin for the AWS::SQS::Queue classification (issue #1237).
 *
 * `ContentBasedDeduplication` is FIFO-only but mutable in place: CFn
 * documents it as "Update requires: No interruption", the registry schema's
 * createOnlyProperties is only [FifoQueue, QueueName], and a live
 * `SetQueueAttributes` flips it on an existing FIFO queue (live-verified
 * 2026-07-27). It was previously misclassified as replacement-requiring,
 * which would DELETE the queue (message loss) on a toggle and made the
 * provider's #1160 removal reset unreachable via a plain deploy. This pin
 * keeps the rule from regressing; the `fifo-sqs-event-source` integ's
 * CDKD_TEST_REMOVAL phase additionally asserts the queue's
 * CreatedTimestamp survives a real CBD removal.
 */
describe('ReplacementRulesRegistry — AWS::SQS::Queue', () => {
  const registry = new ReplacementRulesRegistry();

  it('classifies ContentBasedDeduplication as an in-place UPDATE (no replacement)', () => {
    expect(
      registry.requiresReplacement('AWS::SQS::Queue', 'ContentBasedDeduplication', true, false)
    ).toBe(false);
  });

  it('pins ContentBasedDeduplication as explicitly classified (fallback never overrides)', () => {
    // isClassified must be true so the DescribeType createOnlyProperties
    // fallback in the diff calculator can never override this deliberate
    // updateable classification.
    expect(registry.isClassified('AWS::SQS::Queue', 'ContentBasedDeduplication')).toBe(true);
  });

  it.each(['QueueName', 'FifoQueue'])(
    'still requires replacement when %s changes',
    (prop) => {
      expect(registry.requiresReplacement('AWS::SQS::Queue', prop, 'old', 'new')).toBe(true);
    }
  );

  it.each([
    'DelaySeconds',
    'MaximumMessageSize',
    'MessageRetentionPeriod',
    'ReceiveMessageWaitTimeSeconds',
    'VisibilityTimeout',
    'RedrivePolicy',
    'Tags',
  ])('does NOT require replacement when %s changes', (prop) => {
    expect(registry.requiresReplacement('AWS::SQS::Queue', prop, 'old', 'new')).toBe(false);
  });
});
