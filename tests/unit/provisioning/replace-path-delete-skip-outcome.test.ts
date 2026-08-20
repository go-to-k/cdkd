import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #1778 class 2: the four `update()` implementations that REPLACE a
 * resource by pairing `create()` and `delete()` used to discard the delete's
 * `ResourceDeleteResult`. A skip does not throw, so it slipped past the
 * `catch` beside it — the one path that would have told the user the old
 * resource is still there.
 *
 * The consequence differs by ORDERING, so the assertions do too:
 *
 * - create-then-delete (ACM certificate, IAM managed policy, IAM role): the
 *   new resource already exists, so the replacement cannot be aborted. The
 *   requirement is that the user is TOLD, in the same orphan wording the
 *   failure arm uses.
 * - delete-then-create (SNS subscription): the old subscription was NOT
 *   destroyed, so the replacement is ABORTED rather than creating a second
 *   live subscription that duplicates every delivery.
 *
 * Every case has an INVERTED CONTROL in which the inner delete succeeds and
 * the replacement completes normally, so a test that passes because the
 * replacement path was never reached fails instead.
 *
 * All four are LATENT today — none of these providers has a skip arm — so the
 * skip is constructed by mocking the provider's own `delete`.
 */

const warnSpy = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

const stubClient = vi.hoisted(
  () => () => ({ send, config: { region: () => Promise.resolve('us-east-1') } })
);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    acm: stubClient(),
    iam: stubClient(),
    sns: stubClient(),
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: warnSpy,
      error: vi.fn(),
    }),
  };
});

import { ACMCertificateProvider } from '../../../src/provisioning/providers/acm-certificate-provider.js';
import { IAMManagedPolicyProvider } from '../../../src/provisioning/providers/iam-managed-policy-provider.js';
import { IAMRoleProvider } from '../../../src/provisioning/providers/iam-role-provider.js';
import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
  isThrottlingError,
} from '../../../src/deployment/retryable-errors.js';
import type { ResourceProvider } from '../../../src/types/resource.js';

const SKIP_REASON = 'malformed physicalId in state — no delete issued';

/** Stub `create()` so the replacement path never reaches AWS. */
function stubCreate(provider: ResourceProvider, physicalId: string): void {
  vi.spyOn(provider, 'create').mockResolvedValue({ physicalId, attributes: {} });
}

function warnings(): string[] {
  return warnSpy.mock.calls.map((call) => String(call[0]));
}

