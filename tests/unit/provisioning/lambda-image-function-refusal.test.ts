/**
 * Issue #1894 — AWS rejects `CodeSigningConfigArn` and `RuntimeManagementConfig`
 * on a container-image function (`PackageType: Image`) with
 * `InvalidParameterValueException`. cdkd refuses them BEFORE any Lambda call on
 * both the create and the update path, instead of failing on AWS's rejection —
 * which, for the runtime-management case on create, came only after the
 * function had been created and then deleted again by the atomicity cleanup.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
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
import { ProvisioningError } from '../../../src/utils/error-handler.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';

const IMAGE_PROPS = {
  FunctionName: 'fn',
  PackageType: 'Image',
  Code: { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/fn:latest' },
  Role: 'arn:aws:iam::123456789012:role/exec',
};
const CSC = 'arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-1';
const RMC = { UpdateRuntimeOn: 'Manual', RuntimeVersionArn: 'arn:aws:lambda:::runtime:x' };

async function refusal(run: () => Promise<unknown>): Promise<ProvisioningError> {
  const error = await run().then(
    () => undefined,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ProvisioningError);
  return error as ProvisioningError;
}

describe('container-image function refuses code signing and runtime management (issue #1894)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    mockSend.mockReset();
    mockSend.mockResolvedValue({});
    provider = new LambdaFunctionProvider();
  });

  const cases: Array<{
    name: string;
    extra: Record<string, unknown>;
    named: string;
    remedy: string;
  }> = [
    {
      name: 'CodeSigningConfigArn',
      extra: { CodeSigningConfigArn: CSC },
      named: 'CodeSigningConfigArn',
      remedy: 'Remove it',
    },
    {
      name: 'RuntimeManagementConfig',
      extra: { RuntimeManagementConfig: RMC },
      named: 'RuntimeManagementConfig',
      remedy: 'Remove it',
    },
    {
      name: 'both',
      extra: { CodeSigningConfigArn: CSC, RuntimeManagementConfig: RMC },
      named: 'CodeSigningConfigArn and RuntimeManagementConfig',
      remedy: 'Remove them',
    },
  ];

  for (const c of cases) {
    it(`refuses ${c.name} on CREATE before any Lambda call`, async () => {
      const error = await refusal(() =>
        provider.create('ImageFn', 'AWS::Lambda::Function', { ...IMAGE_PROPS, ...c.extra })
      );
      expect(error.message).toContain('ImageFn is a container-image function (PackageType: Image)');
      expect(error.message).toContain(`AWS rejects ${c.named} on one`);
      expect(error.message).toContain(`${c.remedy} from the function's properties`);
      expect(error.physicalId).toBeUndefined();
      expect(isMarkedNonRetryable(error)).toBe(true);
      // No CreateFunction, so no create-then-delete either.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it(`refuses ${c.name} on UPDATE before any Lambda call`, async () => {
      const error = await refusal(() =>
        provider.update(
          'ImageFn',
          'fn',
          'AWS::Lambda::Function',
          { ...IMAGE_PROPS, ...c.extra },
          { ...IMAGE_PROPS }
        )
      );
      expect(error.message).toContain(`AWS rejects ${c.named} on one`);
      expect(error.physicalId).toBe('fn');
      expect(isMarkedNonRetryable(error)).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    });
  }

  // Unconditional on a rollback replay too: AWS rejects the combination every
  // time, so a downgraded warning could only report success over a call that
  // then fails.
  it('refuses on an UPDATE that replays a state record (replayingState)', async () => {
    const error = await refusal(() =>
      provider.update(
        'ImageFn',
        'fn',
        'AWS::Lambda::Function',
        { ...IMAGE_PROPS, RuntimeManagementConfig: RMC },
        { ...IMAGE_PROPS },
        { replayingState: true }
      )
    );
    expect(error.message).toContain('AWS rejects RuntimeManagementConfig on one');
    expect(mockSend).not.toHaveBeenCalled();
  });

  // The controls: the same properties on a ZIP function, and an image function
  // declaring neither, still reach AWS — so the cases above cannot pass under
  // an implementation that refused every function.
  it('still sends CodeSigningConfigArn for a ZIP function', async () => {
    mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
    await provider.create('ZipFn', 'AWS::Lambda::Function', {
      FunctionName: 'fn',
      Code: { S3Bucket: 'b', S3Key: 'k' },
      Role: 'arn:aws:iam::123456789012:role/exec',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
      PackageType: 'Zip',
      CodeSigningConfigArn: CSC,
    });
    expect(mockSend).toHaveBeenCalled();
  });

  it('still creates an image function that declares neither property', async () => {
    mockSend.mockResolvedValueOnce({ FunctionName: 'fn', FunctionArn: 'arn:fn' });
    await provider.create('ImageFn', 'AWS::Lambda::Function', { ...IMAGE_PROPS });
    expect(mockSend).toHaveBeenCalled();
  });
});
