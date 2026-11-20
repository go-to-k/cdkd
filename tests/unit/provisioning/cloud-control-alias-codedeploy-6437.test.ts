import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#6437 PR 3: `CloudControlProvider.update` runs the
// `CodeDeployLambdaAliasUpdate` step before its patch, and keeps
// `FunctionVersion` out of the patch when CodeDeploy moves it.

const mockCloudControlSend = vi.hoisted(() => vi.fn());
const mockCloudFormationSend = vi.hoisted(() => vi.fn());
const mockShift = vi.hoisted(() => vi.fn());
const realShift = vi.hoisted(() => ({ fn: undefined as unknown }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: {
      send: mockCloudControlSend,
      config: { region: () => Promise.resolve('us-east-1') },
    },
    cloudFormation: { send: mockCloudFormationSend },
    lambda: { send: vi.fn() },
  }),
}));

vi.mock('../../../src/provisioning/cloud-control/codedeploy-alias-update.js', async (orig) => {
  const actual =
    await orig<typeof import('../../../src/provisioning/cloud-control/codedeploy-alias-update.js')>();
  realShift.fn = actual.shiftAliasThroughCodeDeploy;
  return { ...actual, shiftAliasThroughCodeDeploy: mockShift };
});

vi.mock('../../../src/utils/logger.js', () => {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => child),
  };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearWriteOnlyPropertiesCache } from '../../../src/provisioning/write-only-properties.js';
import { clearReadOnlyPropertiesCache } from '../../../src/provisioning/read-only-properties.js';

const TYPE = 'AWS::Lambda::Alias';
const ARN = 'arn:aws:lambda:us-east-1:123456789012:function:my-fn:live';
const PREVIOUS = { FunctionName: 'my-fn', FunctionVersion: '1', Name: 'live' };
const POLICY = {
  CodeDeployLambdaAliasUpdate: { ApplicationName: 'my-app', DeploymentGroupName: 'my-dg' },
};

const patches = (): unknown[] =>
  mockCloudControlSend.mock.calls
    .map((c) => c[0] as { constructor: { name: string }; input: { PatchDocument?: string } })
    .filter((cmd) => cmd.constructor.name === 'UpdateResourceCommand')
    .map((cmd) => JSON.parse(cmd.input.PatchDocument!));

