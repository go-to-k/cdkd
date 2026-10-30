import { describe, it, expect, beforeEach, afterEach, vi } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambdaMicrovms: {
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
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

import { LambdaMicrovmImageProvider } from '../../../src/provisioning/providers/lambda-microvm-image-provider.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import {
  CreatedResourceSink,
  collectCreatedResources,
} from '../../../src/provisioning/created-resource-sink.js';

const TYPE = 'AWS::Lambda::MicrovmImage';
const ARN = 'arn:aws:lambda:us-east-1:123456789012:microvm-image:my-image';

function props(): Record<string, unknown> {
  return {
    Name: 'my-image',
    BaseImageArn: 'arn:aws:lambda:us-east-1:aws:microvm-image:al2023-1',
    BuildRoleArn: 'arn:aws:iam::123456789012:role/MicrovmBuildRole',
    CodeArtifact: { Uri: 's3://my-bucket/app.zip' },
  };
}

async function createError(provider: LambdaMicrovmImageProvider): Promise<unknown> {
  return provider.create('Image', TYPE, props()).then(
    () => {
      throw new Error('expected create to fail');
    },
    (e: unknown) => e
  );
}

describe('LambdaMicrovmImageProvider create marks a created-before-failure image (#4583)', () => {
  let provider: LambdaMicrovmImageProvider;

  beforeEach(() => {
    mockSend.mockReset();
    delete process.env['CDKD_NO_WAIT'];
    process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'] = '1';
    process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'] = '3';
    provider = new LambdaMicrovmImageProvider();
  });

  afterEach(() => {
    delete process.env['CDKD_MICROVM_IMAGE_POLL_INTERVAL_MS'];
    delete process.env['CDKD_MICROVM_IMAGE_POLL_ATTEMPTS'];
  });

  it('marks the image ARN when the build ends CREATE_FAILED after CreateMicrovmImage returned', async () => {
    mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
    mockSend.mockResolvedValueOnce({ state: 'CREATE_FAILED' });
    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'Image', TYPE)).toBe(ARN);
  });

  it('marks the image ARN when the wait poll itself throws', async () => {
    mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
    mockSend.mockRejectedValueOnce(new Error('throttled'));
    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'Image', TYPE)).toBe(ARN);
  });

  it('leaves no mark when CreateMicrovmImage itself fails', async () => {
    mockSend.mockRejectedValueOnce(new Error('ConflictException: already exists'));
    const error = await createError(provider);
    expect(createdBeforeFailure(error, 'Image', TYPE)).toBeUndefined();
  });

  it('leaves no mark on the pre-flight missing-property refusal', async () => {
    const error = await provider.create('Image', TYPE, { Name: 'x' }).then(
      () => undefined,
      (e: unknown) => e
    );
    expect(error).toBeDefined();
    expect(mockSend).not.toHaveBeenCalled();
    expect(createdBeforeFailure(error, 'Image', TYPE)).toBeUndefined();
  });

  it('reports the image ARN to the sink before the build wait (#5511)', async () => {
    const sink = new CreatedResourceSink('Image', TYPE);
    let reportAtWait: unknown = 'not-called';
    mockSend.mockResolvedValueOnce({ imageArn: ARN, state: 'CREATING' });
    mockSend.mockImplementationOnce(() => {
      reportAtWait = sink.report;
      return Promise.reject(new Error('throttled'));
    });
    await expect(
      collectCreatedResources(sink, () => provider.create('Image', TYPE, props()))
    ).rejects.toThrow();
    expect(reportAtWait).toEqual({ physicalId: ARN });
    expect(sink.report).toEqual({ physicalId: ARN });
  });

  it('reports nothing when CreateMicrovmImage itself fails (#5511)', async () => {
    const sink = new CreatedResourceSink('Image', TYPE);
    mockSend.mockRejectedValueOnce(new Error('ConflictException: already exists'));
    await expect(
      collectCreatedResources(sink, () => provider.create('Image', TYPE, props()))
    ).rejects.toThrow();
    expect(sink.report).toBeUndefined();
  });
});
