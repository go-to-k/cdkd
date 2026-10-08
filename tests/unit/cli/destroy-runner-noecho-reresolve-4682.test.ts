/**
 * go-to-k/cdkd#4682 end to end through `runDestroyForStack` and the real
 * `CustomResourceProvider`: `cdkd destroy` (which threads the synthesized
 * template as `noEchoReresolver`) re-resolves a custom resource's NoEcho
 * parameter into its Delete payload, the handler gets the real value and the
 * record is dropped on SUCCESS; `cdkd state destroy` (no template) keeps the
 * Phase B skip and the record. Neither persists nor logs the value.
 */

import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import type { LockManager } from '../../../src/state/lock-manager.js';
import type { ProviderRegistry } from '../../../src/provisioning/provider-registry.js';
import type { AwsClients } from '../../../src/utils/aws-clients.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

const logged = vi.hoisted(() => [] as string[]);
vi.mock('../../../src/utils/logger.js', () => {
  const record = (...args: unknown[]): void => void logged.push(args.map(String).join(' '));
  const child = {
    setLevel: () => undefined,
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: (): unknown => child,
  };
  return { getLogger: () => child };
});

vi.mock('../../../src/provisioning/register-providers.js', () => ({
  loadProviderClasses: vi.fn(async () => ({})),
  registerAllProviders: vi.fn(),
}));
vi.mock('../../../src/provisioning/provider-registry.js', () => ({
  ProviderRegistry: vi.fn(),
}));

const mockLambdaSend = vi.hoisted(() => vi.fn());
const mockS3Send = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/aws-clients.js', () => ({
  AwsClients: vi.fn(),
  setAwsClients: vi.fn(),
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: vi.fn() },
    s3: { send: mockS3Send },
    sts: { send: vi.fn(() => Promise.resolve({ Account: '123456789012' })) },
    ec2: { send: vi.fn() },
  }),
}));
vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));
vi.mock('../../../src/utils/live-renderer.js', () => ({
  getLiveRenderer: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    addTask: vi.fn(),
    removeTask: vi.fn(),
    updateTaskLabel: vi.fn(),
    printAbove: (write: () => void) => write(),
  }),
}));

import { runDestroyForStack } from '../../../src/cli/commands/destroy-runner.js';
import { CustomResourceProvider } from '../../../src/provisioning/providers/custom-resource-provider.js';
import { TemplateNoEchoReresolver } from '../../../src/deployment/noecho-delete-reresolution.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const REGION = 'us-east-1';
const VALUE = 'destroy-noecho-token-4682';
const TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:handler';

const TEMPLATE = {
  Parameters: { TokenParam: { Type: 'String', NoEcho: true, Default: VALUE } },
  Resources: {
    ParamCr: {
      Type: 'Custom::ParamReader',
      Properties: { ServiceToken: TOKEN, Token: { Ref: 'TokenParam' }, Marker: 'm' },
    },
  },
} as CloudFormationTemplate;

function makeState(): StackState {
  return {
    version: 11,
    stackName: 'NoEchoStack',
    region: REGION,
    resources: {
      ParamCr: {
        physicalId: 'cr-phys',
        resourceType: 'Custom::ParamReader',
        properties: { ServiceToken: TOKEN, Token: SECRET_MASK, Marker: 'm' },
        attributes: {},
        dependencies: [],
        noEchoLeaves: [['Token']],
      },
    },
    outputs: {},
    lastModified: 1,
  } as StackState;
}

