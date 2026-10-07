import { describe, it, expect } from 'vite-plus/test';
import { buildImportPlan } from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * go-to-k/cdkd#4043 (schema v11): a property a `NoEcho` template parameter fed
 * holds `***` by design, at a coordinate its record names in `noEchoLeaves`.
 * `cdkd export` cannot declare it, and none of the custom-resource / Base64 /
 * spliced-record remedies applies, so it gets its own reason.
 */
const cfnClientStub = {
  send: () => {
    throw new Error('cfnClient.send should not be reached');
  },
} as unknown as AwsClients['cloudFormation'];

function stateWith(properties: Record<string, unknown>, noEchoLeaves?: (string | number)[][]) {
  return {
    version: 11,
    stackName: 'Root',
    region: 'us-east-1',
    resources: {
      Param: {
        physicalId: '/app/token',
        resourceType: 'AWS::SSM::Parameter',
        properties,
        attributes: {},
        dependencies: [],
        ...(noEchoLeaves !== undefined && { noEchoLeaves }),
      },
    },
    outputs: {},
    lastModified: 0,
  } as StackState;
}

const template = {
  Parameters: { Token: { Type: 'String', NoEcho: true } },
  Resources: {
    Param: {
      Type: 'AWS::SSM::Parameter',
      Properties: { Name: '/app/token', Value: { Ref: 'Token' } },
    },
  },
};

describe('cdkd export of a NoEcho-parameter-fed property (schema v11)', () => {
  it('blocks it with the NoEcho parameter reason, not the three record remedies', async () => {
    const result = await buildImportPlan(
      stateWith({ Name: '/app/token', Value: '***' }, [['Value']]),
      template,
      cfnClientStub,
      'Root'
    );
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toMatch(/a NoEcho template parameter feeds/);
    expect(result.blocked[0]!.reason).not.toMatch(/three ways/);
  });

  it('keeps the general reason when a mask sits OUTSIDE the marked coordinates', async () => {
    const result = await buildImportPlan(
      stateWith({ Name: '***', Value: '***' }, [['Value']]),
      template,
      cfnClientStub,
      'Root'
    );
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toMatch(/three ways a record comes to hold it/);
  });

  it('keeps the general reason for a record with no marker (pre-v11)', async () => {
    const result = await buildImportPlan(
      stateWith({ Name: '/app/token', Value: '***' }),
      template,
      cfnClientStub,
      'Root'
    );
    expect(result.blocked[0]!.reason).toMatch(/three ways a record comes to hold it/);
  });
});
