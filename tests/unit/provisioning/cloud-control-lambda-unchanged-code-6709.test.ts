import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

const mockCloudControlSend = vi.fn();
const mockCloudControlConfigRegion = vi.fn();
const mockCloudFormationSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: mockCloudControlConfigRegion },
    },
    // DescribeType for write-only property resolution on the update path.
    cloudFormation: { send: mockCloudFormationSend },
    dynamoDB: { send: vi.fn() },
    apiGateway: { send: vi.fn() },
    cloudFront: { send: vi.fn() },
    lambda: { send: vi.fn() },
    eventBridge: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return {
      child: () => child,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import {
  clearWriteOnlyPropertiesCache,
  getWriteOnlyKeysKeptWhenOmitted,
} from '../../../src/provisioning/write-only-properties.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';

/**
 * go-to-k/cdkd#6709: a Cloud Control UPDATE of an `AWS::Lambda::Function`
 * must not re-add an unchanged `Code`. The handler keeps the code when the
 * patch omits it, and calls `UpdateFunctionCode` when the patch re-sends it.
 */

type PatchOp = { op: string; path: string; value?: unknown };

// The registry schema's write-only list for the type, reduced to what the
// update path reads.
const LAMBDA_FUNCTION_SCHEMA = JSON.stringify({
  writeOnlyProperties: [
    '/properties/SnapStart',
    '/properties/SnapStart/ApplyOn',
    '/properties/Code/ImageUri',
    '/properties/Code/S3Bucket',
    '/properties/Code/S3Key',
    '/properties/Code/S3ObjectVersion',
    '/properties/Code/ZipFile',
    '/properties/Code/SourceKMSKeyArn',
    '/properties/Code/S3ObjectStorageMode',
    '/properties/PublishToLatestPublished',
  ],
});

const IMAGE_CODE = { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo@sha256:aaaa' };
const SCALING = { MinExecutionEnvironments: 0, MaxExecutionEnvironments: 1 };

function wireUpdateSuccess(): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent: { OperationStatus: 'SUCCESS', Identifier: 'fn-1' },
      });
    }
    return Promise.resolve({});
  });
}

function sentPatch(): PatchOp[] {
  const call = mockCloudControlSend.mock.calls.find(
    (c) => c[0]?.constructor?.name === 'UpdateResourceCommand'
  );
  expect(call).toBeDefined();
  return JSON.parse(
    (call![0] as { input: { PatchDocument: string } }).input.PatchDocument
  ) as PatchOp[];
}

const paths = (patch: PatchOp[]): string[] => patch.map((op) => op.path).sort();

describe('CloudControlProvider update: an unchanged Lambda Code is not re-added (go-to-k/cdkd#6709)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    clearCreateOnlyPropertiesCache();
    wireUpdateSuccess();
    provider = new CloudControlProvider();
  });

  it('leaves an unchanged image Code out of a scaling-only patch', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: LAMBDA_FUNCTION_SCHEMA });

    await provider.update(
      'Fn',
      'fn-1',
      'AWS::Lambda::Function',
      // A distinct object with the same contents: state and the resolved
      // template never share a reference.
      { Code: { ...IMAGE_CODE }, PublishToLatestPublished: true, FunctionScalingConfig: SCALING },
      { Code: IMAGE_CODE, PublishToLatestPublished: true }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/FunctionScalingConfig', value: SCALING });
    // `PublishToLatestPublished` still gets the re-add required by go-to-k/cdkd#809.
    expect(patch).toContainEqual({ op: 'add', path: '/PublishToLatestPublished', value: true });
    expect(paths(patch)).toEqual(['/FunctionScalingConfig', '/PublishToLatestPublished']);
  });

  it('leaves an unchanged inline zip Code out of a configuration-only patch', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: LAMBDA_FUNCTION_SCHEMA });
    const code = { ZipFile: 'exports.handler = async () => ({ ok: true });' };

    await provider.update(
      'Fn',
      'fn-1',
      'AWS::Lambda::Function',
      { Code: { ...code }, MemorySize: 256 },
      { Code: code, MemorySize: 128 }
    );

    expect(sentPatch()).toEqual([{ op: 'replace', path: '/MemorySize', value: 256 }]);
  });

  it('still sends a changed Code', async () => {
    mockCloudFormationSend.mockResolvedValue({ Schema: LAMBDA_FUNCTION_SCHEMA });
    const next = { ImageUri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/repo@sha256:bbbb' };

    await provider.update(
      'Fn',
      'fn-1',
      'AWS::Lambda::Function',
      { Code: next, MemorySize: 256 },
      { Code: IMAGE_CODE, MemorySize: 128 }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/Code', value: next });
    expect(paths(patch)).toEqual(['/Code', '/MemorySize']);
  });

  it('still sends a Code the previous side does not hold', async () => {
    // Models the input `drift --revert` hands `provider.update`: a previous
    // side built from the read model, which carries no write-only value.
    mockCloudFormationSend.mockResolvedValue({ Schema: LAMBDA_FUNCTION_SCHEMA });

    await provider.update(
      'Fn',
      'fn-1',
      'AWS::Lambda::Function',
      { Code: IMAGE_CODE, MemorySize: 256 },
      { MemorySize: 128 }
    );

    expect(sentPatch()).toContainEqual({ op: 'add', path: '/Code', value: IMAGE_CODE });
  });

  it('still re-adds an unchanged write-only key of a type with no entry', async () => {
    // Same top-level key name, another type: the exception is per type.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({ writeOnlyProperties: ['/properties/Code/Script'] }),
    });
    const code = { Script: 'exports.handler = async () => {};', Handler: 'index.handler' };

    await provider.update(
      'Canary',
      'canary-1',
      'AWS::Synthetics::Canary',
      { Code: code, FailureRetentionPeriod: 14 },
      { Code: code, FailureRetentionPeriod: 7 }
    );

    const patch = sentPatch();
    expect(patch).toContainEqual({ op: 'add', path: '/Code', value: code });
    expect(paths(patch)).toEqual(['/Code', '/FailureRetentionPeriod']);
  });
});

describe('getWriteOnlyKeysKeptWhenOmitted (go-to-k/cdkd#6709)', () => {
  it("names a Lambda function's Code and nothing else of the type", () => {
    expect([...getWriteOnlyKeysKeptWhenOmitted('AWS::Lambda::Function')]).toEqual(['Code']);
  });

  it('is empty for a type with no measured entry', () => {
    expect(getWriteOnlyKeysKeptWhenOmitted('AWS::ECS::Service').size).toBe(0);
    expect(getWriteOnlyKeysKeptWhenOmitted('AWS::Synthetics::Canary').size).toBe(0);
  });
});
