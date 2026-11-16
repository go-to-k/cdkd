/**
 * Issue go-to-k/cdkd#6419: cdk-local's `Ref` substitution reads a resource's
 * `physicalId` verbatim, which `--from-cfn-stack` fills with CloudFormation's
 * physical id (the `Ref` value). cdkd records some types under its own id, so
 * `S3LocalStateProvider.load` hands cdk-local the `Ref` value instead: an
 * `HttpUserPoolAuthorizer`'s audience (`Ref <UserPoolClient>`) otherwise
 * reached the local JWT check as `<userPoolId>|<clientId>` and matched no
 * token, and a Lambda env var `Ref` to the client reached the handler so.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';

const mocks = vi.hoisted(() => ({ loadStateForStackMock: vi.fn() }));

vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: mocks.loadStateForStackMock,
  buildCrossStackResolver: vi.fn(),
}));

import { substituteAgainstState } from '../../../src/local/state-resolver.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';

const REGION = 'us-east-1';
const resources: StackState['resources'] = {
  Pool: { physicalId: 'us-east-1_AbC', resourceType: 'AWS::Cognito::UserPool', properties: {} },
  Client: {
    physicalId: 'us-east-1_AbC|client123',
    resourceType: 'AWS::Cognito::UserPoolClient',
    properties: {},
  },
  Rule: {
    physicalId: 'arn:aws:events:us-east-1:111111111111:rule/my-rule',
    resourceType: 'AWS::Events::Rule',
    properties: {},
  },
};

async function load(): Promise<StackState['resources']> {
  const state: StackState = {
    version: 9,
    stackName: 'S',
    region: REGION,
    resources: structuredClone(resources),
    outputs: {},
    lastModified: 1,
  };
  mocks.loadStateForStackMock.mockResolvedValueOnce({ state, region: REGION });
  const record = await new S3LocalStateProvider({ statePrefix: 'cdkd' }).load('S', REGION);
  if (!record) throw new Error('no record');
  return record.resources as StackState['resources'];
}

describe('S3LocalStateProvider.load hands cdk-local CloudFormation Ref values', () => {
  it('maps a compound id and a name-from-ARN id to the Ref value, leaving the rest', async () => {
    const out = await load();
    expect(out['Client']?.physicalId).toBe('client123');
    expect(out['Rule']?.physicalId).toBe('my-rule');
    expect(out['Pool']?.physicalId).toBe('us-east-1_AbC');
    expect(out['Client']?.resourceType).toBe('AWS::Cognito::UserPoolClient');
  });

  it("is what cdk-local's Ref substitution then returns", async () => {
    const out = await load();
    expect(substituteAgainstState({ Ref: 'Client' }, { resources: out })).toEqual({
      kind: 'literal',
      value: 'client123',
    });
  });
});