describe('runDestroyForStack: a custom resource reading a NoEcho parameter (go-to-k/cdkd#4682)', () => {
  const saveState = vi.fn();
  const deleteState = vi.fn();
  const events: unknown[] = [];
  const provider = new CustomResourceProvider({ responseBucket: 'state-bucket' });

  function ctx(extra: Record<string, unknown> = {}) {
    return {
      stateBackend: {
        saveState,
        deleteState,
        listStacks: vi.fn().mockResolvedValue([]),
      } as unknown as S3StateBackend,
      lockManager: {
        acquireLock: vi.fn().mockResolvedValue(true),
        releaseLock: vi.fn(),
      } as unknown as LockManager,
      providerRegistry: {
        getProviderFor: () => ({ provider }),
      } as unknown as ProviderRegistry,
      baseAwsClients: {} as unknown as AwsClients,
      baseRegion: REGION,
      stateBucket: 'state-bucket',
      skipConfirmation: true,
      stackDestroy: true,
      eventRecorder: { record: (e: unknown) => void events.push(e) },
      ...extra,
    } as never;
  }

  function invokedPayload(): Record<string, unknown> | undefined {
    const invoke = mockLambdaSend.mock.calls.find(
      (c) => (c[0] as { constructor: { name: string } }).constructor.name === 'InvokeCommand'
    );
    if (invoke === undefined) return undefined;
    const input = (invoke[0] as { input: { Payload: Uint8Array } }).input;
    return JSON.parse(Buffer.from(input.Payload).toString()) as Record<string, unknown>;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    logged.length = 0;
    events.length = 0;
    resetAccountInfoCache();
    saveState.mockResolvedValue('"etag"');
    deleteState.mockResolvedValue(undefined);
    mockS3Send.mockResolvedValue({});
    mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) =>
      cmd.constructor.name === 'InvokeCommand'
        ? Promise.resolve({
            Payload: Buffer.from(JSON.stringify({ Status: 'SUCCESS', PhysicalResourceId: 'cr-phys' })),
          })
        : Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } })
    );
  });

  function nothingCarriesTheValue(): void {
    expect(logged.join('\n')).not.toContain(VALUE);
    expect(JSON.stringify(saveState.mock.calls)).not.toContain(VALUE);
    expect(JSON.stringify(events)).not.toContain(VALUE);
  }

  it('cdkd destroy (template held): the handler receives the real value and the record is dropped', async () => {
    const state = makeState();
    const result = await runDestroyForStack(
      'NoEchoStack',
      state,
      ctx({
        noEchoReresolver: new TemplateNoEchoReresolver({
          template: TEMPLATE,
          stackName: 'NoEchoStack',
          region: REGION,
        }),
      })
    );

    expect(invokedPayload()?.['ResourceProperties']).toEqual({
      ServiceToken: TOKEN,
      Token: VALUE,
      Marker: 'm',
    });
    expect(result.skippedCount).toBe(0);
    expect(result.deletedCount).toBe(1);
    expect(deleteState).toHaveBeenCalled();
    expect(state.resources['ParamCr']?.properties['Token']).toBe(SECRET_MASK);
    nothingCarriesTheValue();
  });

  it('cdkd state destroy (no template): the delete stays skipped and the record is kept', async () => {
    const result = await runDestroyForStack('NoEchoStack', makeState(), ctx());

    expect(invokedPayload()).toBeUndefined();
    expect(result.skippedCount).toBe(1);
    expect(deleteState).not.toHaveBeenCalled();
    expect(JSON.stringify(saveState.mock.calls)).toContain('ParamCr');
    nothingCarriesTheValue();
  });

  it('asks the source only for the types that read the values, and hands a nested-stack row the source', async () => {
    const valuesFor = vi.fn().mockResolvedValue(undefined);
    const source = { valuesFor } as unknown as TemplateNoEchoReresolver;
    const seen: Record<string, Record<string, unknown>> = {};
    const recording = {
      delete: vi.fn(async (id: string, _p: string, _t: string, _props: unknown, c: unknown) => {
        seen[id] = c as Record<string, unknown>;
      }),
    };
    const state = makeState();
    state.resources['Db'] = {
      physicalId: 'db',
      resourceType: 'AWS::RDS::DBInstance',
      properties: { MasterUserPassword: SECRET_MASK },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['MasterUserPassword']],
    };
    state.resources['Child'] = {
      physicalId: 'arn:child',
      resourceType: 'AWS::CloudFormation::Stack',
      properties: { Parameters: { P: SECRET_MASK } },
      attributes: {},
      dependencies: [],
      noEchoLeaves: [['Parameters', 'P']],
    };
    await runDestroyForStack(
      'NoEchoStack',
      state,
      ctx({
        noEchoReresolver: source,
        providerRegistry: { getProviderFor: () => ({ provider: recording }) },
      })
    );
    expect(valuesFor.mock.calls.map((c) => c[0]).sort()).toEqual(['Child', 'ParamCr']);
    expect(seen['Child']?.['noEchoReresolver']).toBe(source);
  });

  it('cdkd destroy whose template no longer reads the parameter there keeps the skip', async () => {
    const template = structuredClone(TEMPLATE);
    (template.Resources['ParamCr']!.Properties as Record<string, unknown>)['Token'] = 'literal';
    const result = await runDestroyForStack(
      'NoEchoStack',
      makeState(),
      ctx({
        noEchoReresolver: new TemplateNoEchoReresolver({
          template,
          stackName: 'NoEchoStack',
          region: REGION,
        }),
      })
    );
    expect(invokedPayload()).toBeUndefined();
    expect(result.skippedCount).toBe(1);
    nothingCarriesTheValue();
  });
});
