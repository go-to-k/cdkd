/**
 * go-to-k/cdkd#6242: `Fn::GetAtt [Fn, SnapStartResponse]` was refused, and
 * the dotted `SnapStartResponse.ApplyOn` / `.OptimizationStatus` were never
 * recorded either. CloudFormation answers
 * `{"ApplyOn": "None", "OptimizationStatus": "Off"}` for a function without
 * SnapStart and `{"ApplyOn": "PublishedVersions", "OptimizationStatus": "Off"}`
 * with it (measured us-east-1, 2026-11-14) — exactly Lambda's `SnapStart`.
 * Create, update and `import()` now record it through `functionAttributes`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateFunctionCommand, GetFunctionCommand } from '@aws-sdk/client-lambda';

const mockLambdaSend = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: vi.fn() },
  }),
}));
vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...fns, child: () => fns }) };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { functionAttributes } from '../../../src/provisioning/providers/lambda-function/attributes.js';

const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:fn';
const CONFIG = {
  FunctionName: 'fn',
  FunctionArn: ARN,
  SnapStart: { ApplyOn: 'PublishedVersions', OptimizationStatus: 'Off' },
} as const;
const EXPECTED = {
  Arn: ARN,
  FunctionName: 'fn',
  SnapStartResponse: { ApplyOn: 'PublishedVersions', OptimizationStatus: 'Off' },
};
const PROPS = {
  FunctionName: 'fn',
  Role: 'arn:aws:iam::123456789012:role/exec',
  Handler: 'index.handler',
  Runtime: 'python3.12',
  Code: { S3Bucket: 'b', S3Key: 'k' },
};

describe('functionAttributes (#6242)', () => {
  it('records SnapStartResponse as one nested object next to Arn and FunctionName', () => {
    expect(functionAttributes(CONFIG)).toStrictEqual(EXPECTED);
  });

  it('leaves SnapStartResponse ABSENT when the response carries no SnapStart', () => {
    expect(functionAttributes({ FunctionName: 'fn', FunctionArn: ARN })).toStrictEqual({
      Arn: ARN,
      FunctionName: 'fn',
    });
    expect(functionAttributes({ FunctionName: 'fn', SnapStart: {} })).toStrictEqual({
      FunctionName: 'fn',
    });
    expect(functionAttributes(undefined)).toStrictEqual({});
  });
});

describe('LambdaFunctionProvider records SnapStartResponse on every write (#6242)', () => {
  beforeEach(() => mockLambdaSend.mockReset());

  it('create: from the CreateFunction response, no extra call', async () => {
    mockLambdaSend.mockResolvedValueOnce(CONFIG);
    const result = await new LambdaFunctionProvider().create('Fn', 'AWS::Lambda::Function', PROPS);
    expect(result.attributes).toStrictEqual(EXPECTED);
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect(mockLambdaSend.mock.calls[0]![0]).toBeInstanceOf(CreateFunctionCommand);
  });

  it('update: from the GetFunction read-back it already issues', async () => {
    mockLambdaSend.mockImplementation((cmd: unknown) =>
      Promise.resolve(cmd instanceof GetFunctionCommand ? { Configuration: CONFIG } : {})
    );
    const result = await new LambdaFunctionProvider().update(
      'Fn',
      'fn',
      'AWS::Lambda::Function',
      PROPS,
      PROPS
    );
    expect(result.attributes).toStrictEqual(EXPECTED);
  });

  it('import: the same map create and update record', async () => {
    mockLambdaSend.mockResolvedValueOnce({ Configuration: CONFIG });
    const result = await new LambdaFunctionProvider().import({
      logicalId: 'Fn',
      resourceType: 'AWS::Lambda::Function',
      stackName: 'S',
      region: 'us-east-1',
      properties: PROPS,
      knownPhysicalId: 'fn',
    });
    expect(result?.attributes).toStrictEqual(EXPECTED);
  });
});
