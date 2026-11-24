/**
 * A reader of a VPC endpoint's `NetworkInterfaceIds` is re-provisioned when an
 * in-place update adds a subnet (go-to-k/cdkd#6939), driven through
 * `DeployEngine.deploy` with the REAL `DiffCalculator`, `DagBuilder` and
 * `IntrinsicFunctionResolver`.
 *
 * `NetworkInterfaceIds` is not a template property, so only the
 * `IN_PLACE_UPDATE_ATTRS_MOVED_BY` entry promotes the reader. Under
 * `--no-wait` the endpoint's update records no `NetworkInterfaceIds` (the
 * modify left it `pending`), so the reader's re-resolution reads the endpoint
 * live, waits for it, and updates the reader to the new interfaces. A deploy
 * that leaves the subnets alone promotes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { DeployEngine } from '../../../src/deployment/deploy-engine.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import { vpcEndpointAttributeWait } from '../../../src/deployment/intrinsic-resolver/getatt-construct-core.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

const mockEc2Send = vi.hoisted(() => vi.fn());

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

const renderer = {
  start: vi.fn(),
  stop: vi.fn(),
  addTask: vi.fn(),
  removeTask: vi.fn(),
  updateTaskLabel: vi.fn(),
  printAbove: (write: () => void) => write(),
};
vi.mock('../../../src/utils/live-renderer.js', () => ({ getLiveRenderer: () => renderer }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    cloudFormation: {
      send: () =>
        Promise.reject(
          Object.assign(new Error('not authorized to perform: cloudformation:DescribeType'), {
            name: 'AccessDeniedException',
            $metadata: { httpStatusCode: 403 },
          })
        ),
    },
    sts: { send: () => Promise.resolve({ Account: '123456789012' }) },
    ec2: { send: mockEc2Send },
  }),
}));

vi.mock('p-limit', () => ({ default: () => <T>(fn: () => T) => fn() }));

const STACK = 'vpce-reader-stack';
const REGION = 'us-east-1';
const ID = 'vpce-0123456789abcdef0';

const endpointProps = (subnets: string[]) => ({
  VpcId: 'vpc-1',
  ServiceName: 'com.amazonaws.us-east-1.sts',
  VpcEndpointType: 'Interface',
  SubnetIds: subnets,
});

const template = (subnets: string[]): CloudFormationTemplate => ({
  Resources: {
    Endpoint: { Type: 'AWS::EC2::VPCEndpoint', Properties: endpointProps(subnets) },
    Reader: {
      Type: 'AWS::SSM::Parameter',
      Properties: {
        Name: '/app/enis',
        Type: 'String',
        Value: { 'Fn::Join': [',', { 'Fn::GetAtt': ['Endpoint', 'NetworkInterfaceIds'] }] },
      },
    },
  },
});

function priorState(): StackState {
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    region: REGION,
    stackName: STACK,
    resources: {
      Endpoint: {
        physicalId: ID,
        resourceType: 'AWS::EC2::VPCEndpoint',
        properties: endpointProps(['subnet-a']),
        observedProperties: endpointProps(['subnet-a']),
        attributes: { Id: ID, NetworkInterfaceIds: ['eni-a'] },
        dependencies: [],
      },
      Reader: {
        physicalId: '/app/enis',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: '/app/enis', Type: 'String', Value: 'eni-a' },
        observedProperties: { Name: '/app/enis', Type: 'String', Value: 'eni-a' },
        attributes: {},
        dependencies: ['Endpoint'],
      },
    },
    outputs: {},
    lastModified: 0,
  };
}

describe('DeployEngine - a reader of VPC endpoint NetworkInterfaceIds (#6939)', () => {
  let provider: {
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    getAttribute: ReturnType<typeof vi.fn>;
    readCurrentState: ReturnType<typeof vi.fn>;
  };
  let stateBackend: { getState: ReturnType<typeof vi.fn>; saveState: ReturnType<typeof vi.fn> };
  const realWait = { ...vpcEndpointAttributeWait };

  beforeEach(() => {
    mockEc2Send.mockReset();
    Object.assign(vpcEndpointAttributeWait, { polls: 3, delayMs: 0, sleep: () => Promise.resolve() });
    provider = {
      create: vi.fn(),
      // What EC2VPCEndpointProvider.update returns after a --no-wait modify:
      // no network attributes.
      update: vi.fn((logicalId: string, physicalId: string) =>
        Promise.resolve(
          logicalId === 'Endpoint'
            ? { physicalId, wasReplaced: false, attributes: { Id: physicalId } }
            : { physicalId, wasReplaced: false }
        )
      ),
      delete: vi.fn(),
      getAttribute: vi.fn(),
      readCurrentState: vi.fn(() => Promise.resolve(undefined)),
    };
    stateBackend = {
      getState: vi.fn(() => Promise.resolve({ state: priorState(), etag: 'etag-old' })),
      saveState: vi.fn(() => Promise.resolve('etag-new')),
    };
  });
  afterEach(() => {
    Object.assign(vpcEndpointAttributeWait, realWait);
  });

  function makeEngine(): DeployEngine {
    return new DeployEngine(
      stateBackend as never,
      {
        acquireLockWithRetry: () => Promise.resolve(true),
        releaseLock: () => Promise.resolve(undefined),
      } as never,
      new DagBuilder(),
      new DiffCalculator(),
      {
        getProvider: () => provider,
        getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
        getRegisteredTypes: () => [],
        validateResourceTypes: () => undefined,
        validateResourceProperties: () => undefined,
      } as never,
      { dryRun: false },
      REGION,
      {
        updateForStack: () => Promise.resolve(undefined),
        prefetch: () => Promise.resolve(undefined),
        lookup: () => Promise.resolve(null),
        patchEntry: () => Promise.resolve(undefined),
      } as never
    );
  }

  const updateCallFor = (logicalId: string): unknown[] | undefined =>
    provider.update.mock.calls.find((c) => c[0] === logicalId);

  it('updates the reader to the interfaces the live read reports once the endpoint is available', async () => {
    // The endpoint is still `pending` on the first live read, then available
    // with the second subnet's interface.
    mockEc2Send
      .mockResolvedValueOnce({ VpcEndpoints: [{ VpcEndpointId: ID, State: 'pending' }] })
      .mockResolvedValue({
        VpcEndpoints: [
          { VpcEndpointId: ID, State: 'available', NetworkInterfaceIds: ['eni-a', 'eni-b'] },
        ],
      });
    await makeEngine().deploy(STACK, template(['subnet-a', 'subnet-b']));

    expect(updateCallFor('Endpoint')).toBeDefined();
    const reader = updateCallFor('Reader');
    expect(reader).toBeDefined();
    expect((reader![3] as Record<string, unknown>)['Value']).toBe('eni-a,eni-b');
    expect(mockEc2Send).toHaveBeenCalledTimes(2);
  });

  it('promotes no reader when the subnets did not change', async () => {
    const tpl = template(['subnet-a']);
    (tpl.Resources['Endpoint']!.Properties as Record<string, unknown>)['IpAddressType'] = 'ipv4';
    await makeEngine().deploy(STACK, tpl);

    expect(updateCallFor('Endpoint')).toBeDefined();
    expect(updateCallFor('Reader')).toBeUndefined();
    expect(mockEc2Send).not.toHaveBeenCalled();
  });

  it('updates a DnsEntries reader when only PrivateDnsEnabled changes', async () => {
    mockEc2Send.mockResolvedValue({
      VpcEndpoints: [
        {
          VpcEndpointId: ID,
          State: 'available',
          DnsEntries: [
            { DnsName: 'vpce-1.sts.us-east-1.vpce.amazonaws.com', HostedZoneId: 'Z7HUB' },
            { DnsName: 'sts.us-east-1.amazonaws.com', HostedZoneId: 'Z0578' },
          ],
        },
      ],
    });
    const tpl = template(['subnet-a']);
    (tpl.Resources['Endpoint']!.Properties as Record<string, unknown>)['PrivateDnsEnabled'] = true;
    tpl.Resources['Reader']!.Properties = {
      Name: '/app/enis',
      Type: 'String',
      Value: { 'Fn::Join': [',', { 'Fn::GetAtt': ['Endpoint', 'DnsEntries'] }] },
    };
    stateBackend.getState.mockImplementation(() => {
      const state = priorState();
      state.resources['Endpoint']!.attributes = {
        Id: ID,
        DnsEntries: ['Z7HUB:vpce-1.sts.us-east-1.vpce.amazonaws.com'],
      };
      state.resources['Reader']!.properties = {
        Name: '/app/enis',
        Type: 'String',
        Value: 'Z7HUB:vpce-1.sts.us-east-1.vpce.amazonaws.com',
      };
      return Promise.resolve({ state, etag: 'etag-old' });
    });
    await makeEngine().deploy(STACK, tpl);

    const reader = updateCallFor('Reader');
    expect(reader).toBeDefined();
    expect((reader![3] as Record<string, unknown>)['Value']).toBe(
      'Z7HUB:vpce-1.sts.us-east-1.vpce.amazonaws.com,Z0578:sts.us-east-1.amazonaws.com'
    );
  });
});
