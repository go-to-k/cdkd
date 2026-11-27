import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// go-to-k/cdkd#7099: Cloud Control can answer an update SUCCESS while the read
// model still holds the previous value. A generic type gets a tagged warning
// and keeps the previous value in the record; an allow-listed (type, property)
// pair fails the update.

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
import {
  CC_SILENT_NOOP_TAG,
  unappliedUpdateKeys,
} from '../../../src/provisioning/cloud-control/unapplied-update.js';

/**
 * Answer the Cloud Control calls: the update is accepted, its request ends
 * SUCCESS carrying `eventModel` (or none), and GetResource returns `live`.
 */
function serve(live: Record<string, unknown>, eventModel?: Record<string, unknown>): void {
  mockCcSend.mockImplementation(async (command: { constructor: { name: string } }) => {
    switch (command.constructor.name) {
      case 'UpdateResourceCommand':
        return { ProgressEvent: { RequestToken: 'tok', OperationStatus: 'IN_PROGRESS' } };
      case 'GetResourceRequestStatusCommand':
        return {
          ProgressEvent: {
            OperationStatus: 'SUCCESS',
            ...(eventModel && { ResourceModel: JSON.stringify(eventModel) }),
          },
        };
      case 'GetResourceCommand':
        return { ResourceDescription: { Properties: JSON.stringify(live) } };
      default:
        return {};
    }
  });
}

function schema(writeOnly: string[] = []): void {
  mockCfnSend.mockResolvedValue({
    Schema: JSON.stringify({
      createOnlyProperties: [],
      writeOnlyProperties: writeOnly.map((p) => `/properties/${p}`),
      readOnlyProperties: [],
    }),
  });
}

const warned = (): string => mockWarn.mock.calls.map((c) => String(c[0])).join('\n');