describe('create-then-delete REPLACE paths announce a skipped delete (issue #1778)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    send.mockReset();
  });

  const cases: Array<{
    name: string;
    build: () => ResourceProvider;
    resourceType: string;
    oldPhysicalId: string;
    newPhysicalId: string;
    properties: Record<string, unknown>;
    previousProperties: Record<string, unknown>;
    /** Substring naming the orphan risk, shared with the existing catch arm. */
    orphanWording: string;
  }> = [
    {
      name: 'AWS::CertificateManager::Certificate',
      build: () => new ACMCertificateProvider(),
      resourceType: 'AWS::CertificateManager::Certificate',
      oldPhysicalId: 'arn:aws:acm:us-east-1:123456789012:certificate/old',
      newPhysicalId: 'arn:aws:acm:us-east-1:123456789012:certificate/new',
      properties: { DomainName: 'new.example.com', ValidationMethod: 'DNS' },
      previousProperties: { DomainName: 'old.example.com', ValidationMethod: 'DNS' },
      orphanWording: 'The old certificate may be orphaned',
    },
    {
      name: 'AWS::IAM::ManagedPolicy',
      build: () => new IAMManagedPolicyProvider(),
      resourceType: 'AWS::IAM::ManagedPolicy',
      oldPhysicalId: 'arn:aws:iam::123456789012:policy/OldPolicy',
      newPhysicalId: 'arn:aws:iam::123456789012:policy/NewPolicy',
      properties: { ManagedPolicyName: 'NewPolicy' },
      previousProperties: { ManagedPolicyName: 'OldPolicy' },
      orphanWording: 'The old policy may be orphaned',
    },
    {
      name: 'AWS::IAM::Role',
      build: () => new IAMRoleProvider(),
      resourceType: 'AWS::IAM::Role',
      oldPhysicalId: 'OldRole',
      newPhysicalId: 'NewRole',
      properties: { RoleName: 'NewRole' },
      previousProperties: { RoleName: 'OldRole' },
      orphanWording: 'The old role may be orphaned',
    },
  ];

  for (const c of cases) {
    it(`${c.name}: a skipped delete warns that the old resource may be orphaned`, async () => {
      const provider = c.build();
      stubCreate(provider, c.newPhysicalId);
      const deleteSpy = vi
        .spyOn(provider, 'delete')
        .mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

      const result = await provider.update(
        'MyResource',
        c.oldPhysicalId,
        c.resourceType,
        c.properties,
        c.previousProperties
      );

      // The replacement itself still completes — the new resource exists.
      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(c.newPhysicalId);
      expect(deleteSpy).toHaveBeenCalledTimes(1);

      // ...and the user is TOLD, with the cause and the orphan risk.
      const orphanWarnings = warnings().filter((m) => m.includes(c.orphanWording));
      expect(orphanWarnings).toHaveLength(1);
      expect(orphanWarnings[0]).toContain(SKIP_REASON);
      expect(orphanWarnings[0]).toContain(c.oldPhysicalId);
    });

    it(`${c.name}: INVERTED CONTROL — a successful delete replaces with no orphan warning`, async () => {
      const provider = c.build();
      stubCreate(provider, c.newPhysicalId);
      const deleteSpy = vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

      const result = await provider.update(
        'MyResource',
        c.oldPhysicalId,
        c.resourceType,
        c.properties,
        c.previousProperties
      );

      expect(result.wasReplaced).toBe(true);
      expect(result.physicalId).toBe(c.newPhysicalId);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(warnings().filter((m) => m.includes(c.orphanWording))).toHaveLength(0);
    });

    it(`${c.name}: an explicit 'deleted' outcome is not mistaken for a skip`, async () => {
      const provider = c.build();
      stubCreate(provider, c.newPhysicalId);
      const deleteSpy = vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'deleted' });

      const result = await provider.update(
        'MyResource',
        c.oldPhysicalId,
        c.resourceType,
        c.properties,
        c.previousProperties
      );

      // Parity with the siblings: prove the replacement branch was ENTERED,
      // so the zero-warning assertion cannot pass vacuously.
      expect(result.wasReplaced).toBe(true);
      expect(deleteSpy).toHaveBeenCalledTimes(1);
      expect(warnings().filter((m) => m.includes(c.orphanWording))).toHaveLength(0);
    });
  }
});

