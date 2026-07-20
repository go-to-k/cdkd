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
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';

/**
 * Generic sparse-ResourceModel GetResource read-back (issue #1105).
 *
 * When a CC-routed type's CREATE / UPDATE ProgressEvent.ResourceModel is
 * sparse (empty, or nothing beyond an echo of the identifier), one
 * best-effort GetResource read-back merges the AWS-current model into the
 * attributes BEFORE the per-type enrichResourceAttributes switch — so every
 * current and future sparse-model type is correct by default instead of
 * requiring a hand-written per-type case.
 */

/** Wires the CC mock for a successful async CREATE. */
function wireCreateSuccess(options: {
  identifier: string;
  resourceModel?: string;
  getResourceModel?: Record<string, unknown> | Error;
}): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'CreateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-create' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent: {
          OperationStatus: 'SUCCESS',
          Identifier: options.identifier,
          ...(options.resourceModel !== undefined ? { ResourceModel: options.resourceModel } : {}),
        },
      });
    }
    if (name === 'GetResourceCommand') {
      if (options.getResourceModel instanceof Error) {
        return Promise.reject(options.getResourceModel);
      }
      return Promise.resolve({
        ResourceDescription: {
          Identifier: options.identifier,
          Properties: JSON.stringify(options.getResourceModel ?? {}),
        },
      });
    }
    return Promise.resolve({});
  });
}

/** Wires the CC mock for a successful async UPDATE. */
function wireUpdateSuccess(options: {
  identifier: string;
  resourceModel?: string;
  getResourceModel?: Record<string, unknown> | Error;
}): void {
  mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'UpdateResourceCommand') {
      return Promise.resolve({ ProgressEvent: { RequestToken: 'tok-update' } });
    }
    if (name === 'GetResourceRequestStatusCommand') {
      return Promise.resolve({
        ProgressEvent: {
          OperationStatus: 'SUCCESS',
          Identifier: options.identifier,
          ...(options.resourceModel !== undefined ? { ResourceModel: options.resourceModel } : {}),
        },
      });
    }
    if (name === 'GetResourceCommand') {
      if (options.getResourceModel instanceof Error) {
        return Promise.reject(options.getResourceModel);
      }
      return Promise.resolve({
        ResourceDescription: {
          Identifier: options.identifier,
          Properties: JSON.stringify(options.getResourceModel ?? {}),
        },
      });
    }
    return Promise.resolve({});
  });
}

const getResourceCallCount = (): number =>
  mockCloudControlSend.mock.calls.filter((c) => c[0]?.constructor?.name === 'GetResourceCommand')
    .length;

