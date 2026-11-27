import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#7121: Lake Formation's UpdateResource refuses to move a
// registration off the service-linked role, and Cloud Control's update calls
// it. CloudFormation deregisters and registers the location instead (measured
// via CloudTrail); cdkd does the same through Cloud Control's delete + create.

const mockCcSend = vi.fn();
const mockCfnSend = vi.fn();
const mockWarn = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudControl: { send: mockCcSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: mockCfnSend },
  }),
}));

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', () => ({
  getAccountInfo: () =>
    Promise.resolve({ partition: 'aws', region: 'us-east-1', accountId: '123456789012' }),
}));

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => {
    const child = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockWarn,
      error: vi.fn(),
      child: vi.fn(() => child),
    };
    return { child: () => child, debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  },
}));

import { CloudControlProvider } from '../../../src/provisioning/cloud-control-provider.js';
import { clearCreateOnlyPropertiesCache } from '../../../src/provisioning/create-only-properties.js';
import { isMarkedNonRetryable } from '../../../src/deployment/retryable-errors.js';
import {
  movesToOwnRole,
  serviceLinkedRestoreModel,
} from '../../../src/provisioning/cloud-control/lakeformation-role-switch.js';

const T = 'AWS::LakeFormation::Resource';
const ARN = 'arn:aws:s3:::bucket';
const SLR =
  'arn:aws:iam::123456789012:role/aws-service-role/lakeformation.amazonaws.com/AWSServiceRoleForLakeFormationDataAccess';
const OWN = 'arn:aws:iam::123456789012:role/own';
const slr = { ResourceArn: ARN, UseServiceLinkedRole: true };
const own = { ResourceArn: ARN, UseServiceLinkedRole: false, RoleArn: OWN };

interface Sent {
  name: string;
  input: Record<string, unknown>;
}

/**
 * Serve Cloud Control over one registration: GetResource reads it (NotFound
 * when `liveRole` is 'gone' or after a delete), DeleteResource removes it, and
 * each CreateResource takes its outcome in turn from `creates`; a successful
 * one registers the role its desired state names.
 */
function serve(
  liveRole: string | 'gone',
  creates: Array<'SUCCESS' | 'FAILED'> = ['SUCCESS'],
  createMessage = 'cdkd-probe-missing is not found. (Service: LakeFormation, Status Code: 400)'
): Sent[] {
  const sent: Sent[] = [];
  const model = (role: string): Record<string, unknown> => ({
    ResourceArn: ARN,
    Id: ARN,
    RoleArn: role,
    WithFederation: false,
    HybridAccessEnabled: true,
  });
  let registered: Record<string, unknown> | undefined =
    liveRole === 'gone' ? undefined : model(liveRole);
  const statusByToken = new Map<string, { status: string; model?: string; message?: string }>();
  let createIndex = 0;
  mockCcSend.mockImplementation(
    async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      const name = command.constructor.name;
      if (name !== 'GetResourceRequestStatusCommand') sent.push({ name, input: command.input });
      switch (name) {
        case 'GetResourceCommand': {
          if (registered === undefined) {
            const err = new Error('not found');
            err.name = 'ResourceNotFoundException';
            throw err;
          }
          return { ResourceDescription: { Properties: JSON.stringify(registered) } };
        }
        case 'DeleteResourceCommand':
          registered = undefined;
          statusByToken.set('del', { status: 'SUCCESS' });
          return { ProgressEvent: { RequestToken: 'del', OperationStatus: 'IN_PROGRESS' } };
        case 'CreateResourceCommand': {
          const token = `create-${createIndex}`;
          const outcome = creates[createIndex++] ?? 'SUCCESS';
          const desired = JSON.parse(String(command.input['DesiredState'])) as Record<
            string,
            unknown
          >;
          if (outcome === 'SUCCESS') {
            registered = model(typeof desired['RoleArn'] === 'string' ? desired['RoleArn'] : SLR);
          }
          statusByToken.set(token, {
            status: outcome,
            model: JSON.stringify(registered),
            message: createMessage,
          });
          return { ProgressEvent: { RequestToken: token, OperationStatus: 'IN_PROGRESS' } };
        }
        case 'UpdateResourceCommand': {
          const patch = JSON.parse(String(command.input['PatchDocument'])) as Array<{
            path: string;
            value?: unknown;
          }>;
          const role = patch.find((op) => op.path === '/RoleArn')?.value;
          registered = model(typeof role === 'string' ? role : SLR);
          statusByToken.set('upd', { status: 'SUCCESS' });
          return { ProgressEvent: { RequestToken: 'upd', OperationStatus: 'IN_PROGRESS' } };
        }
        case 'GetResourceRequestStatusCommand': {
          const s = statusByToken.get(String(command.input['RequestToken']));
          return {
            ProgressEvent: {
              OperationStatus: s?.status ?? 'SUCCESS',
              ...(s?.status === 'SUCCESS' && s.model !== undefined && { ResourceModel: s.model }),
              ...(s?.status === 'FAILED' && { ErrorCode: 'NotFound', StatusMessage: s.message }),
            },
          };
        }
        default:
          return {};
      }
    }
  );
  return sent;
}

