import { describe, it, expect } from 'vite-plus/test';
import { buildImportPlan } from '../../../src/cli/commands/export.js';
import type { StackState } from '../../../src/types/state.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';

/**
 * go-to-k/cdkd#4043 (schema v11, Phase C): a property a `NoEcho` template
 * parameter fed holds `***` by design, at a coordinate its record names in
 * `noEchoLeaves`. The exported template reads the parameter, so `cdkd export`
 * lets such a record through, and blocks it only where the export itself
 * reads the masked value: an import identifier, or an `AWS::IAM::Policy`
 * pre-delete's principals or name. A mask outside the marked coordinates
 * keeps the general reason.
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
  // Phase C (design section 4.8): the exported template reads the parameter
  // and CloudFormation receives its value as a parameter, so a record whose
  // only masks sit at marked coordinates is exported; its identifier (the
  // SSM name) reads no marked position.
  it('lets it through when every mask sits at a marked coordinate', async () => {
    const result = await buildImportPlan(
      stateWith({ Name: '/app/token', Value: '***' }, [['Value']]),
      template,
      cfnClientStub,
      'Root'
    );
    expect(result.blocked).toEqual([]);
    expect(JSON.stringify(result)).toContain('/app/token');
    expect(JSON.stringify(result)).not.toContain('"Value":"***"');
  });

  it.each([
    ['a whole marked leaf', '***', /redaction mask/],
    // Not a whole mask, so no property check blocks it: another record's
    // masked attribute substituted into a string through Fn::Sub (review B1).
    ['an embedded one', 'fn-***', /embeds the redaction mask/],
  ])('blocks a record whose import identifier carries %s', async (_l, functionName, reason) => {
    const state = stateWith({}, [['FunctionName']]);
    state.resources['Param'] = {
      physicalId: 'fn|stmt-1',
      resourceType: 'AWS::Lambda::Permission',
      properties: { FunctionName: functionName, Action: 'lambda:InvokeFunction', Principal: 's3.amazonaws.com' },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['FunctionName']],
    };
    const result = await buildImportPlan(
      state,
      {
        Parameters: { Token: { Type: 'String', NoEcho: true } },
        Resources: {
          Param: {
            Type: 'AWS::Lambda::Permission',
            Properties: {
              FunctionName: { Ref: 'Token' },
              Action: 'lambda:InvokeFunction',
              Principal: 's3.amazonaws.com',
            },
          },
        },
      },
      {
        send: () =>
          Promise.resolve({
            ProvisioningType: 'FULLY_MUTABLE',
            Schema: JSON.stringify({
              primaryIdentifier: ['/properties/FunctionName', '/properties/Id'],
              handlers: { read: { permissions: [] } },
            }),
          }),
      } as unknown as AwsClients['cloudFormation'],
      'Root'
    );
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toMatch(reason);
  });

  it("blocks an IAM policy whose pre-delete would read a marked principal, with the NoEcho reason", async () => {
    const state = stateWith({}, [['Roles', 0]]);
    state.resources['Param'] = {
      physicalId: 'Root-Pol',
      resourceType: 'AWS::IAM::Policy',
      properties: { PolicyName: 'pol', Roles: ['***'], PolicyDocument: { Statement: [] } },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['Roles', 0]],
    };
    const result = await buildImportPlan(
      state,
      {
        Parameters: { Token: { Type: 'String', NoEcho: true } },
        Resources: {
          Param: {
            Type: 'AWS::IAM::Policy',
            Properties: { PolicyName: 'pol', Roles: [{ Ref: 'Token' }], PolicyDocument: { Statement: [] } },
          },
        },
      },
      cfnClientStub,
      'Root',
      { recreateImportUnsupported: true }
    );
    expect(result.blocked).toHaveLength(1);
    expect(result.blocked[0]!.reason).toMatch(/pre-delete reads \(its principals or its name\)/);
  });

  it('lets an IAM policy through whose marked leaf is in its PolicyDocument, which the pre-delete never reads', async () => {
    const state = stateWith({}, [['PolicyDocument', 'Statement', 0, 'Resource']]);
    state.resources['Param'] = {
      physicalId: 'Root-Pol',
      resourceType: 'AWS::IAM::Policy',
      properties: {
        PolicyName: 'pol',
        Roles: ['role-a'],
        PolicyDocument: { Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: '***' }] },
      },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['PolicyDocument', 'Statement', 0, 'Resource']],
    };
    const result = await buildImportPlan(
      state,
      {
        Parameters: { Token: { Type: 'String', NoEcho: true } },
        Resources: {
          Param: {
            Type: 'AWS::IAM::Policy',
            Properties: {
              PolicyName: 'pol',
              Roles: ['role-a'],
              PolicyDocument: {
                Statement: [{ Effect: 'Allow', Action: 's3:GetObject', Resource: { Ref: 'Token' } }],
              },
            },
          },
        },
      },
      cfnClientStub,
      'Root',
      { recreateImportUnsupported: true }
    );
    expect(result.blocked.filter((b) => /pre-delete reads/.test(b.reason))).toEqual([]);
    expect(result.blocked.filter((b) => /three ways/.test(b.reason))).toEqual([]);
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