describe('CloudControlProvider generic sparse-model read-back (issue #1105)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    clearWriteOnlyPropertiesCache();
    provider = new CloudControlProvider();
  });

  it('issues one GetResource read-back and merges the model when the CREATE ResourceModel is absent', async () => {
    wireCreateSuccess({
      identifier: 'my-thing',
      // No ResourceModel on the SUCCESS event at all.
      getResourceModel: {
        Arn: 'arn:aws:fake:us-east-1:123456789012:thing/my-thing',
        Name: 'my-thing',
      },
    });

    const result = await provider.create('MyThing', 'AWS::Fake::Thing', { Name: 'my-thing' });

    expect(result.physicalId).toBe('my-thing');
    expect(result.attributes?.['Arn']).toBe('arn:aws:fake:us-east-1:123456789012:thing/my-thing');
    expect(getResourceCallCount()).toBe(1);
  });

  it('treats a model carrying only identifier echoes as sparse and reads back', async () => {
    wireCreateSuccess({
      identifier: 'sel-uuid|plan-uuid',
      // Echoes of the compound identifier and its segments only — no real
      // information beyond the physicalId.
      resourceModel: JSON.stringify({
        Id: 'sel-uuid|plan-uuid',
        SelectionId: 'sel-uuid',
        PlanId: 'plan-uuid',
      }),
      getResourceModel: {
        Id: 'sel-uuid|plan-uuid',
        Arn: 'arn:aws:fake:us-east-1:123456789012:selection/sel-uuid',
      },
    });

    const result = await provider.create('MySel', 'AWS::Fake::Selection', {});

    expect(result.attributes?.['Arn']).toBe(
      'arn:aws:fake:us-east-1:123456789012:selection/sel-uuid'
    );
    // The identifier echoes from the ProgressEvent model are preserved.
    expect(result.attributes?.['SelectionId']).toBe('sel-uuid');
    expect(getResourceCallCount()).toBe(1);
  });

  it('does NOT read back when the CREATE ResourceModel carries real attributes (ApiGatewayV2 Api shape)', async () => {
    wireCreateSuccess({
      identifier: 'abc123',
      // ApiEndpoint is real information beyond the identifier echo — the
      // model is not sparse, so no extra GetResource call is spent.
      resourceModel: JSON.stringify({
        ApiId: 'abc123',
        ApiEndpoint: 'https://abc123.execute-api.us-east-1.amazonaws.com',
      }),
    });

    const result = await provider.create('MyApi', 'AWS::ApiGatewayV2::Api', { Name: 'my-api' });

    expect(result.attributes?.['ApiEndpoint']).toBe(
      'https://abc123.execute-api.us-east-1.amazonaws.com'
    );
    expect(getResourceCallCount()).toBe(0);
  });

  it('create still succeeds with unmerged attributes when the read-back throws', async () => {
    wireCreateSuccess({
      identifier: 'my-thing',
      resourceModel: JSON.stringify({}),
      getResourceModel: Object.assign(new Error('Rate exceeded'), {
        name: 'ThrottlingException',
      }),
    });

    const result = await provider.create('MyThing', 'AWS::Fake::Thing', { Name: 'my-thing' });

    expect(result.physicalId).toBe('my-thing');
    expect(result.attributes).toEqual({});
    // The read-back WAS attempted (and failed silently).
    expect(getResourceCallCount()).toBe(1);
  });

  it('refreshes attributes on a sparse UPDATE via the read-back', async () => {
    wireUpdateSuccess({
      identifier: 'my-thing',
      // UPDATE ProgressEvent omits everything the CREATE model had.
      getResourceModel: {
        Arn: 'arn:aws:fake:us-east-1:123456789012:thing/my-thing',
        Status: 'UPDATED',
      },
    });
    // No write-only properties for the type.
    mockCloudFormationSend.mockResolvedValue({ Schema: JSON.stringify({}) });

    const result = await provider.update(
      'MyThing',
      'my-thing',
      'AWS::Fake::Thing',
      { Name: 'my-thing', Description: 'new' },
      { Name: 'my-thing', Description: 'old' }
    );

    expect(result.attributes?.['Arn']).toBe('arn:aws:fake:us-east-1:123456789012:thing/my-thing');
    expect(result.attributes?.['Status']).toBe('UPDATED');
    expect(getResourceCallCount()).toBe(1);
  });

  it('composes with the per-type enrichment gating: one GetResource total for a Pipes create', async () => {
    wireCreateSuccess({
      identifier: 'my-pipe',
      resourceModel: JSON.stringify({ Name: 'my-pipe' }),
      getResourceModel: {
        Name: 'my-pipe',
        Arn: 'arn:aws:pipes:us-east-1:123456789012:pipe/my-pipe',
        CurrentState: 'RUNNING',
      },
    });

    const result = await provider.create('MyPipe', 'AWS::Pipes::Pipe', { Name: 'my-pipe' });

    expect(result.attributes?.['Arn']).toBe('arn:aws:pipes:us-east-1:123456789012:pipe/my-pipe');
    expect(result.attributes?.['CurrentState']).toBe('RUNNING');
    // The generic pass filled Arn, so the per-type Pipes case's
    // `if (!enriched['Arn'])` gate skips its own read-back — exactly one
    // GetResource call in total.
    expect(getResourceCallCount()).toBe(1);
  });

  it('per-type enrichment still applies after the generic pass (S3 Bucket Arn fallback)', async () => {
    wireCreateSuccess({
      identifier: 'my-bucket',
      resourceModel: JSON.stringify({}),
      // Read-back returns a model without Arn — the per-type S3 case then
      // computes it from the physicalId.
      getResourceModel: { BucketName: 'my-bucket', DomainName: 'my-bucket.s3.amazonaws.com' },
    });

    const result = await provider.create('MyBucket', 'AWS::S3::Bucket', {});

    expect(result.attributes?.['DomainName']).toBe('my-bucket.s3.amazonaws.com');
    expect(result.attributes?.['Arn']).toBe('arn:aws:s3:::my-bucket');
  });

  it('does NOT read back when the model carries a non-string value (real information)', async () => {
    wireCreateSuccess({
      identifier: 'my-thing',
      resourceModel: JSON.stringify({ Name: 'my-thing', Config: { Nested: true } }),
    });

    const result = await provider.create('MyThing', 'AWS::Fake::Thing', { Name: 'my-thing' });

    expect(result.attributes?.['Config']).toEqual({ Nested: true });
    expect(getResourceCallCount()).toBe(0);
  });
});
