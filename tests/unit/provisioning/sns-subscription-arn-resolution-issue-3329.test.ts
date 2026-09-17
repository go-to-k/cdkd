import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue [#3329](https://github.com/go-to-k/cdkd/issues/3329) — the RESOLVER
 * half of recording `AWS::SNS::Subscription`'s `Arn`.
 *
 * WHY THIS GOES THROUGH THE RESOLVER RATHER THAN ASSERTING THE ATTRIBUTE MAP,
 * which the provider's own suite already does. Both claims the change makes are
 * about what a cross-resource `Fn::GetAtt` SEES, and neither is observable from
 * the map:
 *
 *   - a create record now resolves from the CACHE rather than from
 *     `guardedPhysicalIdFallback`. The two differ where it matters:
 *     `--strict-getatt` THROWS on any fallback regardless of shape, so the
 *     cached path is the only one that answers under it;
 *   - the values this provider deliberately does NOT cache still reach that
 *     fallback and are still REFUSED loudly — an imported `PendingConfirmation`
 *     id, and a `Subscribe` response carrying the literal
 *     `pending confirmation`. A cache hit short-circuits the shape guard
 *     (`rejectPlaceholderArnAttribute` returns early: this type has no
 *     `REF_RETURNS_ARN_FROM_STATE` entry), so caching either would convert that
 *     refusal into a SILENT wrong value. Both review axes on
 *     go-to-k/cdkd#3355 measured that end to end before the shape test existed.
 *
 * The sibling `uncached-arn-attributes-issue-1824.test.ts` is the established
 * shape for this layer and says why the provider-level assertion alone is not
 * enough: the matrix critic binds the provider FILE, not a path.
 */

const { mockSnsSend } = vi.hoisted(() => ({ mockSnsSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sns: { send: mockSnsSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { SNSSubscriptionProvider } from '../../../src/provisioning/providers/sns-subscription-provider.js';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { ResolverContext } from '../../../src/deployment/intrinsic-function-resolver.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const TYPE = 'AWS::SNS::Subscription';
const TOPIC_ARN = 'arn:aws:sns:us-east-1:111122223333:my-topic';
const SUB_ARN = `${TOPIC_ARN}:8b2c9f1e-0000-4d3a-9c11-7f6e5d4c3b2a`;
const PROPS = {
  TopicArn: TOPIC_ARN,
  Protocol: 'sqs',
  Endpoint: 'arn:aws:sqs:us-east-1:111122223333:my-queue',
};

const mkContext = (physicalId: string, attributes: Record<string, unknown>): ResolverContext => {
  const template: CloudFormationTemplate = {
    Resources: { Sub: { Type: TYPE, Properties: {} } },
  };
  return {
    template,
    resources: {
      Sub: { physicalId, resourceType: TYPE, properties: {}, attributes, dependencies: [] },
    },
  };
};

describe('issue #3329 — SNS subscription Arn resolves from cache, and non-ARNs stay loud', () => {
  let resolver: IntrinsicFunctionResolver;

  beforeEach(() => {
    vi.clearAllMocks();
    // Drain any `*Once` queue so a primer cannot leak into a later test.
    mockSnsSend.mockReset();
    resolver = new IntrinsicFunctionResolver();
  });

  it('resolves Fn::GetAtt Arn from the create record', async () => {
    // NOT a discriminator on its own — see the case below. Kept as the
    // readable statement of the happy path; the mutation coverage is there.
    mockSnsSend.mockResolvedValueOnce({ SubscriptionArn: SUB_ARN });
    const result = await new SNSSubscriptionProvider().create('Sub', TYPE, PROPS);

    const context = mkContext(result.physicalId, result.attributes ?? {});
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Sub', 'Arn'] }, context)).resolves.toBe(SUB_ARN);
  });

  it('answers under --strict-getatt, which the fallback cannot', async () => {
    // THE DISCRIMINATOR, and the case above is not one on its own: this type's
    // physical id IS the subscription ARN, so `guardedPhysicalIdFallback`
    // returns the same string and the assertion above passes with the caching
    // REVERTED (measured — the first cut of this file had only that case and
    // stayed green under exactly that mutation).
    //
    // `--strict-getatt` throws on ANY fallback regardless of shape, so it is
    // the one observable difference between answering from the cache and
    // answering from the physical id — and it is the third edge the change
    // claims to close.
    mockSnsSend.mockResolvedValueOnce({ SubscriptionArn: SUB_ARN });
    const result = await new SNSSubscriptionProvider().create('Sub', TYPE, PROPS);
    const strict = new IntrinsicFunctionResolver(undefined, { strictGetAtt: true });

    const cached = mkContext(result.physicalId, result.attributes ?? {});
    await expect(strict.resolve({ 'Fn::GetAtt': ['Sub', 'Arn'] }, cached)).resolves.toBe(SUB_ARN);

    // The control: the SAME physical id with nothing cached is refused, which
    // is what the record looked like before this change and what a record
    // written by an older binary still looks like until its next replacement.
    const uncached = mkContext(result.physicalId, {});
    await expect(strict.resolve({ 'Fn::GetAtt': ['Sub', 'Arn'] }, uncached)).rejects.toThrow();
  });

  it('still resolves when nothing was cached — the fallback answers an ARN-shaped physicalId', async () => {
    // The pre-change behaviour, kept for the path where `Subscribe` returned no
    // ARN at all: the physical id is the constructed `<topicArn>:<logicalId>`,
    // which IS `arn:`-prefixed, so the guard passes it. This case is what makes
    // the one above a statement about the CACHE rather than about resolution in
    // general — both answer, and the difference is which layer did it.
    mockSnsSend.mockResolvedValueOnce({});
    const result = await new SNSSubscriptionProvider().create('Sub', TYPE, PROPS);

    expect(result.attributes).toEqual({});
    const context = mkContext(result.physicalId, result.attributes ?? {});
    await expect(resolver.resolve({ 'Fn::GetAtt': ['Sub', 'Arn'] }, context)).resolves.toBe(
      `${TOPIC_ARN}:Sub`
    );
  });

  it('REFUSES a "pending confirmation" response rather than serving it silently', async () => {
    // The defect review found: uncached this throws, cached it would be served.
    // Driving it through the resolver is the only place that difference shows.
    mockSnsSend.mockResolvedValueOnce({ SubscriptionArn: 'pending confirmation' });
    const result = await new SNSSubscriptionProvider().create('Sub', TYPE, PROPS);

    expect(result.attributes).toEqual({});
    const context = mkContext(result.physicalId, result.attributes ?? {});
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Sub', 'Arn'] }, context)
    ).rejects.toThrow(/is not an ARN/);
  });

  it('REFUSES an imported PendingConfirmation id rather than serving it silently', async () => {
    const imported = await new SNSSubscriptionProvider().import({
      logicalId: 'Sub',
      resourceType: TYPE,
      stackName: 'TestStack',
      region: 'us-east-1',
      properties: PROPS,
      knownPhysicalId: 'PendingConfirmation',
    });

    expect(imported?.attributes).toEqual({});
    const context = mkContext(imported!.physicalId, imported!.attributes ?? {});
    await expect(
      resolver.resolve({ 'Fn::GetAtt': ['Sub', 'Arn'] }, context)
    ).rejects.toThrow(/is not an ARN/);
  });
});