function schema(): void {
  mockCfnSend.mockResolvedValue({
    Schema: JSON.stringify({
      primaryIdentifier: ['/properties/ResourceArn'],
      createOnlyProperties: ['/properties/ResourceArn', '/properties/WithFederation'],
      writeOnlyProperties: ['/properties/UseServiceLinkedRole'],
      readOnlyProperties: ['/properties/Id'],
    }),
  });
}

const provider = (): CloudControlProvider => {
  const p = new CloudControlProvider();
  (p as unknown as { INITIAL_POLL_INTERVAL_MS: number }).INITIAL_POLL_INTERVAL_MS = 1;
  return p;
};

describe('a Lake Formation location moving off the service-linked role (go-to-k/cdkd#7121)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockCfnSend.mockReset();
    mockWarn.mockReset();
    clearCreateOnlyPropertiesCache();
    schema();
  });

  it('is deregistered and registered with the desired model, never sent to UpdateResource', async () => {
    const sent = serve(SLR);
    const result = await provider().update('Lf', ARN, T, own, slr);
    const names = sent.map((s) => s.name);
    expect(names).toContain('DeleteResourceCommand');
    expect(names).not.toContain('UpdateResourceCommand');
    expect(names.indexOf('DeleteResourceCommand')).toBeLessThan(
      names.indexOf('CreateResourceCommand')
    );
    const creates = sent.filter((s) => s.name === 'CreateResourceCommand');
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0]!.input['DesiredState']))).toEqual(own);
    expect(sent.find((s) => s.name === 'DeleteResourceCommand')!.input['Identifier']).toBe(ARN);
    expect(result).toMatchObject({ physicalId: ARN, wasReplaced: false });
  });

  it('decides on the LIVE registration: one already on its own role goes through UpdateResource', async () => {
    const sent = serve(OWN);
    await provider().update('Lf', ARN, T, { ...own, RoleArn: `${OWN}-2` }, own);
    const names = sent.map((s) => s.name);
    expect(names).toContain('UpdateResourceCommand');
    expect(names).not.toContain('DeleteResourceCommand');
    expect(names).not.toContain('CreateResourceCommand');
  });

  it('re-registers when the record says own role but AWS holds the service-linked one (a drift revert)', async () => {
    const sent = serve(SLR);
    await provider().update('Lf', ARN, T, own, { ...own, RoleArn: SLR });
    expect(sent.map((s) => s.name)).toContain('DeleteResourceCommand');
  });

  it('leaves the reverse switch (own role -> service-linked role) to UpdateResource', async () => {
    const sent = serve(OWN);
    await provider().update('Lf', ARN, T, slr, own);
    const names = sent.map((s) => s.name);
    expect(names).toContain('UpdateResourceCommand');
    expect(names).not.toContain('DeleteResourceCommand');
  });

  it('registers the location back with the service-linked role when the new register fails', async () => {
    const sent = serve(SLR, ['FAILED', 'SUCCESS']);
    const err = await provider()
      .update('Lf', ARN, T, own, slr)
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain('is not found');
    const creates = sent.filter((s) => s.name === 'CreateResourceCommand');
    expect(creates).toHaveLength(2);
    expect(JSON.parse(String(creates[1]!.input['DesiredState']))).toEqual({
      ResourceArn: ARN,
      UseServiceLinkedRole: true,
      WithFederation: false,
      HybridAccessEnabled: true,
    });
    expect(mockWarn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'registered it back with the service-linked role'
    );
  });

  it('says the location is unregistered, and does not retry, when the restore fails too', async () => {
    serve(SLR, ['FAILED', 'FAILED']);
    const err = await provider()
      .update('Lf', ARN, T, own, slr)
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain('The location is not registered with Lake Formation now');
    expect(isMarkedNonRetryable(err)).toBe(true);
  });

  it('records the attributes the ordinary update path records (the shared tail runs)', async () => {
    serve(SLR);
    const switched = await provider().update('Lf', ARN, T, own, slr);
    serve(OWN);
    const ordinary = await provider().update('Lf', ARN, T, { ...own, RoleArn: `${OWN}-2` }, own);
    expect(Object.keys(switched.attributes ?? {}).sort()).toEqual(
      Object.keys(ordinary.attributes ?? {}).sort()
    );
    expect(switched.attributes?.['RoleArn']).toEqual(ordinary.attributes?.['RoleArn']);
  });

  it('registers a location a previous switch left deregistered (NotFound), instead of failing', async () => {
    const sent = serve('gone');
    await provider().update('Lf', ARN, T, own, slr);
    const names = sent.map((s) => s.name);
    expect(names).not.toContain('DeleteResourceCommand');
    expect(names).not.toContain('UpdateResourceCommand');
    const creates = sent.filter((s) => s.name === 'CreateResourceCommand');
    expect(creates).toHaveLength(1);
    expect(JSON.parse(String(creates[0]!.input['DesiredState']))).toEqual(own);
    expect(mockWarn.mock.calls.map((c) => String(c[0])).join('\n')).toContain(
      'was interrupted after its deregister'
    );
  });

  it('masks the caller identity of a synchronous refusal in the double-failure message', async () => {
    serve(SLR);
    const served = mockCcSend.getMockImplementation()!;
    mockCcSend.mockImplementation(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CreateResourceCommand') {
        const err = new Error(
          'User: arn:aws:sts::123456789012:assumed-role/Deployer/session-1 is not authorized to perform: lakeformation:RegisterResource'
        );
        err.name = 'AccessDeniedException';
        throw err;
      }
      return served(command);
    });
    const err = await provider()
      .update('Lf', ARN, T, own, slr)
      .then(
        () => null,
        (e: unknown) => e as Error
      );
    expect(err?.message).toContain('registering it back with the service-linked role failed too');
    expect(err?.message).toContain('not authorized to perform');
    expect(err?.message).not.toContain('assumed-role/Deployer');
    expect(err?.message).toContain('The location is not registered with Lake Formation now');
  });
});

describe('movesToOwnRole', () => {
  it('fires only on a desired own role that changed', () => {
    expect(movesToOwnRole(T, slr, own)).toBe(true);
    expect(movesToOwnRole(T, { ...slr, UseServiceLinkedRole: 'true' }, own)).toBe(true);
    expect(movesToOwnRole(T, own, own)).toBe(false);
    expect(movesToOwnRole(T, own, slr)).toBe(false);
    expect(movesToOwnRole(T, slr, { ...own, UseServiceLinkedRole: true })).toBe(false);
    expect(movesToOwnRole(T, slr, { ...own, RoleArn: SLR })).toBe(false);
    expect(movesToOwnRole(T, slr, { ...own, RoleArn: '' })).toBe(false);
    expect(movesToOwnRole('AWS::LakeFormation::DataLakeSettings', slr, own)).toBe(false);
  });

  it('restores the live flags it can read, and the physical id when the model lacks the ARN', () => {
    expect(serviceLinkedRestoreModel(ARN, {})).toEqual({
      ResourceArn: ARN,
      UseServiceLinkedRole: true,
    });
  });
});
