import { describe, it, expect, vi } from 'vite-plus/test';

const mockSend = vi.fn();
// `vi.mock` factories are hoisted above these declarations, and the logger
// factory builds its child logger EAGERLY (unlike the aws-clients factory,
// which only closes over `mockSend`), so `warn` must be hoisted with it.
const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

import {
  buildDeliveryStatusAttributeMap,
  normalizeDeliveryStatusProtocol,
} from '../../../src/provisioning/providers/sns-topic-provider.js';

const ROLE_A = 'arn:aws:iam::0:role/feedback-a';
const ROLE_B = 'arn:aws:iam::0:role/feedback-b';

/**
 * Issue #1529: `DeliveryStatusLogging` protocol canonicalization.
 *
 * Both halves live-verified 2026-08-11 against real AWS:
 *
 * 1. A CloudFormation template carrying the canonical `Protocol: http/s`
 *    (the value `sns.LoggingProtocol.HTTP` and the CFn schema's allowed-value
 *    list both spell) produced `HTTPSuccessFeedbackRoleArn` /
 *    `HTTPSuccessFeedbackSampleRate` / `HTTPFailureFeedbackRoleArn` on the
 *    live topic. cdkd used to THROW on that spelling.
 * 2. `SetTopicAttributes` with `HTTPSSuccessFeedbackRoleArn` — the name cdkd
 *    used to emit for `Protocol: https` — is rejected with
 *    `InvalidParameter: Invalid parameter: AttributeName`. There is no
 *    HTTPS-prefixed attribute; `HTTP` is the sole HTTP-family prefix.
 */
describe('normalizeDeliveryStatusProtocol (issue #1529)', () => {
  it('accepts the canonical CDK L2 / CFn spelling http/s', () => {
    // sns.LoggingProtocol.HTTP === 'http/s'. This threw before the fix, so
    // every canonical CDK template using HTTP delivery-status logging was
    // undeployable.
    expect(normalizeDeliveryStatusProtocol('http/s')).toBe('HTTP');
  });

  it('folds every HTTP-family spelling onto the single HTTP prefix', () => {
    for (const spelling of ['http/s', 'HTTP/S', 'Http/S', 'http', 'HTTP', 'https', 'HTTPS']) {
      expect(normalizeDeliveryStatusProtocol(spelling), spelling).toBe('HTTP');
    }
  });

  it('never returns an HTTPS prefix for any input (the name AWS rejects)', () => {
    const inputs = ['http/s', 'http', 'https', 'HTTPS', 'sqs', 'lambda', 'firehose', 'application'];
    for (const input of inputs) {
      expect(normalizeDeliveryStatusProtocol(input), input).not.toBe('HTTPS');
    }
  });

  it('still canonicalizes the non-HTTP protocols', () => {
    expect(normalizeDeliveryStatusProtocol('sqs')).toBe('SQS');
    expect(normalizeDeliveryStatusProtocol('Lambda')).toBe('Lambda');
    expect(normalizeDeliveryStatusProtocol('FIREHOSE')).toBe('Firehose');
    expect(normalizeDeliveryStatusProtocol('application')).toBe('Application');
  });

  it('still rejects genuinely unknown protocols and non-strings', () => {
    expect(normalizeDeliveryStatusProtocol('smtp')).toBeUndefined();
    expect(normalizeDeliveryStatusProtocol('http/')).toBeUndefined();
    expect(normalizeDeliveryStatusProtocol('')).toBeUndefined();
    expect(normalizeDeliveryStatusProtocol(42)).toBeUndefined();
    expect(normalizeDeliveryStatusProtocol(undefined)).toBeUndefined();
  });
});

describe('buildDeliveryStatusAttributeMap HTTP family (issue #1529)', () => {
  it('emits the live-verified HTTP attribute names for Protocol http/s', () => {
    const map = buildDeliveryStatusAttributeMap(
      [
        {
          Protocol: 'http/s',
          SuccessFeedbackRoleArn: ROLE_A,
          SuccessFeedbackSampleRate: 0,
          FailureFeedbackRoleArn: ROLE_B,
        },
      ],
      'L',
      'throw'
    );

    // Exactly the three names the live CFn probe produced. The sample rate
    // is 0 to keep the `!= null` presence gate (not truthiness) covered.
    expect([...map.entries()]).toEqual([
      ['HTTPSuccessFeedbackRoleArn', ROLE_A],
      ['HTTPSuccessFeedbackSampleRate', '0'],
      ['HTTPFailureFeedbackRoleArn', ROLE_B],
    ]);
  });

  it('does not throw on http/s in throw mode', () => {
    // The pre-fix failure: `unsupported DeliveryStatusLogging protocol
    // "http/s"` at create/update time.
    expect(() =>
      buildDeliveryStatusAttributeMap([{ Protocol: 'http/s' }], 'L', 'throw')
    ).not.toThrow();
  });

  it('names the accepted template spellings — not the attribute prefixes — when rejecting', () => {
    // Listing the prefixes would tell the user to write `HTTP`, which the
    // CFn schema does not accept.
    expect(() =>
      buildDeliveryStatusAttributeMap([{ Protocol: 'smtp' }], 'MyTopic', 'throw')
    ).toThrow(/Expected one of application, firehose, http\/s, lambda, sqs \(case-insensitive\)/);
  });

  it('warns when two entries collapse onto the same prefix, and lets the last win', () => {
    warn.mockClear();

    const map = buildDeliveryStatusAttributeMap(
      [
        { Protocol: 'http/s', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'https', SuccessFeedbackRoleArn: ROLE_B },
      ],
      'MyTopic',
      'throw'
    );

    // AWS has one attribute set per prefix, so the collision is real and
    // last-one-wins. Only reachable since #1529 folded the HTTP family.
    expect([...map.entries()]).toEqual([['HTTPSuccessFeedbackRoleArn', ROLE_B]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('more than one entry');
    expect(warn.mock.calls[0]?.[0]).toContain('"HTTP"');
    expect(warn.mock.calls[0]?.[0]).toContain('MyTopic');
  });

  it('does not warn on the PREVIOUS side, where the advice is unactionable', () => {
    warn.mockClear();

    // Skip mode is the cdkd-STATE side. A duplicate recorded there cannot be
    // fixed by editing the template, so warning on every update would be
    // pure noise — same rationale as the guard-the-desired-side-only rule.
    const map = buildDeliveryStatusAttributeMap(
      [
        { Protocol: 'http/s', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'https', SuccessFeedbackRoleArn: ROLE_B },
      ],
      'MyTopic',
      'skip'
    );

    // The collapse itself still happens — only the warning is suppressed.
    expect([...map.entries()]).toEqual([['HTTPSuccessFeedbackRoleArn', ROLE_B]]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn for distinct protocols', () => {
    warn.mockClear();

    buildDeliveryStatusAttributeMap(
      [
        { Protocol: 'http/s', SuccessFeedbackRoleArn: ROLE_A },
        { Protocol: 'sqs', SuccessFeedbackRoleArn: ROLE_B },
      ],
      'MyTopic',
      'throw'
    );

    expect(warn).not.toHaveBeenCalled();
  });
});
