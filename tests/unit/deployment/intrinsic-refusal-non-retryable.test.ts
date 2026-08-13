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
 * is the table's only whitespace-free entry, so an ordinary composite CDK id
 * is enough). Reachability is real: a child `DeployEngine.deploy()` re-throws
 * through `NestedStackProvider.create`, which the parent wraps in `withRetry`.
 *
 * The FOURTH — the #1730 fabricated-account guard — is deliberately left
 * unmarked, which is why the marking is at each `throw` rather than in the
 * class constructor. The last test pins that constructor decision.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
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

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
    ec2: { send: vi.fn() },
  }),
}));

// A logical id carrying `DependencyViolation` — the only whitespace-free entry
// in RETRYABLE_ERROR_MESSAGE_PATTERNS, and therefore the one an ordinary
// composite CDK construct id can reach. Every refusal below interpolates it.
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

  it('does NOT mark in the constructor, so the #1730 time-dependent arm stays retryable', async () => {
    // The fabricated-account guard is the one site that can genuinely heal:
    // `getAccountInfo` caches a fabricated answer for only 10s precisely so a
    // later attempt can succeed. A constructor-level marker (the
    // `ResourceUpdateNotSupportedError` shape) would wrongly make it terminal,
    // so the split is per-SITE and this pins it.
    const bare = new IntrinsicResolutionRefusalError('a refusal that may heal');
    expect(isMarkedNonRetryable(bare)).toBe(false);
  });
});