describe('a Cloud Control update that reports success but did not apply (go-to-k/cdkd#7099)', () => {
  beforeEach(() => {
    mockCcSend.mockReset();
    mockCfnSend.mockReset();
    mockWarn.mockReset();
    clearCreateOnlyPropertiesCache();
  });

  it('warns, tagged, and records the previous value for a generic type', async () => {
    schema();
    serve({ Id: 'x', Description: 'old', Name: 'n' });
    const result = await new CloudControlProvider().update(
      'R',
      'x',
      'AWS::Demo::Thing',
      { Description: 'new', Name: 'n' },
      { Description: 'old', Name: 'n' }
    );
    expect(warned()).toContain(
      `${CC_SILENT_NOOP_TAG} R (AWS::Demo::Thing): Cloud Control reported success but Description still holds its previous value`
    );
    expect(result.effectiveProperties).toEqual({ Description: 'old', Name: 'n' });
  });

  it('fails the update for an allow-listed type and property', async () => {
    schema();
    const before = { SubnetId: 's', PrivateIpAddresses: [{ PrivateIpAddress: '10.0.0.5', Primary: true }] };
    serve({ Id: 'eni-1', ...before });
    const err = await new CloudControlProvider()
      .update(
        'Eni',
        'eni-1',
        'AWS::EC2::NetworkInterface',
        {
          SubnetId: 's',
          PrivateIpAddresses: [
            { PrivateIpAddress: '10.0.0.5', Primary: true },
            { PrivateIpAddress: '10.0.0.9', Primary: false },
          ],
        },
        before
      )
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(String((err as Error | null)?.message)).toContain(
      `${CC_SILENT_NOOP_TAG} Cloud Control reported success but PrivateIpAddresses still holds its previous value`
    );
  });

  it('does not fail an allow-listed pair whose change is a reorder only', async () => {
    schema();
    const live = {
      SubnetId: 's',
      PrivateIpAddresses: [
        { PrivateIpAddress: '10.0.0.5', Primary: true },
        { PrivateIpAddress: '10.0.0.9', Primary: false },
      ],
    };
    serve({ Id: 'eni-1', ...live });
    await expect(
      new CloudControlProvider().update(
        'Eni',
        'eni-1',
        'AWS::EC2::NetworkInterface',
        {
          SubnetId: 's',
          PrivateIpAddresses: [
            { PrivateIpAddress: '10.0.0.9', Primary: false },
            { PrivateIpAddress: '10.0.0.5', Primary: true },
          ],
          Description: 'd',
        },
        live
      )
    ).resolves.toBeDefined();
    expect(warned()).not.toContain(CC_SILENT_NOOP_TAG);
  });

  it('fails the lone EKS load-balancing toggle, though the read model adds defaulted members', async () => {
    schema();
    serve({
      Name: 'c',
      KubernetesNetworkConfig: {
        ServiceIpv4Cidr: '10.100.0.0/16',
        IpFamily: 'ipv4',
        ElasticLoadBalancing: { Enabled: false },
      },
    });
    const err = await new CloudControlProvider()
      .update(
        'Cluster',
        'c',
        'AWS::EKS::Cluster',
        { Name: 'c', KubernetesNetworkConfig: { ElasticLoadBalancing: { Enabled: true } } },
        { Name: 'c', KubernetesNetworkConfig: { ElasticLoadBalancing: { Enabled: false } } }
      )
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(String((err as Error | null)?.message)).toContain(
      'Cloud Control reported success but KubernetesNetworkConfig still holds its previous value'
    );
  });

  it('fails a drift --revert that did not apply, for any type', async () => {
    schema();
    serve({ Id: 'x', Description: 'drifted' });
    const err = await new CloudControlProvider()
      .update(
        'R',
        'x',
        'AWS::Demo::RevertThing',
        { Description: 'template' },
        { Description: 'drifted' },
        { desiredFromAwsReadback: true }
      )
      .then(
        () => null,
        (e: unknown) => e
      );
    expect(String((err as Error | null)?.message)).toContain(CC_SILENT_NOOP_TAG);
  });

  it('does not fire when the update applied, or when the event model only echoes the desired value', async () => {
    schema();
    serve({ Id: 'x', Description: 'new' }, { Id: 'x', Description: 'new' });
    const result = await new CloudControlProvider().update(
      'R',
      'x',
      'AWS::Demo::Thing',
      { Description: 'new' },
      { Description: 'old' }
    );
    expect(warned()).not.toContain(CC_SILENT_NOOP_TAG);
    expect(result.effectiveProperties).toBeUndefined();
  });

  it('does not fire on a write-only property', async () => {
    schema(['Password']);
    serve({ Id: 'x', Password: 'old', Name: 'n' });
    await new CloudControlProvider().update(
      'R',
      'x',
      'AWS::Demo::WriteOnlyThing',
      { Password: 'new', Name: 'n' },
      { Password: 'old', Name: 'n' }
    );
    expect(warned()).not.toContain(CC_SILENT_NOOP_TAG);
  });
});