describe('SNS subscription delete-then-create REPLACE aborts on a skipped delete (issue #1778)', () => {
  const TOPIC = 'arn:aws:sns:us-east-1:123456789012:MyTopic';
  const OLD_ARN = `${TOPIC}:11111111-1111-1111-1111-111111111111`;
  const NEW_ARN = `${TOPIC}:22222222-2222-2222-2222-222222222222`;
  const PROPS = { TopicArn: TOPIC, Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-east-1:1:q' };

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    send.mockReset();
  });

  it('throws instead of creating a second live subscription', async () => {
    const provider = new SNSSubscriptionProvider();
    const createSpy = vi.spyOn(provider, 'create');
    vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

    // Matched on the MESSAGE, not only the class: `createSpy` calls through,
    // so a mutation that let the create run would reject with the same
    // `ProvisioningError` class from the real `create()` and pass a
    // class-only assertion for the wrong reason.
    await expect(
      provider.update('MySub', OLD_ARN, 'AWS::SNS::Subscription', PROPS, PROPS)
    ).rejects.toThrow(/deliver every message twice/);

    // The abort is what prevents the duplicate: no create was issued.
    expect(createSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('the error names the old subscription and the duplicate-delivery consequence, and points at both repairs', async () => {
    const provider = new SNSSubscriptionProvider();
    vi.spyOn(provider, 'create').mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });
    vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

    const error = await provider
      .update('MySub', OLD_ARN, 'AWS::SNS::Subscription', PROPS, PROPS)
      .then(
        () => undefined,
        (err: unknown) => err
      );

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).toContain('MySub');
    expect(message).toContain('deliver every message twice');
    // The skip family shipping today is STATE-borne (a malformed composite
    // physicalId), so deleting the AWS resource repairs nothing on its own —
    // both repairs have to be named.
    expect(message).toContain('state record');
    expect(message).toContain('remove the old subscription in AWS');

    // Neither the provider-supplied reason NOR the state-borne physicalId is
    // interpolated into the thrown message — both are arbitrary text that
    // `retryable-errors.ts`'s substring classifier would read (see the
    // retryable-classification suite below). Both are still REPORTED: the warn
    // line carries them, and the physicalId is on the error's structured field.
    expect(message).not.toContain(SKIP_REASON);
    expect(message).not.toContain(OLD_ARN);
    expect((error as ProvisioningError).physicalId).toBe(OLD_ARN);
    expect(warnings().some((m) => m.includes(SKIP_REASON) && m.includes(OLD_ARN))).toBe(true);
  });

  it('a PendingConfirmation-adopted subscription still replaces normally', async () => {
    // The two pending-confirmation arms in `delete()` are CFn-parity
    // delete-SUCCESS, NOT skips (see `logPendingConfirmationSkip`). Nothing
    // pinned the UPDATE consequence of that decision, so a future #1770-style
    // conversion could flip those arms and arm the abort for every deploy of a
    // subscription adopted via `cdkd import --resource <id>=PendingConfirmation`
    // — permanently, with no flag to force it. This is the fence: `delete()` is
    // deliberately NOT mocked here, so the real arm runs.
    const provider = new SNSSubscriptionProvider();
    const createSpy = vi
      .spyOn(provider, 'create')
      .mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });

    const result = await provider.update(
      'MySub',
      'PendingConfirmation',
      'AWS::SNS::Subscription',
      PROPS,
      PROPS
    );

    expect(result).toEqual({ physicalId: NEW_ARN, wasReplaced: true, attributes: {} });
    expect(createSpy).toHaveBeenCalledTimes(1);
    // No Unsubscribe was issued — the arm returns before the AWS call...
    expect(send).not.toHaveBeenCalled();
    // ...and it is a delete-SUCCESS, so no replacement abort fired.
    expect(warnings().some((m) => m.includes('Cannot replace SNS subscription'))).toBe(false);
  });

  it('INVERTED CONTROL — a successful delete replaces the subscription normally', async () => {
    const provider = new SNSSubscriptionProvider();
    const createSpy = vi
      .spyOn(provider, 'create')
      .mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });
    vi.spyOn(provider, 'delete').mockResolvedValue(undefined);

    const result = await provider.update(
      'MySub',
      OLD_ARN,
      'AWS::SNS::Subscription',
      PROPS,
      PROPS
    );

    expect(result).toEqual({ physicalId: NEW_ARN, wasReplaced: true, attributes: {} });
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  /**
   * The rollback executor wraps `update()` in `withRetry`, whose default
   * `isRetryable` is `isRetryableTransientError` — a SUBSTRING match against
   * `RETRYABLE_ERROR_MESSAGE_PATTERNS`. A deterministic abort classified
   * retryable there burns the whole backoff schedule (~47s) before a certain
   * failure, so the provider-supplied `reason` must never reach the thrown
   * message. These probes feed reasons built from real patterns in that table.
   */
  it.each([
    ['does not exist', 'the recorded subscription does not exist in state'],
    ['Rate exceeded', 'Rate exceeded while decoding the recorded physicalId'],
    ['because it is in use', 'not deleted because it is in use by another record'],
    ['DependencyViolation', 'DependencyViolation on the recorded physicalId'],
  ])('a hostile %s reason does not make the abort look retryable', async (_pattern, reason) => {
    const provider = new SNSSubscriptionProvider();
    vi.spyOn(provider, 'create').mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });
    vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'skipped', reason });

    const error = await provider
      .update('MySub', OLD_ARN, 'AWS::SNS::Subscription', PROPS, PROPS)
      .then(
        () => undefined,
        (err: unknown) => err
      );

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).not.toContain(reason);
    expect(isThrottlingError(error)).toBe(false);
    expect(isRetryableTransientError(error, message)).toBe(false);
    // ...and the cause is still reported, on the log line.
    expect(warnings().some((m) => m.includes(reason))).toBe(true);
  });

  /**
   * The message discipline narrows the substring surface; the MARKER closes
   * it. `MyDependencyViolationSub` is an ordinary composite CDK logical id and
   * carries `DependencyViolation`, a real entry in the retryable table — and
   * the logical id is the one value the message deliberately keeps, so without
   * `markNonRetryable` this exact abort classifies as transient.
   */
  it.each([
    ['MyDependencyViolationSub', 'a composite logical id containing a pattern'],
    ['DependencyViolation', 'a logical id that IS a pattern'],
  ])('%s (%s) still classifies non-retryable', async (hostileLogicalId) => {
    const provider = new SNSSubscriptionProvider();
    vi.spyOn(provider, 'create').mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });
    vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

    const error = await provider
      .update(hostileLogicalId, OLD_ARN, 'AWS::SNS::Subscription', PROPS, PROPS)
      .then(
        () => undefined,
        (err: unknown) => err
      );

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    // The pattern IS in the message — the marker is what makes it terminal.
    expect(message).toContain(hostileLogicalId);
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isRetryableTransientError(error, message)).toBe(false);
  });

  /**
   * The `physicalId` is the SAME hazard as the reason and a worse one: it is
   * state-borne and arbitrary (`cdkd import --resource <id>=<anything>`), and
   * the only skip family that reaches this path today is literally "malformed
   * physicalId in state" — so the string most likely to be junk is the one the
   * classifier would have read.
   */
  it.each([
    ['does not exist', 'arn:aws:sns:us-east-1:123456789012:MyTopic:does not exist'],
    ['Rate exceeded', 'Rate exceeded'],
    ['DependencyViolation', 'DependencyViolation'],
  ])('a hostile %s physicalId does not make the abort look retryable', async (_p, hostileId) => {
    const provider = new SNSSubscriptionProvider();
    vi.spyOn(provider, 'create').mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });
    vi.spyOn(provider, 'delete').mockResolvedValue({ outcome: 'skipped', reason: SKIP_REASON });

    const error = await provider
      .update('MySub', hostileId, 'AWS::SNS::Subscription', PROPS, PROPS)
      .then(
        () => undefined,
        (err: unknown) => err
      );

    expect(error).toBeInstanceOf(ProvisioningError);
    const message = (error as Error).message;
    expect(message).not.toContain(hostileId);
    expect(isThrottlingError(error)).toBe(false);
    expect(isRetryableTransientError(error, message)).toBe(false);
    // ...and the id is still reported, on the log line and on the error field.
    expect((error as ProvisioningError).physicalId).toBe(hostileId);
    expect(warnings().some((m) => m.includes(hostileId))).toBe(true);
  });

  /**
   * INVERTED by issue [#1967](https://github.com/go-to-k/cdkd/issues/1967).
   * This case used to assert the opposite — "a FAILED delete still converges
   * (pre-existing warn-and-continue is unchanged)" — because #1778 deliberately
   * scoped its abort to the SKIP arm and left the THROW arm alone.
   *
   * That asymmetry was the defect: a thrown delete fell through to `create()`
   * and produced exactly the duplicate the skip arm exists to prevent, and it
   * is the arm that actually fires in the field (a real `Unsubscribe` failure
   * is wrapped in a `ProvisioningError`, while the skip family still has no
   * producer in this provider). One rule now covers both arms — cdkd creates
   * the replacement only when the old subscription is PROVEN gone — so the
   * assertion is that `create()` was NOT reached.
   */
  it('a THROWN delete aborts too, without creating the duplicate (issue #1967)', async () => {
    const provider = new SNSSubscriptionProvider();
    const createSpy = vi
      .spyOn(provider, 'create')
      .mockResolvedValue({ physicalId: NEW_ARN, attributes: {} });
    vi.spyOn(provider, 'delete').mockRejectedValue(
      new ProvisioningError(
        'Failed to delete SNS subscription MySub: boom',
        'AWS::SNS::Subscription',
        'MySub'
      )
    );

    const error = await provider
      .update('MySub', OLD_ARN, 'AWS::SNS::Subscription', PROPS, PROPS)
      .then(
        () => undefined,
        (err: unknown) => err
      );

    expect(error).toBeInstanceOf(ProvisioningError);
    expect(createSpy).not.toHaveBeenCalled();
    // The AWS cause is still diagnosable, on its own warn line.
    expect(warnings().some((m) => m.includes('Failed to delete old subscription'))).toBe(true);
    // ...and the abort is terminal for the rollback callers that wrap
    // `update()` in `withRetry`, exactly as the skip arm's is.
    expect(isMarkedNonRetryable(error)).toBe(true);
    expect(isRetryableTransientError(error, (error as Error).message)).toBe(false);
  });
});
