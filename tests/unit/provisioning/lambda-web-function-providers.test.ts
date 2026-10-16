import { describe, it, expect, beforeEach, vi } from 'vite-plus/test';
import {
  CreateWebFunctionRevisionCommand,
  GetWebFunctionRevisionCommand,
  DeleteWebFunctionRevisionCommand,
  CreateWebFunctionEndpointCommand,
  GetWebFunctionEndpointCommand,
  UpdateWebFunctionEndpointCommand,
  DeleteWebFunctionEndpointCommand,
  ListWebFunctionRevisionsCommand,
  ResourceNotFoundException,
  ConflictException,
} from '@aws-sdk/client-lambda-web';

const mockSend = vi.fn();
let clientRegion = 'us-east-1';

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambdaWeb: {
      send: mockSend,
      config: { region: () => Promise.resolve(clientRegion) },
    },
  }),
}));

// The revision create goes through its own client (no 5xx replay), built from
// the SDK package rather than getAwsClients(); route it to the same mock.
vi.mock('@aws-sdk/client-lambda-web', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-lambda-web')>();
  class LambdaWebClient {
    send = (cmd: unknown) => mockSend(cmd);
    config = { region: () => Promise.resolve(clientRegion) };
  }
  return { ...actual, LambdaWebClient };
});

const warn = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warn(...args),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return { getLogger: () => ({ child: () => childLogger }) };
});

// The waits poll every 500 ms; the tests drive state transitions, not time.
vi.mock('../../../src/provisioning/providers/lambda-web-function-arns.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sleep: () => Promise.resolve(),
}));

import {
  LambdaWebFunctionRevisionProvider,
  resetWebFunctionRevisionCreateRetryStateForTests,
} from '../../../src/provisioning/providers/lambda-web-function-revision-provider.js';
import { LambdaWebFunctionEndpointProvider } from '../../../src/provisioning/providers/lambda-web-function-endpoint-provider.js';
import {
  parseWebFunctionChildArn,
  projectOntoRecorded,
} from '../../../src/provisioning/providers/lambda-web-function-arns.js';
import { RESOURCE_NOT_FOUND } from '../../../src/types/resource.js';
import { createdBeforeFailure } from '../../../src/provisioning/auxiliary-failure.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const FN_ARN = 'arn:aws:lambda:us-east-1:123456789012:web-function/my-fn';
const REV_ARN = `${FN_ARN}/revision/rev-abc12`;
const EP_ARN = `${FN_ARN}/endpoint/prod`;
const ROLE = 'arn:aws:iam::123456789012:role/exec';
const REV_TYPE = 'AWS::Lambda::WebFunctionRevision';
const EP_TYPE = 'AWS::Lambda::WebFunctionEndpoint';

function callsOf(klass: { new (...args: never[]): unknown }): Array<{ input: Record<string, unknown> }> {
  return mockSend.mock.calls
    .filter((call) => (call[0] as object).constructor.name === klass.name)
    .map((call) => call[0] as { input: Record<string, unknown> });
}

function notFound(): ResourceNotFoundException {
  return new ResourceNotFoundException({ message: 'does not exist', $metadata: {} });
}

/** Route each command class to a queue of responses (an Error is thrown). */
function respond(map: Map<string, unknown[]>): void {
  mockSend.mockImplementation(async (cmd: object) => {
    const queue = map.get(cmd.constructor.name);
    if (!queue || queue.length === 0) throw new Error(`unexpected ${cmd.constructor.name}`);
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return next;
  });
}

beforeEach(() => {
  resetWebFunctionRevisionCreateRetryStateForTests();
  mockSend.mockReset();
  warn.mockReset();
  clientRegion = 'us-east-1';
});

describe('parseWebFunctionChildArn', () => {
  it('splits a revision and an endpoint ARN, and refuses the other kind or a malformed id', () => {
    expect(parseWebFunctionChildArn(REV_ARN, 'revision')).toEqual({
      functionArn: FN_ARN,
      childId: 'rev-abc12',
    });
    expect(parseWebFunctionChildArn(EP_ARN, 'endpoint')).toEqual({ functionArn: FN_ARN, childId: 'prod' });
    expect(parseWebFunctionChildArn(REV_ARN, 'endpoint')).toBeUndefined();
    expect(parseWebFunctionChildArn('rev-abc12', 'revision')).toBeUndefined();
    expect(parseWebFunctionChildArn(`${REV_ARN}/extra`, 'revision')).toBeUndefined();
  });
});

describe('projectOntoRecorded', () => {
  it('keeps only the recorded keys, recursing into objects, and drops a key the live side lacks', () => {
    expect(
      projectOntoRecorded(
        { ExecutionRoleArn: 'r', TimeoutSeconds: 10, EnvironmentVariables: { A: '1' } },
        { ExecutionRoleArn: 'r', MaxConcurrencyPerEnvironment: 64, EnvironmentVariables: { A: '2' } }
      )
    ).toEqual({ ExecutionRoleArn: 'r', EnvironmentVariables: { A: '2' } });
  });
});

