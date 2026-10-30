import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * go-to-k/cdkd#2319: `Fn::GetAZs`'s describe failure is thrown into the
 * resource's create, and that message is persisted to
 * `deployments/{runId}.jsonl`; EC2 words an `UnauthorizedOperation` with the
 * caller's ARN. The refusal names the class plus the `--verbose` pointer, AWS's
 * text goes to `debug`, and the error rides as `cause`, stamped so the retry
 * classifiers read it.
 */
const logged = vi.hoisted(() => ({ lines: [] as string[] }));
vi.mock('../../../src/utils/logger.js', () => {
  const push = (m: unknown): void => void logged.lines.push(String(m));
  const fns = { setLevel: vi.fn(), debug: push, info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});

const aws = vi.hoisted(() => ({ ec2: (async () => ({})) as () => Promise<unknown> }));
vi.mock('../../../src/utils/aws-clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/aws-clients.js')>();
  return {
    ...actual,
    getAwsClients: () => ({
      sts: { send: async () => ({ Account: '123456789012' }) },
      ec2: { send: () => aws.ec2() },
    }),
  };
});

import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import { hasRedactedCause } from '../../../src/deployment/retryable-errors.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { awsSdkError } from '../_aws-sdk-error.js';

const CALLER = 'arn:aws:sts::123456789012:assumed-role/Deployer/session';
const REGION = 'us-east-1';
const context = {
  template: { Resources: {} } as CloudFormationTemplate,
  resources: {},
  stackName: 'Consumer',
};

async function getAzsFailing(error: unknown): Promise<Error> {
  aws.ec2 = () => Promise.reject(error);
  return new IntrinsicFunctionResolver(REGION, { cfnFallback: false })
    .resolve({ 'Fn::GetAZs': '' }, context)
    .then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e as Error
    );
}

describe('Fn::GetAZs names an AWS failure by its class (#2319)', () => {
  beforeEach(() => {
    logged.lines.length = 0;
  });

  it('an EC2 denial', async () => {
    const cause = awsSdkError(
      `You are not authorized to perform this operation. User: ${CALLER} is not authorized to perform: ec2:DescribeAvailabilityZones`,
      'UnauthorizedOperation'
    );

    const error = await getAzsFailing(cause);

    expect(error.message).toBe(
      `Fn::GetAZs: failed to describe availability zones for region '${REGION}': ` +
        "UnauthorizedOperation. Re-run with --verbose for AWS's own message."
    );
    expect((error.cause as Error).message).toBe(cause.message);
    expect(hasRedactedCause(error)).toBe(true);
    expect(logged.lines.some((l) => l.includes(CALLER))).toBe(true);
  });

  it('a transport failure keeps its text (negative control)', async () => {
    const error = await getAzsFailing(new Error('getaddrinfo ENOTFOUND ec2.us-east-1.amazonaws.com'));

    expect(error.message).toBe(
      `Fn::GetAZs: failed to describe availability zones for region '${REGION}': ` +
        'getaddrinfo ENOTFOUND ec2.us-east-1.amazonaws.com'
    );
    expect(hasRedactedCause(error)).toBe(false);
  });
});
