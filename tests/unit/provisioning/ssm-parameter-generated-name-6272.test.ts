import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { PutParameterCommand } from '@aws-sdk/client-ssm';

// go-to-k/cdkd#6272: an un-named SSM parameter was created as `/<name>`, and
// its Ref returned that. CDK builds an auto-named parameter's ARN for
// `grantRead` / `grantWrite` as `arn:...:parameter/` + Ref (it assumes the
// slash-less name CloudFormation generates), so the grant named
// `parameter//<name>` and the deployed function was denied.

const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ssm: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    sts: { send: () => Promise.resolve({ Account: '111122223333' }) },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

import { SSMParameterProvider } from '../../../src/provisioning/providers/ssm-parameter-provider.js';
import {
  applyDefaultNameForFallback,
  withStackScope,
} from '../../../src/provisioning/resource-name.js';

const TYPE = 'AWS::SSM::Parameter';
const STACK = 'CdkdSsmGrant';
const scopes = {
  'a stack with an instance id': <T>(fn: () => T): T =>
    withStackScope(
      {
        stackName: STACK,
        stackInstanceId: '3f2c1d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
        nameGenerations: new Map([['Param', 0]]),
      },
      fn
    ),
  'a legacy stack': <T>(fn: () => T): T =>
    withStackScope({ stackName: STACK, stackInstanceId: undefined, nameGenerations: undefined }, fn),
};

describe('an un-named SSM parameter gets a name without a leading slash (#6272)', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it.each(Object.entries(scopes))(
    "the SDK create, %s: CDK's grant ARN names the parameter",
    async (_label, scope) => {
      mockSend.mockResolvedValueOnce({ Version: 1 }); // PutParameter
      const result = await scope(() =>
        new SSMParameterProvider().create('Param', TYPE, { Type: 'String', Value: 'hello' })
      );

      const put = mockSend.mock.calls[0]![0] as PutParameterCommand;
      expect(put).toBeInstanceOf(PutParameterCommand);
      expect(put.input.Name).toBe(result.physicalId);
      expect(result.physicalId).toMatch(new RegExp(`^${STACK}-Param`));
      // What CDK's grantRead builds from Ref is the parameter's real ARN.
      const granted = `arn:aws:ssm:us-east-1:111122223333:parameter/${result.physicalId}`;
      expect(granted).not.toContain('parameter//');
      expect(result.attributes?.['Arn']).toBe(granted);
    }
  );

  it.each(Object.entries(scopes))('the Cloud Control fill, %s', (_label, scope) => {
    const filled = scope(() => applyDefaultNameForFallback('Param', TYPE, { Value: 'hello' }));
    expect(filled['Name']).toMatch(new RegExp(`^${STACK}-Param`));
  });

  it('a declared name is sent as declared, a leading slash included', async () => {
    mockSend.mockResolvedValueOnce({ Version: 1 });
    const result = await scopes['a stack with an instance id'](() =>
      new SSMParameterProvider().create('Param', TYPE, { Name: '/app/p', Value: 'hello' })
    );
    expect(result.physicalId).toBe('/app/p');
    expect((mockSend.mock.calls[0]![0] as PutParameterCommand).input.Name).toBe('/app/p');
  });
});