describe('LambdaWebFunctionRevisionProvider', () => {
  const provider = new LambdaWebFunctionRevisionProvider();
  const props = {
    FunctionName: FN_ARN,
    Description: 'v2',
    BuildConfig: {
      CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip', VersionId: 'v1' } },
      RuntimeConfig: { Runtime: 'nodejs24.x' },
    },
    ServiceConfig: {
      ExecutionRoleArn: ROLE,
      TimeoutSeconds: '30',
      MaxConcurrencyPerEnvironment: 8,
      EgressNetworkConnectorArn: 'arn:aws:lambda:us-east-1:123456789012:network-connector:nc-1:1',
      EnvironmentVariables: { STAGE: 'dev' },
      TelemetryConfig: {
        LoggingConfig: { LogGroup: '/custom', ApplicationLogLevel: 'WARN', SystemLogLevel: 'DEBUG' },
      },
    },
  };

  it('create sends every declared member in the SDK shape and waits until the revision is Active', async () => {
    const createdAt = new Date('2026-10-15T00:00:00Z');
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12', state: 'Pending' }]],
        [
          'GetWebFunctionRevisionCommand',
          [
            { state: 'Pending' },
            { revisionArn: REV_ARN, revisionId: 'rev-abc12', functionArn: FN_ARN, state: 'Active', createdAt },
          ],
        ],
      ])
    );

    const result = await provider.create('Rev', REV_TYPE, props);

    expect(callsOf(CreateWebFunctionRevisionCommand)[0]!.input).toEqual({
      functionName: FN_ARN,
      description: 'v2',
      buildConfig: {
        codeConfig: { s3Object: { bucket: 'code-bucket', key: 'app.zip', versionId: 'v1' } },
        runtimeConfig: { runtime: 'nodejs24.x' },
      },
      serviceConfig: {
        executionRoleArn: ROLE,
        timeoutSeconds: 30,
        maxConcurrencyPerEnvironment: 8,
        egressNetworkConnectorArn: 'arn:aws:lambda:us-east-1:123456789012:network-connector:nc-1:1',
        environmentVariables: { STAGE: 'dev' },
        telemetryConfig: {
          loggingConfig: { logGroup: '/custom', applicationLogLevel: 'WARN', systemLogLevel: 'DEBUG' },
        },
      },
    });
    expect(callsOf(GetWebFunctionRevisionCommand)).toHaveLength(2);
    expect(result).toEqual({
      physicalId: REV_ARN,
      attributes: {
        RevisionArn: REV_ARN,
        RevisionId: 'rev-abc12',
        FunctionArn: FN_ARN,
        State: 'Active',
        CreatedAt: createdAt.toISOString(),
      },
    });
  });

  it('create fails with the revision ARN attached when the revision ends Failed', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
        [
          'GetWebFunctionRevisionCommand',
          [{ state: 'Failed', stateReason: 'build failed', errors: [{ errorCode: 'E1', errorMessage: 'bad zip' }] }],
        ],
      ])
    );
    const error = await provider.create('Rev', REV_TYPE, props).catch((e: unknown) => e);
    expect(String(error)).toContain('entered Failed: build failed (E1 bad zip)');
    // Premise: the cleanup delete was refused (no DeleteWebFunctionRevision answer).
    expect(callsOf(DeleteWebFunctionRevisionCommand)).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Rev', REV_TYPE)).toBe(REV_ARN);
    // go-to-k/cdkd#4945: a replayed CreateWebFunctionRevision would make another.
    expect(isMarkedNonRetryable(error)).toBe(true);
  });

  it('create deletes the revision a later step failed after, leaving the error retryable (#4945)', async () => {
    const throttled = Object.assign(new Error('Rate exceeded'), { name: 'ThrottlingException' });
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
        ['GetWebFunctionRevisionCommand', [throttled, notFound()]],
        ['DeleteWebFunctionRevisionCommand', [{}]],
      ])
    );
    const error = await provider.create('Rev', REV_TYPE, props).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(callsOf(DeleteWebFunctionRevisionCommand)).toHaveLength(1);
    expect(createdBeforeFailure(error, 'Rev', REV_TYPE)).toBeUndefined();
    expect(isMarkedNonRetryable(error)).toBe(false);
  });

  it('create marks nothing when CreateWebFunctionRevision itself fails', async () => {
    respond(new Map<string, unknown[]>([['CreateWebFunctionRevisionCommand', [new Error('S3 object does not exist')]]]));
    const error = await provider.create('Rev', REV_TYPE, props).catch((e: unknown) => e);
    expect(createdBeforeFailure(error, 'Rev', REV_TYPE)).toBeUndefined();
  });

  it('create refuses a missing ExecutionRoleArn or a non-integer TimeoutSeconds before any call', async () => {
    await expect(
      provider.create('Rev', REV_TYPE, { ...props, ServiceConfig: { TimeoutSeconds: 3 } })
    ).rejects.toThrow('ServiceConfig.ExecutionRoleArn is a required string');
    await expect(
      provider.create('Rev', REV_TYPE, { ...props, ServiceConfig: { ExecutionRoleArn: ROLE, TimeoutSeconds: 'abc' } })
    ).rejects.toThrow('ServiceConfig.TimeoutSeconds must be an integer');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create omits a non-integer TimeoutSeconds with a warning when replaying a state record', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active', revisionArn: REV_ARN }]],
      ])
    );
    await provider.create(
      'Rev',
      REV_TYPE,
      { ...props, ServiceConfig: { ExecutionRoleArn: ROLE, TimeoutSeconds: 'abc' } },
      { replayingState: true }
    );
    const sent = callsOf(CreateWebFunctionRevisionCommand)[0]!.input['serviceConfig'] as Record<string, unknown>;
    expect(sent).toEqual({ executionRoleArn: ROLE });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ServiceConfig.TimeoutSeconds must be an integer'));
  });

  it('update is refused as a replacement, after the region check', async () => {
    await expect(provider.update('Rev', REV_ARN, REV_TYPE, props, props)).rejects.toBeInstanceOf(
      ResourceUpdateNotSupportedError
    );
    clientRegion = 'eu-west-1';
    await expect(
      provider.update('Rev', REV_ARN, REV_TYPE, props, props, { expectedRegion: 'us-east-1' })
    ).rejects.not.toBeInstanceOf(ResourceUpdateNotSupportedError);
  });

  it('delete addresses the revision by its function ARN and its own ARN, then confirms it is gone', async () => {
    respond(
      new Map<string, unknown[]>([
        ['DeleteWebFunctionRevisionCommand', [{}]],
        ['GetWebFunctionRevisionCommand', [notFound()]],
      ])
    );
    await provider.delete('Rev', REV_ARN, REV_TYPE);
    expect(callsOf(DeleteWebFunctionRevisionCommand)[0]!.input).toEqual({
      functionName: FN_ARN,
      revisionId: REV_ARN,
    });
  });

  it('delete treats not-found as deleted in the expected region, and refuses it from another region', async () => {
    respond(new Map<string, unknown[]>([['DeleteWebFunctionRevisionCommand', [notFound()]]]));
    await expect(provider.delete('Rev', REV_ARN, REV_TYPE, {}, { expectedRegion: 'us-east-1' })).resolves.toBeUndefined();
    clientRegion = 'eu-west-1';
    await expect(provider.delete('Rev', REV_ARN, REV_TYPE, {}, { expectedRegion: 'us-east-1' })).rejects.toThrow();
  });

  it('delete surfaces the in-use refusal instead of reporting the revision deleted', async () => {
    respond(
      new Map<string, unknown[]>([
        [
          'DeleteWebFunctionRevisionCommand',
          [new ConflictException({ message: 'endpoints [prod] are using it', $metadata: {} })],
        ],
      ])
    );
    await expect(provider.delete('Rev', REV_ARN, REV_TYPE)).rejects.toThrow('endpoints [prod] are using it');
  });

  it('delete refuses a recorded id that is not a revision ARN, without a call', async () => {
    await expect(provider.delete('Rev', 'rev-abc12', REV_TYPE)).rejects.toThrow('is not a revision ARN');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('import adopts a revision ARN, returns null when it is gone, and refuses a bare id', async () => {
    respond(new Map<string, unknown[]>([['GetWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, state: 'Active' }]]]));
    await expect(
      provider.import({ logicalId: 'Rev', resourceType: REV_TYPE, knownPhysicalId: REV_ARN } as never)
    ).resolves.toMatchObject({ physicalId: REV_ARN });
    respond(new Map<string, unknown[]>([['GetWebFunctionRevisionCommand', [notFound()]]]));
    await expect(
      provider.import({ logicalId: 'Rev', resourceType: REV_TYPE, knownPhysicalId: REV_ARN } as never)
    ).resolves.toBeNull();
    await expect(
      provider.import({ logicalId: 'Rev', resourceType: REV_TYPE, knownPhysicalId: 'rev-abc12' } as never)
    ).rejects.toThrow('must be a Lambda web function revision ARN');
  });

  it('readCurrentState lays AWS defaults away and echoes a recorded function NAME', async () => {
    respond(
      new Map<string, unknown[]>([
        [
          'GetWebFunctionRevisionCommand',
          [
            {
              functionArn: FN_ARN,
              buildConfig: {
                codeConfig: { s3Object: { bucket: 'code-bucket', key: 'app.zip' } },
                runtimeConfig: { runtime: 'nodejs24.x' },
              },
              serviceConfig: {
                executionRoleArn: ROLE,
                maxConcurrencyPerEnvironment: 64,
                telemetryConfig: { loggingConfig: { logGroup: '/aws/lambda/web/my-fn' } },
              },
            },
          ],
        ],
      ])
    );
    const recorded = {
      FunctionName: 'my-fn',
      BuildConfig: {
        CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip' } },
        RuntimeConfig: { Runtime: 'nodejs24.x' },
      },
      ServiceConfig: { ExecutionRoleArn: ROLE },
    };
    await expect(provider.readCurrentState(REV_ARN, 'Rev', REV_TYPE, recorded)).resolves.toEqual(recorded);
    respond(new Map<string, unknown[]>([['GetWebFunctionRevisionCommand', [notFound()]]]));
    await expect(provider.readCurrentState(REV_ARN, 'Rev', REV_TYPE, recorded)).resolves.toBe(RESOURCE_NOT_FOUND);
  });
});

describe('LambdaWebFunctionEndpointProvider', () => {
  const provider = new LambdaWebFunctionEndpointProvider();
  const props = {
    FunctionName: FN_ARN,
    EndpointName: 'prod',
    EndpointType: 'HomeRegion',
    AuthType: 'IamAuth',
    Description: 'main',
    RevisionWeights: [{ RevisionId: 'rev-abc12', Weight: '100' }],
    Regions: ['us-east-1'],
    ScalingConfig: { MaxEnvironments: 5 },
    ThrottleConfig: { RateLimit: 100 },
  };
  const active = {
    endpointArn: EP_ARN,
    functionArn: FN_ARN,
    domainName: 'x.lambda-web.us-east-1.on.aws',
    state: 'Active',
    updateStatus: 'Successful',
    revisionWeights: [{ revisionId: 'rev-abc12', weight: 100 }],
  };

  it('create sends the SDK shape and waits for Active', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionEndpointCommand', [{ endpointArn: EP_ARN, state: 'Pending' }]],
        ['GetWebFunctionEndpointCommand', [{ state: 'Pending' }, active]],
      ])
    );
    const result = await provider.create('Ep', EP_TYPE, props);
    expect(callsOf(CreateWebFunctionEndpointCommand)[0]!.input).toEqual({
      functionName: FN_ARN,
      endpointName: 'prod',
      endpointType: 'HomeRegion',
      authType: 'IamAuth',
      description: 'main',
      revisionWeights: [{ revisionId: 'rev-abc12', weight: 100 }],
      regions: ['us-east-1'],
      scalingConfig: { maxEnvironments: 5 },
      throttleConfig: { rateLimit: 100 },
    });
    expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(2);
    expect(result.physicalId).toBe(EP_ARN);
    expect(result.attributes).toMatchObject({ EndpointArn: EP_ARN, DomainName: 'x.lambda-web.us-east-1.on.aws' });
  });

  it('update moves the weights and waits until UpdateStatus leaves InProgress', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        [
          'GetWebFunctionEndpointCommand',
          [
            // A read taken before the update turned InProgress: old weights, Successful.
            active,
            { ...active, updateStatus: 'InProgress' },
            { ...active, revisionWeights: [{ revisionId: 'rev-new', weight: 100 }] },
          ],
        ],
      ])
    );
    const next = { ...props, RevisionWeights: [{ RevisionId: 'rev-new', Weight: 100 }] };
    await provider.update('Ep', EP_ARN, EP_TYPE, next, props);
    expect(callsOf(UpdateWebFunctionEndpointCommand)[0]!.input).toEqual({
      functionName: FN_ARN,
      endpointName: 'prod',
      description: 'main',
      authType: 'IamAuth',
      revisionWeights: [{ revisionId: 'rev-new', weight: 100 }],
      scalingConfig: { maxEnvironments: 5 },
      throttleConfig: { rateLimit: 100 },
    });
    // Not on the first read: it still reported the OLD weights.
    expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(3);
  });

  it('update sends a removed Description / ScalingConfig / ThrottleConfig cleared', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [active]],
      ])
    );
    const { Description: _d, ScalingConfig: _s, ThrottleConfig: _t, ...rest } = props;
    await provider.update('Ep', EP_ARN, EP_TYPE, rest, props);
    expect(callsOf(UpdateWebFunctionEndpointCommand)[0]!.input).toMatchObject({
      description: '',
      scalingConfig: {},
      throttleConfig: {},
    });
  });

  it('update refuses a malformed ScalingConfig on the template path, and leaves it unsent on a replay', async () => {
    const bad = { ...props, ScalingConfig: { MaxEnvironments: 'many' } };
    await expect(provider.update('Ep', EP_ARN, EP_TYPE, bad, props)).rejects.toThrow(
      'ScalingConfig.MaxEnvironments must be an integer'
    );
    expect(mockSend).not.toHaveBeenCalled();

    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [active]],
      ])
    );
    await provider.update('Ep', EP_ARN, EP_TYPE, bad, props, { replayingState: true });
    expect(callsOf(UpdateWebFunctionEndpointCommand)[0]!.input).not.toHaveProperty('scalingConfig');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('leaving the live ScalingConfig unchanged'));
  });

  it('update refuses malformed RevisionWeights even when replaying a state record', async () => {
    await expect(
      provider.update('Ep', EP_ARN, EP_TYPE, { ...props, RevisionWeights: [{ RevisionId: 'r', Weight: 'x' }] }, props, {
        replayingState: true,
      })
    ).rejects.toThrow('RevisionWeights[0].Weight must be an integer');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update refuses a wrong-region client before any write', async () => {
    clientRegion = 'eu-west-1';
    await expect(
      provider.update('Ep', EP_ARN, EP_TYPE, props, props, { expectedRegion: 'us-east-1' })
    ).rejects.toThrow();
    expect(callsOf(UpdateWebFunctionEndpointCommand)).toHaveLength(0);
  });

  it('update fails when the endpoint update ends Failed', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [{ ...active, updateStatus: 'Failed', updateStatusReason: 'no capacity' }]],
      ])
    );
    await expect(provider.update('Ep', EP_ARN, EP_TYPE, props, props)).rejects.toThrow('update failed: no capacity');
  });

  it('delete addresses the endpoint by function ARN + name, then confirms it is gone', async () => {
    respond(
      new Map<string, unknown[]>([
        ['DeleteWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [active, notFound()]],
      ])
    );
    await provider.delete('Ep', EP_ARN, EP_TYPE);
    expect(callsOf(DeleteWebFunctionEndpointCommand)[0]!.input).toEqual({
      functionName: FN_ARN,
      endpointName: 'prod',
    });
    expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(2);
  });

  it('delete treats not-found as deleted in the expected region, and refuses it from another region', async () => {
    respond(new Map<string, unknown[]>([['DeleteWebFunctionEndpointCommand', [notFound()]]]));
    await expect(provider.delete('Ep', EP_ARN, EP_TYPE, {}, { expectedRegion: 'us-east-1' })).resolves.toBeUndefined();
    clientRegion = 'eu-west-1';
    await expect(provider.delete('Ep', EP_ARN, EP_TYPE, {}, { expectedRegion: 'us-east-1' })).rejects.toThrow();
  });

  it('import finds the endpoint from FunctionName + EndpointName, or returns null', async () => {
    respond(new Map<string, unknown[]>([['GetWebFunctionEndpointCommand', [active]]]));
    await expect(
      provider.import({ logicalId: 'Ep', resourceType: EP_TYPE, properties: props } as never)
    ).resolves.toMatchObject({ physicalId: EP_ARN });
    expect(callsOf(GetWebFunctionEndpointCommand)[0]!.input).toEqual({ functionName: FN_ARN, endpointName: 'prod' });
    respond(new Map<string, unknown[]>([['GetWebFunctionEndpointCommand', [notFound()]]]));
    await expect(
      provider.import({ logicalId: 'Ep', resourceType: EP_TYPE, properties: props } as never)
    ).resolves.toBeNull();
  });

  it('readCurrentState reports the live endpoint in the CFn shape, a cleared block as {}', async () => {
    respond(
      new Map<string, unknown[]>([
        [
          'GetWebFunctionEndpointCommand',
          [
            {
              ...active,
              endpointName: 'prod',
              endpointType: 'HomeRegion',
              authType: 'IamAuth',
              description: 'main',
              revisionWeights: [{ revisionId: 'rev-abc12', weight: 100 }],
              regions: ['us-east-1'],
              scalingConfig: {},
              throttleConfig: { rateLimit: 100 },
            },
          ],
        ],
      ])
    );
    const live = (await provider.readCurrentState(EP_ARN, 'Ep', EP_TYPE, props)) as Record<string, unknown>;
    expect(live).toEqual({
      FunctionName: FN_ARN,
      EndpointName: 'prod',
      Description: 'main',
      EndpointType: 'HomeRegion',
      AuthType: 'IamAuth',
      RevisionWeights: [{ RevisionId: 'rev-abc12', Weight: 100 }],
      Regions: ['us-east-1'],
      ScalingConfig: {},
      ThrottleConfig: { RateLimit: 100 },
    });
  });
});