describe('unappliedUpdateKeys (go-to-k/cdkd#7099)', () => {
  const none = new Set<string>();
  it('names only a changed key whose live value is still the previous one', () => {
    expect(
      unappliedUpdateKeys({
        previous: { A: 'a', B: 1, C: 'c', D: 'd' },
        desired: { A: 'a2', B: 2, C: 'c2' },
        live: { A: 'a', B: 2, C: 'other' },
        writeOnly: none,
      })
    ).toEqual(['A']);
  });

  it('reads 1 and "1", reordered keys, and null members as equal', () => {
    expect(
      unappliedUpdateKeys({
        previous: { A: { x: 1, y: 'z' } },
        desired: { A: { x: 2, y: 'z' } },
        live: { A: { y: 'z', x: '1', w: null } },
        writeOnly: none,
      })
    ).toEqual(['A']);
  });

  it('skips a nested member the template removed that AWS keeps', () => {
    expect(
      unappliedUpdateKeys({
        previous: { K: { IpFamily: 'ipv4', ElasticLoadBalancing: { Enabled: true } } },
        desired: { K: { ElasticLoadBalancing: { Enabled: true } } },
        live: {
          K: { IpFamily: 'ipv4', ServiceIpv4Cidr: '10.100.0.0/16', ElasticLoadBalancing: { Enabled: true } },
        },
        writeOnly: none,
      })
    ).toEqual([]);
  });

  // A value AWS only re-spells holds "live == previous" while the template
  // differs: none of these may be named, or each deploy warns (or, for an
  // allow-listed pair, fails) over a change that is already in place.
  it.each([
    ['a reordered list', { A: ['x', 'y'] }, { A: ['y', 'x'] }, { A: ['x', 'y'] }],
    [
      'a reordered interface address list (compared as a set)',
      {
        A: [
          { PrivateIpAddress: '10.0.0.5', Primary: true },
          { PrivateIpAddress: '10.0.0.9', Primary: false },
        ],
      },
      {
        A: [
          { PrivateIpAddress: '10.0.0.9', Primary: 'false' },
          { PrivateIpAddress: '10.0.0.5', Primary: 'true' },
        ],
      },
      {
        A: [
          { PrivateIpAddress: '10.0.0.5', Primary: true },
          { PrivateIpAddress: '10.0.0.9', Primary: false },
        ],
      },
    ],
    ['a case-only change', { A: 'ENABLED' }, { A: 'Enabled' }, { A: 'ENABLED' }],
    ['a number format', { A: { N: 1 } }, { A: { N: '1.0' } }, { A: { N: 1 } }],
    [
      'whitespace inside a JSON string',
      { A: '{"a":1,"b":[2]}' },
      { A: '{ "b": [ 2 ], "a": 1 }' },
      { A: '{"a":1,"b":[2]}' },
    ],
    [
      'a member the template adds that the read model omits (an omitted default)',
      { A: { X: 'x' } },
      { A: { X: 'x', Flag: false } },
      { A: { X: 'x' } },
    ],
    [
      'a default the read model omits on one list element and returns on another',
      { A: [{ N: 'a' }, { N: 'b', M: 'x' }] },
      { A: [{ N: 'a', M: 'default' }, { N: 'b', M: 'x' }] },
      { A: [{ N: 'a' }, { N: 'b', M: 'x' }] },
    ],
    [
      'an interface list whose template spells Primary: false the read model omits',
      { A: [{ PrivateIpAddress: '10.0.0.5', Primary: true }, { PrivateIpAddress: '10.0.0.9' }] },
      {
        A: [
          { PrivateIpAddress: '10.0.0.5', Primary: true },
          { PrivateIpAddress: '10.0.0.9', Primary: false },
        ],
      },
      { A: [{ PrivateIpAddress: '10.0.0.5', Primary: true }, { PrivateIpAddress: '10.0.0.9' }] },
    ],
  ])('does not name %s', (_label, previous, desired, live) => {
    expect(unappliedUpdateKeys({ previous, desired, live, writeOnly: none })).toEqual([]);
  });

  it('still names a real change among re-spelled members', () => {
    expect(
      unappliedUpdateKeys({
        previous: { A: { N: 1, S: 'on', L: ['x', 'y'] } },
        desired: { A: { N: '1.0', S: 'ON', L: ['y', 'x', 'z'] } },
        live: { A: { N: 1, S: 'on', L: ['x', 'y'] } },
        writeOnly: none,
      })
    ).toEqual(['A']);
  });

  it('skips a removal, an addition, a key the model lacks, and a secret reference', () => {
    expect(
      unappliedUpdateKeys({
        previous: { A: 'a', C: '{{resolve:ssm:/p}}', E: 'e' },
        desired: { B: 'b', C: 'x', E: 'e2' },
        live: { A: 'a', C: '{{resolve:ssm:/p}}' },
        writeOnly: none,
      })
    ).toEqual([]);
  });
});