describe('CloudControlProvider.update and CodeDeployLambdaAliasUpdate (go-to-k/cdkd#6437)', () => {
  let provider: CloudControlProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudFormationSend.mockReset();
    // The registry schema's create-only keys, which the #6676 re-send leaves out.
    mockCloudFormationSend.mockResolvedValue({
      Schema: JSON.stringify({
        createOnlyProperties: ['/properties/Name', '/properties/FunctionName'],
      }),
    });
    clearWriteOnlyPropertiesCache();
    clearReadOnlyPropertiesCache();
    mockCloudControlSend.mockImplementation((cmd: { constructor: { name: string } }) => {
      const name = cmd.constructor.name;
      if (name === 'UpdateResourceCommand') {
        return Promise.resolve({ ProgressEvent: { RequestToken: 'tok' } });
      }
      if (name === 'GetResourceRequestStatusCommand') {
        return Promise.resolve({
          ProgressEvent: {
            OperationStatus: 'SUCCESS',
            Identifier: ARN,
            ResourceModel: JSON.stringify({ AliasArn: ARN }),
          },
        });
      }
      return Promise.resolve({
        ResourceDescription: { Identifier: ARN, Properties: JSON.stringify({ AliasArn: ARN }) },
      });
    });
    provider = new CloudControlProvider();
  });

  it('hands the step the update, its context and a masker built from it', async () => {
    mockShift.mockResolvedValue('none');
    const context = { updatePolicy: POLICY, maskSecrets: (t: string) => t.replaceAll('s3cret', '***') };
    await provider.update('Alias', ARN, TYPE, { ...PREVIOUS, FunctionVersion: '2' }, PREVIOUS, context);
    expect(mockShift).toHaveBeenCalledTimes(1);
    const [host, input] = mockShift.mock.calls[0]!;
    expect(host).toBe(provider);
    expect(input).toMatchObject({
      logicalId: 'Alias',
      physicalId: ARN,
      resourceType: TYPE,
      properties: { FunctionVersion: '2' },
      previousProperties: { FunctionVersion: '1' },
      context,
    });
    expect((input as { mask: (t: string) => string }).mask('a s3cret')).toBe('a ***');
  });

  it('the real step end to end: CodeDeploy shifts the version, the patch carries the rest', async () => {
    mockShift.mockImplementation(realShift.fn as never);
    const sent: Array<{ kind: string; input: Record<string, unknown> }> = [];
    const command = (kind: string) =>
      class {
        kind = kind;
        constructor(readonly input: Record<string, unknown>) {}
      };
    const send = (c: unknown): Promise<unknown> => {
      const cmd = c as { kind: string; input: Record<string, unknown> };
      sent.push(cmd);
      if (cmd.kind === 'GetAlias') return Promise.resolve({ FunctionVersion: '1' });
      if (cmd.kind === 'ListDeployments') return Promise.resolve({ deployments: [] });
      if (cmd.kind === 'CreateDeployment') return Promise.resolve({ deploymentId: 'd-REAL' });
      if (cmd.kind === 'GetDeployment') return Promise.resolve({ deploymentInfo: { status: 'Succeeded' } });
      if (cmd.kind === 'GetDeploymentGroup')
        return Promise.resolve({ deploymentGroupInfo: { deploymentConfigName: 'cfg' } });
      if (cmd.kind === 'GetDeploymentConfig')
        return Promise.resolve({ deploymentConfigInfo: { trafficRoutingConfig: { type: 'AllAtOnce' } } });
      return Promise.reject(new Error(`unexpected ${cmd.kind}`));
    };
    vi.spyOn(provider, 'codeDeployAliasClients').mockResolvedValue({
      // Each client refuses the other's commands.
      codeDeploy: {
        send: (c: unknown) =>
          ['GetAlias', 'UpdateAlias'].includes((c as { kind: string }).kind)
            ? Promise.reject(new Error('sent to the wrong client'))
            : send(c),
      },
      lambda: {
        send: (c: unknown) =>
          ['GetAlias', 'UpdateAlias'].includes((c as { kind: string }).kind)
            ? send(c)
            : Promise.reject(new Error('sent to the wrong client')),
      },
      commands: {
        GetAlias: command('GetAlias'),
        ListDeployments: command('ListDeployments'),
        CreateDeployment: command('CreateDeployment'),
        GetDeployment: command('GetDeployment'),
        StopDeployment: command('StopDeployment'),
        UpdateAlias: command('UpdateAlias'),
        GetDeploymentGroup: command('GetDeploymentGroup'),
        GetDeploymentConfig: command('GetDeploymentConfig'),
      },
      destroy: () => undefined,
    } as never);
    provider.sleep = () => Promise.resolve();
    await provider.update(
      'Alias',
      ARN,
      TYPE,
      { ...PREVIOUS, FunctionVersion: '2', Description: 'new' },
      PREVIOUS,
      { updatePolicy: POLICY }
    );
    expect(sent.map((c) => c.kind)).toEqual([
      'GetAlias',
      'ListDeployments',
      'GetDeploymentGroup',
      'GetDeploymentConfig',
      'CreateDeployment',
      'GetDeployment',
    ]);
    expect(patches()).toEqual([[{ op: 'add', path: '/Description', value: 'new' }]]);
    expect(provider.startedAliasDeployments.get(ARN)).toBe('d-REAL');
  });

  it("'none': the patch writes FunctionVersion as before", async () => {
    mockShift.mockResolvedValue('none');
    await provider.update('Alias', ARN, TYPE, { ...PREVIOUS, FunctionVersion: '2' }, PREVIOUS);
    expect(patches()).toEqual([[{ op: 'replace', path: '/FunctionVersion', value: '2' }]]);
  });

  it("'shifted': the patch leaves FunctionVersion to CodeDeploy and carries the other changes", async () => {
    mockShift.mockResolvedValue('shifted');
    await provider.update(
      'Alias',
      ARN,
      TYPE,
      { ...PREVIOUS, FunctionVersion: '2', Description: 'new' },
      PREVIOUS,
      { updatePolicy: POLICY }
    );
    expect(patches()).toEqual([[{ op: 'add', path: '/Description', value: 'new' }]]);
  });

  it("'shifted' with nothing else changed sends no Cloud Control update and is not 'sent nothing'", async () => {
    mockShift.mockResolvedValue('shifted');
    const result = await provider.update(
      'Alias',
      ARN,
      TYPE,
      { ...PREVIOUS, FunctionVersion: '2' },
      PREVIOUS,
      { updatePolicy: POLICY }
    );
    expect(patches()).toEqual([]);
    expect(result).not.toHaveProperty('sentNothing');
    expect(result.wasReplaced).toBe(false);
  });

  it('an unchanged update still reports sentNothing', async () => {
    mockShift.mockResolvedValue('none');
    const result = await provider.update('Alias', ARN, TYPE, PREVIOUS, PREVIOUS);
    expect(result.sentNothing).toBe(true);
  });

  it("the step's refusal fails the update before any Cloud Control call", async () => {
    mockShift.mockRejectedValue(new Error('deployment already running'));
    await expect(
      provider.update('Alias', ARN, TYPE, { ...PREVIOUS, FunctionVersion: '2' }, PREVIOUS, {
        updatePolicy: POLICY,
      })
    ).rejects.toThrow('deployment already running');
    expect(patches()).toEqual([]);
  });
});