describe('LambdaWebFunctionRevisionProvider — guards, attributes and ambiguous creates', () => {
  const provider = new LambdaWebFunctionRevisionProvider();
  const base = {
    FunctionName: FN_ARN,
    BuildConfig: {
      CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip' } },
      RuntimeConfig: { Runtime: 'nodejs24.x' },
    },
    ServiceConfig: { ExecutionRoleArn: ROLE },
  };
  const created = new Map<string, unknown[]>([
    ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
    ['GetWebFunctionRevisionCommand', [{ state: 'Active', revisionArn: REV_ARN }]],
  ]);

  it('create forwards KmsKeyArn', async () => {
    respond(created);
    await provider.create('Rev', REV_TYPE, { ...base, KmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/k' });
    expect(callsOf(CreateWebFunctionRevisionCommand)[0]!.input['kmsKeyArn']).toBe(
      'arn:aws:kms:us-east-1:123456789012:key/k'
    );
  });

  it.each([
    ['FunctionName', { ...base, FunctionName: '' }, 'FunctionName must be a non-empty string'],
    ['BuildConfig', { ...base, BuildConfig: 'x' }, 'BuildConfig must be an object'],
    [
      'S3Object',
      { ...base, BuildConfig: { CodeConfig: {}, RuntimeConfig: { Runtime: 'nodejs24.x' } } },
      'S3Object.Bucket and .Key are required strings',
    ],
    [
      'Runtime',
      { ...base, BuildConfig: { CodeConfig: base.BuildConfig.CodeConfig, RuntimeConfig: {} } },
      'RuntimeConfig.Runtime is a required string',
    ],
  ])('create refuses a malformed %s before any call', async (_name, properties, message) => {
    await expect(provider.create('Rev', REV_TYPE, properties)).rejects.toThrow(message);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('create refuses non-string EnvironmentVariables, and omits them with a warning on a replay', async () => {
    const bad = { ...base, ServiceConfig: { ExecutionRoleArn: ROLE, EnvironmentVariables: { A: 1 } } };
    await expect(provider.create('Rev', REV_TYPE, bad)).rejects.toThrow(
      'ServiceConfig.EnvironmentVariables must be an object of string values'
    );
    expect(mockSend).not.toHaveBeenCalled();
    respond(created);
    await provider.create('Rev', REV_TYPE, bad, { replayingState: true });
    expect(callsOf(CreateWebFunctionRevisionCommand)[0]!.input['serviceConfig']).toEqual({
      executionRoleArn: ROLE,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('omitting it while replaying'));
  });

  it('getAttribute reads RevisionId / FunctionArn off the ARN and State from AWS', async () => {
    await expect(provider.getAttribute(REV_ARN, REV_TYPE, 'RevisionId')).resolves.toBe('rev-abc12');
    await expect(provider.getAttribute(REV_ARN, REV_TYPE, 'FunctionArn')).resolves.toBe(FN_ARN);
    await expect(provider.getAttribute(REV_ARN, REV_TYPE, 'RevisionArn')).resolves.toBe(REV_ARN);
    expect(mockSend).not.toHaveBeenCalled();
    respond(new Map<string, unknown[]>([['GetWebFunctionRevisionCommand', [{ state: 'Active' }]]]));
    await expect(provider.getAttribute(REV_ARN, REV_TYPE, 'State')).resolves.toBe('Active');
  });

  it('delete keeps polling until the revision reads as gone', async () => {
    respond(
      new Map<string, unknown[]>([
        ['DeleteWebFunctionRevisionCommand', [{}]],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active' }, notFound()]],
      ])
    );
    await provider.delete('Rev', REV_ARN, REV_TYPE);
    expect(callsOf(GetWebFunctionRevisionCommand)).toHaveLength(2);
  });

  it('after an ambiguous (5xx) create, the next create first lists the revisions it may have made', async () => {
    const serverError = Object.assign(new Error('internal error'), {
      name: 'InternalServerException',
      $metadata: { httpStatusCode: 500 },
      $fault: 'server',
    });
    respond(new Map<string, unknown[]>([['CreateWebFunctionRevisionCommand', [serverError]]]));
    await expect(provider.create('Rev', REV_TYPE, base)).rejects.toThrow('internal error');

    mockSend.mockClear();
    const orphan = `${FN_ARN}/revision/rev-orphan`;
    respond(
      new Map<string, unknown[]>([
        ['ListWebFunctionRevisionsCommand', [{ revisions: [{ revisionArn: orphan, createdAt: new Date() }] }]],
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active', revisionArn: REV_ARN }]],
      ])
    );
    await provider.create('Rev', REV_TYPE, base);
    const order = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    expect(order.indexOf('ListWebFunctionRevisionsCommand')).toBeLessThan(
      order.indexOf('CreateWebFunctionRevisionCommand')
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rev-orphan'));
  });

  it('a plain create lists nothing', async () => {
    respond(created);
    await provider.create('Rev', REV_TYPE, base);
    expect(callsOf(ListWebFunctionRevisionsCommand)).toHaveLength(0);
  });
});

describe('LambdaWebFunctionEndpointProvider — guards, attributes and failures', () => {
  const provider = new LambdaWebFunctionEndpointProvider();
  const base = {
    FunctionName: FN_ARN,
    EndpointName: 'prod',
    EndpointType: 'HomeRegion',
    AuthType: 'IamAuth',
    RevisionWeights: [{ RevisionId: 'rev-abc12', Weight: 100 }],
  };
  const active = {
    endpointArn: EP_ARN,
    state: 'Active',
    updateStatus: 'Successful',
    revisionWeights: [{ revisionId: 'rev-abc12', weight: 100 }],
  };

  it('create fails with the endpoint ARN attached when it ends Failed, and marks nothing when the create call fails', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionEndpointCommand', [{ endpointArn: EP_ARN }]],
        ['GetWebFunctionEndpointCommand', [{ state: 'Failed', stateReason: 'no capacity' }]],
      ])
    );
    const failed = await provider.create('Ep', EP_TYPE, base).catch((e: unknown) => e);
    expect(String(failed)).toContain('entered Failed: no capacity');
    expect(createdBeforeFailure(failed, 'Ep', EP_TYPE)).toBe(EP_ARN);

    respond(new Map<string, unknown[]>([['CreateWebFunctionEndpointCommand', [new Error('denied')]]]));
    const refused = await provider.create('Ep', EP_TYPE, base).catch((e: unknown) => e);
    expect(createdBeforeFailure(refused, 'Ep', EP_TYPE)).toBeUndefined();
  });

  it('create reads a not-found right after the create as not yet visible', async () => {
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionEndpointCommand', [{ endpointArn: EP_ARN }]],
        ['GetWebFunctionEndpointCommand', [notFound(), active]],
      ])
    );
    await expect(provider.create('Ep', EP_TYPE, base)).resolves.toMatchObject({ physicalId: EP_ARN });
  });

  it.each([
    ['AuthType', { ...base, AuthType: undefined }, 'AuthType must be a non-empty string'],
    ['Regions', { ...base, Regions: 'us-east-1' }, 'Regions must be a list of strings'],
    ['ThrottleConfig', { ...base, ThrottleConfig: { RateLimit: 'fast' } }, 'ThrottleConfig.RateLimit must be an integer'],
  ])('create refuses a malformed %s before any call', async (_name, properties, message) => {
    await expect(provider.create('Ep', EP_TYPE, properties)).rejects.toThrow(message);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('update refuses a template that drops RevisionWeights, and leaves them unsent on a state-borne bag', async () => {
    const { RevisionWeights: _w, ...noWeights } = base;
    await expect(provider.update('Ep', EP_ARN, EP_TYPE, noWeights, base)).rejects.toThrow(
      'RevisionWeights is required'
    );
    expect(mockSend).not.toHaveBeenCalled();
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [active]],
      ])
    );
    await provider.update('Ep', EP_ARN, EP_TYPE, noWeights, base, { desiredFromAwsReadback: true });
    expect(callsOf(UpdateWebFunctionEndpointCommand)[0]!.input).not.toHaveProperty('revisionWeights');
  });

  it('update warns instead of refusing a malformed block under drift --revert', async () => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [active]],
      ])
    );
    await provider.update('Ep', EP_ARN, EP_TYPE, { ...base, ScalingConfig: 'big' }, base, {
      desiredFromAwsReadback: true,
    });
    expect(callsOf(UpdateWebFunctionEndpointCommand)[0]!.input).not.toHaveProperty('scalingConfig');
  });

  it('update and delete refuse a recorded id that is not an endpoint ARN, without a call', async () => {
    await expect(provider.update('Ep', REV_ARN, EP_TYPE, base, base)).rejects.toThrow('is not an endpoint ARN');
    await expect(provider.delete('Ep', 'prod', EP_TYPE)).rejects.toThrow('is not an endpoint ARN');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('import adopts an endpoint ARN override and refuses a bare name', async () => {
    respond(new Map<string, unknown[]>([['GetWebFunctionEndpointCommand', [active]]]));
    await expect(
      provider.import({ logicalId: 'Ep', resourceType: EP_TYPE, knownPhysicalId: EP_ARN } as never)
    ).resolves.toMatchObject({ physicalId: EP_ARN });
    expect(callsOf(GetWebFunctionEndpointCommand)[0]!.input).toEqual({ functionName: FN_ARN, endpointName: 'prod' });
    await expect(
      provider.import({ logicalId: 'Ep', resourceType: EP_TYPE, knownPhysicalId: 'prod' } as never)
    ).rejects.toThrow('must be a Lambda web function endpoint ARN');
  });

  it('getAttribute reads FunctionArn off the ARN and DomainName from AWS', async () => {
    await expect(provider.getAttribute(EP_ARN, EP_TYPE, 'FunctionArn')).resolves.toBe(FN_ARN);
    expect(mockSend).not.toHaveBeenCalled();
    respond(new Map<string, unknown[]>([['GetWebFunctionEndpointCommand', [{ domainName: 'd.on.aws' }]]]));
    await expect(provider.getAttribute(EP_ARN, EP_TYPE, 'DomainName')).resolves.toBe('d.on.aws');
  });

  describe('RegionalEndpoints.<region>.<Member> attributes', () => {
    const regionalEndpoints = {
      'ap-northeast-1': { domainName: 'a.lambda-web.ap-northeast-1.on.aws', state: 'Active' },
      'us-west-2': {
        domainName: 'b.lambda-web.us-west-2.on.aws',
        authType: 'IamAuth',
        state: 'Active',
        updateStatus: 'Successful',
      },
    };

    it('getAttribute resolves a regional DomainName, and an absent region or member is undefined', async () => {
      const get = (name: string): Promise<unknown> => provider.getAttribute(EP_ARN, EP_TYPE, name);
      const read = (): void =>
        respond(new Map<string, unknown[]>([['GetWebFunctionEndpointCommand', [{ regionalEndpoints }]]]));
      read();
      await expect(get('RegionalEndpoints.us-west-2.DomainName')).resolves.toBe(
        'b.lambda-web.us-west-2.on.aws'
      );
      read();
      await expect(get('RegionalEndpoints.ap-northeast-1.State')).resolves.toBe('Active');
      read();
      await expect(get('RegionalEndpoints.eu-central-1.DomainName')).resolves.toBeUndefined();
      read();
      await expect(get('RegionalEndpoints.ap-northeast-1.AuthType')).resolves.toBeUndefined();
    });

    it('create and update record the regional members as flat dot-keys in the attribute map', async () => {
      const active = {
        endpointArn: EP_ARN,
        state: 'Active',
        updateStatus: 'Successful',
        revisionWeights: [{ revisionId: 'rev-abc12', weight: 100 }],
        regionalEndpoints,
      };
      // The first read is taken before the endpoint settles and carries no
      // regional members; the recorded map is the SETTLED read's.
      respond(
        new Map<string, unknown[]>([
          ['CreateWebFunctionEndpointCommand', [{ endpointArn: EP_ARN }]],
          ['GetWebFunctionEndpointCommand', [{ endpointArn: EP_ARN, state: 'Pending' }, active]],
        ])
      );
      const created = await provider.create('Ep', EP_TYPE, base);
      expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(2);
      expect(created.attributes).toMatchObject({
        'RegionalEndpoints.us-west-2.DomainName': 'b.lambda-web.us-west-2.on.aws',
        'RegionalEndpoints.us-west-2.AuthType': 'IamAuth',
        'RegionalEndpoints.ap-northeast-1.DomainName': 'a.lambda-web.ap-northeast-1.on.aws',
      });
      // An unassigned member is absent, never recorded as undefined or ''.
      expect(created.attributes).not.toHaveProperty('RegionalEndpoints.ap-northeast-1.AuthType');
      expect(created.attributes).not.toHaveProperty('RegionalEndpoints');

      mockSend.mockReset();
      respond(
        new Map<string, unknown[]>([
          ['UpdateWebFunctionEndpointCommand', [{}]],
          ['GetWebFunctionEndpointCommand', [active]],
        ])
      );
      const updated = await provider.update('Ep', EP_ARN, EP_TYPE, base, base);
      expect(updated.attributes).toMatchObject({
        'RegionalEndpoints.us-west-2.DomainName': 'b.lambda-web.us-west-2.on.aws',
      });
    });

    it('records the wire shape of a MultiRegion endpoint: a null regional domainName is absent, the rest is kept', async () => {
      // Observed from a live MultiRegion endpoint: every region reports
      // `domainName: null` (the domain is the endpoint's global one).
      respond(
        new Map<string, unknown[]>([
          [
            'GetWebFunctionEndpointCommand',
            [
              {
                endpointArn: EP_ARN,
                domainName: 'g.lambda-web.global.on.aws',
                regionalEndpoints: {
                  'us-west-2': { domainName: null, authType: 'IamAuth', state: 'Active', updateStatus: null },
                },
              },
            ],
          ],
        ])
      );
      const found = await provider.import({
        logicalId: 'Ep',
        resourceType: EP_TYPE,
        knownPhysicalId: EP_ARN,
      } as never);
      expect(found?.attributes).toMatchObject({
        DomainName: 'g.lambda-web.global.on.aws',
        'RegionalEndpoints.us-west-2.AuthType': 'IamAuth',
        'RegionalEndpoints.us-west-2.State': 'Active',
      });
      expect(found?.attributes).not.toHaveProperty('RegionalEndpoints.us-west-2.DomainName');
      expect(found?.attributes).not.toHaveProperty('RegionalEndpoints.us-west-2.UpdateStatus');
    });

    it('import (the stale-record heal read) supplies the regional members a pre-fix record lacks', async () => {
      respond(
        new Map<string, unknown[]>([
          ['GetWebFunctionEndpointCommand', [{ endpointArn: EP_ARN, state: 'Active', regionalEndpoints }]],
        ])
      );
      const found = await provider.import({
        logicalId: 'Ep',
        resourceType: EP_TYPE,
        knownPhysicalId: EP_ARN,
      } as never);
      expect(found?.physicalId).toBe(EP_ARN);
      expect(found?.attributes).toMatchObject({
        'RegionalEndpoints.us-west-2.DomainName': 'b.lambda-web.us-west-2.on.aws',
        'RegionalEndpoints.ap-northeast-1.DomainName': 'a.lambda-web.ap-northeast-1.on.aws',
      });
    });

    it('an endpoint with no regionalEndpoints records none', async () => {
      respond(
        new Map<string, unknown[]>([
          ['CreateWebFunctionEndpointCommand', [{ endpointArn: EP_ARN }]],
          ['GetWebFunctionEndpointCommand', [active]],
        ])
      );
      const created = await provider.create('Ep', EP_TYPE, base);
      expect(Object.keys(created.attributes ?? {}).some((k) => k.startsWith('RegionalEndpoints.'))).toBe(false);
    });
  });
});

