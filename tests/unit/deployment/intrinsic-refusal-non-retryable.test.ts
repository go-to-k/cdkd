/**
 * Issue [#1874](https://github.com/go-to-k/cdkd/issues/1874) review item 2:
 * the `Fn::Sub`-reachable `IntrinsicResolutionRefusalError` throw sites are
 * `markNonRetryable` too, not just `resolveSplit`'s pair.
 *
 * Three of the four are terminal by exactly the same argument as
 * `resolveSplit`'s: each decides from an input a retry cannot change, and each
 * interpolates the template-controlled `logicalId` into its message — which
 * the SUBSTRING-matching retry classifiers can read as transient (issue
 * [#1838](https://github.com/go-to-k/cdkd/issues/1838); `DependencyViolation`
 * is a whitespace-free entry in the table — the only one until issue #2116
 * added the name-cooldown error codes — so an ordinary composite CDK id is
 * enough). Reachability is real: a child `DeployEngine.deploy()` re-throws
 * through `NestedStackProvider.create`, which the parent wraps in `withRetry`.
 *
 * The FOURTH — the #1730 fabricated-account guard — is deliberately left
 * unmarked, which is why the marking is at each `throw` rather than in the
 * class constructor. That is fenced at the SITE (drive the real refusal with a
 * rejecting STS and assert it is NOT marked), not merely at the constructor: a
 * constructor-only assertion stays green when a marker is added at the throw,
 * so it would pin the mechanism while leaving the decision unguarded.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import {
  isMarkedNonRetryable,
  isRetryableTransientError,
} from '../../../src/deployment/retryable-errors.js';
import { IntrinsicResolutionRefusalError } from '../../../src/utils/error-handler.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

// STS is the knob for the #1730 arm: a REJECTING `GetCallerIdentity` is what
// makes `getAccountInfo` fabricate an account id, which is the only way to
// reach `constructGuardedAttribute`'s refusal.
const stsSend = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    Account: '123456789012',
    Arn: 'arn:aws:iam::123456789012:user/test',
  })
);

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: stsSend },
    ec2: { send: vi.fn() },
  }),
}));

// A logical id carrying `DependencyViolation` — a whitespace-free entry in
// RETRYABLE_ERROR_MESSAGE_PATTERNS (the only one until issue #2116 added the
// name-cooldown error codes), and therefore one an ordinary composite CDK
// construct id can reach. Every refusal below interpolates it.
const LOGICAL_ID = 'MyDependencyViolationHandler';

const mkContext = (
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown> = {}
): ResolverContext => ({
  template: {
    Resources: { [LOGICAL_ID]: { Type: resourceType, Properties: {} } },
  } as unknown as CloudFormationTemplate,
  resources: {
    [LOGICAL_ID]: { physicalId, resourceType, properties: {}, attributes, dependencies: [] },
  },
});

const getAttError = async (
  resolver: IntrinsicFunctionResolver,
  attributeName: string,
  context: ResolverContext
): Promise<Error> => {
  try {
    await resolver.resolve({ 'Fn::GetAtt': [LOGICAL_ID, attributeName] }, context);
  } catch (error) {
    return error as Error;
  }
  throw new Error(`expected Fn::GetAtt [${LOGICAL_ID}, ${attributeName}] to throw`);
};

const expectTerminal = (error: Error): void => {
  expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
  // The message really does carry a retryable substring...
  expect(error.message).toContain('DependencyViolation');
  // ...so the marker is what has to win. Assert the OUTCOME, not the wording.
  expect(isMarkedNonRetryable(error)).toBe(true);
  expect(isRetryableTransientError(error, error.message)).toBe(false);
};

describe('IntrinsicResolutionRefusalError throw sites are non-retryable (#1874 review)', () => {
  beforeEach(() => {
    stsSend.mockReset();
    stsSend.mockResolvedValue({
      Account: '123456789012',
      Arn: 'arn:aws:iam::123456789012:user/test',
    });
    resetAccountInfoCache();
  });

  it('guardedPhysicalIdFallback ARN-shape hard-fail (#1103) is terminal', async () => {
    // Decided from the attribute name's suffix, the ALREADY-CREATED resource's
    // physical id, and the static "this type is not enriched" fact. None of
    // the three changes between retries.
    const resolver = new IntrinsicFunctionResolver();
    const error = await getAttError(
      resolver,
      'WidgetArn',
      mkContext('AWS::Example::Widget', 'my-widget-name')
    );
    expect(error.message).toContain('is not an ARN');
    expectTerminal(error);
  });

  it('guardedPhysicalIdFallback URL-shape hard-fail is terminal too', async () => {
    const resolver = new IntrinsicFunctionResolver();
    const error = await getAttError(
      resolver,
      'WidgetUrl',
      mkContext('AWS::Example::Widget', 'my-widget-name')
    );
    expect(error.message).toContain('is not a URL');
    expectTerminal(error);
  });

  it('the --strict-getatt rejection is terminal', async () => {
    // Decided from a CLI FLAG plus the same static enrichment fact. A flag
    // cannot change mid-deploy, so no retry can take a different branch.
    const resolver = new IntrinsicFunctionResolver(undefined, { strictGetAtt: true });
    const error = await getAttError(
      resolver,
      'SomeAttribute',
      mkContext('AWS::Example::Widget', 'my-widget-name')
    );
    expect(error.message).toContain('--strict-getatt');
    expectTerminal(error);
  });

  it('rejectPlaceholderArnAttribute (#1729) is terminal', async () => {
    // Decided from the PERSISTED state record, which no retry of this deploy
    // rewrites — the placeholder only heals on the resource's next in-place
    // update, i.e. a LATER deploy.
    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext('AWS::AppSync::DataSource', 'ds-physical-id', {
      DataSourceArn: 'arn:aws:appsync:*:*:apis/abc/datasources/ds',
    });
    const error = await getAttError(resolver, 'DataSourceArn', context);
    expect(error.message).toContain('is a placeholder');
    expectTerminal(error);
  });

  it('leaves the #1730 fabricated-account SITE unmarked, so it can still heal', async () => {
    // A SITE-level fence, not a constructor one. The earlier version of this
    // test constructed a bare `IntrinsicResolutionRefusalError` and asserted it
    // was unmarked, which pins only the CONSTRUCTOR: adding `markNonRetryable`
    // at the #1730 throw left it green, so the decision it claimed to guard was
    // unguarded. Driving the real refusal is what makes the probe discriminate.
    //
    // Reaching it needs a REJECTING STS (so `getAccountInfo` fabricates
    // `123456789012`) plus an attribute whose constructed value embeds that id.
    stsSend.mockRejectedValue(new Error('STS unreachable'));
    resetAccountInfoCache();

    const resolver = new IntrinsicFunctionResolver();
    const context = mkContext('AWS::SQS::Queue', 'https://sqs.us-east-1.amazonaws.com/1/q');
    const error = await getAttError(resolver, 'Arn', context);

    // It really is the #1730 refusal...
    expect(error).toBeInstanceOf(IntrinsicResolutionRefusalError);
    expect(error.message).toContain('STS did not report');
    // ...and it must stay RETRYABLE: `getAccountInfo` caches a fabricated
    // answer for only 10s precisely so a later attempt can heal. A
    // constructor-level marker (the `ResourceUpdateNotSupportedError` shape)
    // would wrongly make this terminal, which is why the marking is per-SITE.
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('still does not mark in the constructor (the mechanism behind the site split)', async () => {
    const bare = new IntrinsicResolutionRefusalError('a refusal that may heal');
    expect(isMarkedNonRetryable(bare)).toBe(false);
  });

  it('classifies EVERY refusal site in the resolver, so a new one cannot arrive unclassified', () => {
    // The behavioural cases above pin the sites that EXISTED when #1874 was
    // worked. They cannot fence a site added later — which is exactly what
    // happened: issue #1934's cross-account `Fn::GetStackOutput` refusal landed
    // marked, and this file (the repo's enumeration of the decision) stayed
    // green either way, so the marking was unfenced.
    //
    // A SOURCE-level enumeration is what generalises. Each site is either
    // marked or is a deliberate exception, and adding one without deciding
    // fails here rather than silently inheriting whichever answer the author
    // happened to type. Reading the source is the same technique
    // `outputs-diff.test.ts` uses to fence its mirrored deploy-engine
    // semantics.
    const source = readFileSync(
      new URL('../../../src/deployment/intrinsic-function-resolver.ts', import.meta.url),
      'utf8'
    );
    const lines = source.split('\n');

    // Matches the base class AND any SUBCLASS of it (issue #2133 review added
    // `CrossAccountSecretRefusalError` for the one permanent site). Naming the
    // base class alone let a site move into a subclass and silently leave this
    // census — which is the same "a new site arrives unclassified" hole the
    // census exists to close, arriving through the class name instead of
    // through a new `throw`.
    const REFUSAL_CONSTRUCTION = /new [A-Za-z]*RefusalError\(/;
    const marked: number[] = [];
    const unmarked: number[] = [];
    lines.forEach((line, i) => {
      if (!REFUSAL_CONSTRUCTION.test(line)) return;
      // `markNonRetryable(` sits on the `throw` line, i.e. immediately above a
      // wrapped construction, or on the SAME line for a one-liner.
      const previous = lines[i - 1] ?? '';
      if (line.includes('markNonRetryable(') || previous.includes('markNonRetryable(')) {
        marked.push(i + 1);
      } else {
        unmarked.push(i + 1);
      }
    });

    // A floor, so a regex that stops matching cannot pass vacuously.
    expect(marked.length).toBeGreaterThanOrEqual(6);

    // EXACTLY ONE deliberate exception: the #1730 fabricated-account guard,
    // whose behavioural fence is the test above. Identified by its message
    // rather than by a line number, which every edit above it would shift.
    expect(unmarked).toHaveLength(1);
    const exception = lines.slice(unmarked[0]! - 1, unmarked[0]! + 6).join('\n');
    expect(exception).toContain('STS did not report');
  });
});
