/**
 * go-to-k/cdkd#4601: `cdkd diff --fail-on=broadening` prints the AWS CDK CLI's
 * security table for each stack. The verdict reads the node's UNMASKED
 * changes, and the table is rendered through the node's printing mask, so a
 * `NoEcho` value never reaches it: not inside a changed policy, not in an
 * unchanged property the table shows as context (a policy's role), and not in
 * a removed resource's recorded properties. Run end to end through
 * `computeStackDiff` with the real resolver, since the needles come from the
 * diff's own parameter binding.
 */

import { describe, expect, it, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import { computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const NOECHO = 'noecho-plain-4601x';
const ROLE_NAME = `app-${NOECHO}`;

const doc = (...actions: string[]) => ({
  Version: '2012-10-17',
  Statement: actions.map((Action) => ({ Effect: 'Allow', Action, Resource: '*' })),
});

function record(resourceType: string, properties: Record<string, unknown>): ResourceState {
  return { physicalId: 'pid', resourceType, properties, attributes: {}, dependencies: [] };
}

function stateOf(resources: Record<string, ResourceState>): StackState {
  return { stackName: 'S', region: 'us-east-1', resources, outputs: {}, version: 10, lastModified: 0 };
}

const backend = {
  getState: async () => null,
  saveState: vi.fn(),
  putState: vi.fn(),
  deleteState: vi.fn(),
} as unknown as S3StateBackend;

function templateOf(resources: Record<string, unknown>): CloudFormationTemplate {
  return {
    Parameters: { Secret: { Type: 'String', NoEcho: true, Default: NOECHO } },
    Resources: resources,
  } as unknown as CloudFormationTemplate;
}

async function securityOf(state: StackState, template: CloudFormationTemplate) {
  const result = await computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator());
  return result.securityDiff();
}

describe('cdkd diff --fail-on=broadening never prints a NoEcho value (go-to-k/cdkd#4601)', () => {
  it('a secret-derived role name the policy reads stays out of the table', async () => {
    // A record written before the name was redacted: it holds the plaintext.
    const state = stateOf({
      Pol: record('AWS::IAM::Policy', {
        PolicyName: 'P',
        Roles: [ROLE_NAME],
        PolicyDocument: doc('s3:GetObject'),
      }),
    });
    const template = templateOf({
      Pol: {
        Type: 'AWS::IAM::Policy',
        Properties: {
          PolicyName: 'P',
          Roles: [{ 'Fn::Sub': 'app-${Secret}' }],
          PolicyDocument: doc('s3:GetObject', 's3:PutObject'),
        },
      },
    });
    const security = await securityOf(state, template);
    expect(security.broadening).toBe(true);
    expect(security.rendered).toContain('s3:PutObject');
    expect(security.rendered).not.toContain(NOECHO);
  });

  it("a removed role's recorded ExternalId stays out of the table", async () => {
    const state = stateOf({
      Role: record('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Principal: { AWS: 'arn:aws:iam::123456789012:root' },
              Action: 'sts:AssumeRole',
              Condition: { StringEquals: { 'sts:ExternalId': NOECHO } },
            },
          ],
        },
      }),
      Pol: record('AWS::IAM::Policy', {
        PolicyName: 'P',
        Roles: ['r'],
        PolicyDocument: doc('s3:GetObject'),
      }),
    });
    const template = templateOf({
      Pol: {
        Type: 'AWS::IAM::Policy',
        Properties: { PolicyName: 'P', Roles: ['r'], PolicyDocument: doc('s3:GetObject', 'sqs:*') },
      },
    });
    const security = await securityOf(state, template);
    expect(security.broadening).toBe(true);
    expect(security.rendered).toContain('sqs:*');
    expect(security.rendered).not.toContain(NOECHO);
  });
});