describe('Lambda Web providers — re-review round 2 gaps', () => {
  const revision = new LambdaWebFunctionRevisionProvider();
  const endpoint = new LambdaWebFunctionEndpointProvider();
  const revBase = {
    FunctionName: FN_ARN,
    BuildConfig: {
      CodeConfig: { S3Object: { Bucket: 'code-bucket', Key: 'app.zip' } },
      RuntimeConfig: { Runtime: 'nodejs24.x' },
    },
    ServiceConfig: { ExecutionRoleArn: ROLE },
  };
  const epBase = {
    FunctionName: FN_ARN,
    EndpointName: 'prod',
    EndpointType: 'HomeRegion',
    AuthType: 'IamAuth',
    RevisionWeights: [{ RevisionId: 'rev-abc12', Weight: 100 }],
  };
  const serverError = (): Error =>
    Object.assign(new Error('internal error'), {
      name: 'InternalServerException',
      $metadata: { httpStatusCode: 500 },
      $fault: 'server',
    });

  it('the orphan report names neither a revision this process recorded nor one outside the window', async () => {
    const recorded = `${FN_ARN}/revision/rev-recorded`;
    // An earlier successful create in this process records its ARN.
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: recorded, revisionId: 'rev-recorded' }]],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active' }]],
      ])
    );
    await revision.create('Rev', REV_TYPE, revBase);
    respond(new Map<string, unknown[]>([['CreateWebFunctionRevisionCommand', [serverError()]]]));
    await expect(revision.create('Rev', REV_TYPE, revBase)).rejects.toThrow('internal error');
    respond(
      new Map<string, unknown[]>([
        [
          'ListWebFunctionRevisionsCommand',
          [
            {
              revisions: [
                { revisionArn: recorded, createdAt: new Date() },
                { revisionArn: `${FN_ARN}/revision/rev-old`, createdAt: new Date(Date.now() - 86_400_000) },
                { revisionArn: `${FN_ARN}/revision/rev-orphan`, createdAt: new Date() },
              ],
            },
          ],
        ],
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active' }]],
      ])
    );
    await revision.create('Rev', REV_TYPE, revBase);
    const warned = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toContain('rev-orphan');
    expect(warned).not.toContain('rev-recorded');
    expect(warned).not.toContain('rev-old');
  });

  it('a 4xx create failure arms nothing: the next create lists no revisions', async () => {
    respond(
      new Map<string, unknown[]>([
        [
          'CreateWebFunctionRevisionCommand',
          [Object.assign(new Error('bad zip'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } })],
        ],
      ])
    );
    await expect(revision.create('Rev', REV_TYPE, revBase)).rejects.toThrow('bad zip');
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionRevisionCommand', [{ revisionArn: REV_ARN, revisionId: 'rev-abc12' }]],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active' }]],
      ])
    );
    await revision.create('Rev', REV_TYPE, revBase);
    expect(callsOf(ListWebFunctionRevisionsCommand)).toHaveLength(0);
  });

  it('a create the SDK replayed inside its send reports the candidates afterwards', async () => {
    respond(
      new Map<string, unknown[]>([
        [
          'CreateWebFunctionRevisionCommand',
          [{ revisionArn: REV_ARN, revisionId: 'rev-abc12', $metadata: { attempts: 2 } }],
        ],
        [
          'ListWebFunctionRevisionsCommand',
          [{ revisions: [{ revisionArn: `${FN_ARN}/revision/rev-twin`, createdAt: new Date() }] }],
        ],
        ['GetWebFunctionRevisionCommand', [{ state: 'Active' }]],
      ])
    );
    await revision.create('Rev', REV_TYPE, revBase);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('rev-twin'));
  });

  it('the not-found grace is create-only and bounded', async () => {
    // Update: a not-found is not a visibility gap, it throws at once.
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        ['GetWebFunctionEndpointCommand', [notFound()]],
      ])
    );
    await expect(endpoint.update('Ep', EP_ARN, EP_TYPE, epBase, epBase)).rejects.toThrow('does not exist');
    expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(1);
    // Create: a not-found that outlasts the grace throws.
    mockSend.mockClear();
    respond(
      new Map<string, unknown[]>([
        ['CreateWebFunctionEndpointCommand', [{ endpointArn: EP_ARN }]],
        ['GetWebFunctionEndpointCommand', [notFound()]],
      ])
    );
    await expect(endpoint.create('Ep', EP_TYPE, epBase)).rejects.toThrow('does not exist');
    expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(11);
  });

  const A = { RevisionId: 'rev-a', Weight: 90 };
  const B = { RevisionId: 'rev-b', Weight: 10 };
  it.each([
    ['sent a,b / read b,a', [A, B], [B, A]],
    ['sent b,a / read a,b', [B, A], [A, B]],
  ])('the update wait accepts the sent weights in any order (%s)', async (_label, sent, read) => {
    respond(
      new Map<string, unknown[]>([
        ['UpdateWebFunctionEndpointCommand', [{}]],
        [
          'GetWebFunctionEndpointCommand',
          [
            {
              endpointArn: EP_ARN,
              state: 'Active',
              updateStatus: 'Successful',
              revisionWeights: read.map((w) => ({ revisionId: w.RevisionId, weight: w.Weight })),
            },
          ],
        ],
      ])
    );
    await endpoint.update('Ep', EP_ARN, EP_TYPE, { ...epBase, RevisionWeights: sent }, epBase);
    expect(callsOf(GetWebFunctionEndpointCommand)).toHaveLength(1);
  });
});
