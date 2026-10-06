import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CreateFunctionCommand,
  DeleteFunctionCommand,
  PutFunctionConcurrencyCommand,
  PutFunctionRecursionConfigCommand,
} from '@aws-sdk/client-lambda';

const mockLambdaSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: {
      send: mockLambdaSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    ec2: { send: vi.fn() },
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
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';

// go-to-k/cdkd#4583: a post-create call failing after CreateFunction returned
// names the function for the failed-CREATE journal, unless the atomicity
// cleanup deleted it.
const TYPE = 'AWS::Lambda::Function';
const FN = 'my-fn';
const BASE = {
  FunctionName: FN,
  Role: 'arn:aws:iam::123456789012:role/r',
  Runtime: 'nodejs20.x',
  Handler: 'index.handler',
  Code: { S3Bucket: 'bucket', S3Key: 'key.zip' },
};

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error('expected create() to throw');
}

describe('LambdaFunctionProvider.create created-before-failure mark (#4583)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    mockLambdaSend.mockReset();
    provider = new LambdaFunctionProvider();
  });

  it('marks the function when the post-create cleanup delete also failed', async () => {
    mockLambdaSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateFunctionCommand) {
        return { FunctionName: FN, FunctionArn: `arn:aws:lambda:us-east-1:1:function:${FN}` };
      }
      if (cmd instanceof PutFunctionConcurrencyCommand) throw new Error('InvalidParameterValue');
      if (cmd instanceof DeleteFunctionCommand) throw new Error('AccessDeniedException');
      return {};
    });
    const err = await caught(
      provider.create('Fn', TYPE, { ...BASE, ReservedConcurrentExecutions: 5 })
    );
    expect(createdBeforeFailure(err, 'Fn', TYPE)).toBe(FN);
  });

  it('does not mark when the post-create cleanup deleted the function', async () => {
    mockLambdaSend.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof CreateFunctionCommand) return { FunctionName: FN };
      if (cmd instanceof PutFunctionRecursionConfigCommand) throw new Error('InvalidParameterValue');
      return {};
    });
    const err = await caught(provider.create('Fn', TYPE, { ...BASE, RecursiveLoop: 'Allow' }));
    expect(mockLambdaSend.mock.calls.some((c) => c[0] instanceof DeleteFunctionCommand)).toBe(
      true
    );
    expect(createdBeforeFailure(err, 'Fn', TYPE)).toBeUndefined();
  });

  it('does not mark when CreateFunction itself fails', async () => {
    mockLambdaSend.mockRejectedValue(
      Object.assign(new Error('Function already exist'), { name: 'ResourceConflictException' })
    );
    const err = await caught(provider.create('Fn', TYPE, BASE));
    expect(createdBeforeFailure(err, 'Fn', TYPE)).toBeUndefined();
  });

  it('does not mark the pre-flight refusal of a missing Role', async () => {
    const { Role: _role, ...noRole } = BASE;
    const err = await caught(provider.create('Fn', TYPE, noRole));
    expect(mockLambdaSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(err, 'Fn', TYPE)).toBeUndefined();
  });
});
