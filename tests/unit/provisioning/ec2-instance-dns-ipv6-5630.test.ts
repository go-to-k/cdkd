import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  DescribeInstancesCommand,
  ModifyInstanceAttributeCommand,
  ModifyPrivateDnsNameOptionsCommand,
  RunInstancesCommand,
  StartInstancesCommand,
  StopInstancesCommand,
} from '@aws-sdk/client-ec2';

// go-to-k/cdkd#5630 (third slice): AWS::EC2::Instance AdditionalInfo,
// Ipv6AddressCount, Ipv6Addresses and PrivateDnsNameOptions. CloudFormation
// measured (us-east-1, 2026-11-04, a t3.nano):
//  - PrivateDnsNameOptions: adding it or changing a member keeps the instance
//    (the EnableResourceName* flags in place; a HostnameType change with a stop
//    and a start). Removing the whole block creates a new instance. Removing
//    one member fails the update ("No valid attributes specified"), with or
//    without another member changing.
//  - AdditionalInfo: EC2 refuses it at launch ("Bad property set"); adding it
//    to or removing it from a running instance completes with no change.
//  - Ipv6AddressCount / Ipv6Addresses: create-only in the schema.
// EC2 itself refuses any HostnameType on a running instance, an unchanged one
// included ("Cannot modify hostname-type for running instances", measured).

const { mockSend, warn, cfnSend } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  warn: vi.fn(),
  cfnSend: vi.fn(() => Promise.reject(new Error('DescribeType is not reachable here'))),
}));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    cloudFormation: { send: cfnSend },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn,
      error: vi.fn(),
    }),
  };
});

vi.mock('@aws-sdk/client-ec2', async (importOriginal) => {
  const actual = (await importOriginal()) as object;
  return { ...actual, waitUntilInstanceRunning: vi.fn(() => Promise.resolve({})) };
});

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ReplacementRulesRegistry } from '../../../src/analyzer/replacement-rules.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import { ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';
import { isRefusedBeforeApplying } from '../../../src/deployment/prior-attempt-scope.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';

const TYPE = 'AWS::EC2::Instance';
const BASE = { ImageId: 'ami-1', InstanceType: 't3.nano', SubnetId: 'subnet-1' };
const DNS_ON = {
  HostnameType: 'resource-name',
  EnableResourceNameDnsARecord: true,
  EnableResourceNameDnsAAAARecord: false,
};
const MUTATING = [
  StopInstancesCommand,
  StartInstancesCommand,
  ModifyInstanceAttributeCommand,
  ModifyPrivateDnsNameOptionsCommand,
];

function sent<T>(ctor: new (...a: never[]) => T): Array<Record<string, unknown>> {
  return mockSend.mock.calls
    .filter((c) => c[0] instanceof ctor)
    .map((c) => (c[0] as { input: Record<string, unknown> }).input);
}

function mutatingNames(): string[] {
  return mockSend.mock.calls
    .map((c) => c[0] as object)
    .filter((cmd) => MUTATING.some((ctor) => cmd instanceof ctor))
    .map((cmd) => cmd.constructor.name);
}

/** DescribeInstances answers: successive State names, then the last forever. */
let states: string[];
let liveHostnameType: string;
let rootDeviceType: string;
let failDnsModify: Error | undefined;
let failStart: Error | undefined;

beforeEach(() => {
  mockSend.mockReset();
  warn.mockReset();
  states = ['running'];
  liveHostnameType = 'ip-name';
  rootDeviceType = 'ebs';
  failDnsModify = undefined;
  failStart = undefined;
  vi.spyOn(EC2Provider.prototype as unknown as { sleep: () => Promise<void> }, 'sleep').mockResolvedValue(
    undefined
  );
  let describes = 0;
  mockSend.mockImplementation((cmd: unknown) => {
    if (cmd instanceof RunInstancesCommand) {
      return Promise.resolve({ Instances: [{ InstanceId: 'i-new' }] });
    }
    if (cmd instanceof DescribeInstancesCommand) {
      // The waits' sleep is stubbed: a wait that never sees its target state
      // fails the test instead of spinning.
      if (++describes > 50) return Promise.reject(new Error('runaway DescribeInstances poll'));
      const name = states.length > 1 ? states.shift()! : states[0];
      return Promise.resolve({
        Reservations: [
          {
            Instances: [
              {
                InstanceId: 'i-new',
                State: { Name: name },
                RootDeviceType: rootDeviceType,
                PrivateDnsNameOptions: {
                  HostnameType: liveHostnameType,
                  EnableResourceNameDnsARecord: false,
                  EnableResourceNameDnsAAAARecord: false,
                },
              },
            ],
          },
        ],
      });
    }
    if (cmd instanceof ModifyPrivateDnsNameOptionsCommand && failDnsModify !== undefined) {
      return Promise.reject(failDnsModify);
    }
    if (cmd instanceof StartInstancesCommand && failStart !== undefined) {
      return Promise.reject(failStart);
    }
    return Promise.resolve({});
  });
});

describe('AWS::EC2::Instance create (#5630, third slice)', () => {
  it('sends AdditionalInfo, Ipv6AddressCount and PrivateDnsNameOptions on RunInstances, scalar spellings folded', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      AdditionalInfo: 'reserved',
      Ipv6AddressCount: '2',
      PrivateDnsNameOptions: {
        HostnameType: 'resource-name',
        EnableResourceNameDnsARecord: 'true',
        EnableResourceNameDnsAAAARecord: false,
      },
    });
    const [input] = sent(RunInstancesCommand);
    expect(input).toMatchObject({
      AdditionalInfo: 'reserved',
      Ipv6AddressCount: 2,
      PrivateDnsNameOptions: {
        HostnameType: 'resource-name',
        EnableResourceNameDnsARecord: true,
        EnableResourceNameDnsAAAARecord: false,
      },
    });
    expect(input).not.toHaveProperty('Ipv6Addresses');
  });

  it('sends Ipv6Addresses as the list of addresses', async () => {
    await new EC2Provider().create('Inst', TYPE, {
      ...BASE,
      Ipv6Addresses: [{ Ipv6Address: '2001:db8::7' }, { Ipv6Address: '2001:db8::8' }],
    });
    expect(sent(RunInstancesCommand)[0]?.['Ipv6Addresses']).toEqual([
      { Ipv6Address: '2001:db8::7' },
      { Ipv6Address: '2001:db8::8' },
    ]);
  });

  it('sends none of them when the template declares none', async () => {
    await new EC2Provider().create('Inst', TYPE, BASE);
    const [input] = sent(RunInstancesCommand);
    for (const key of ['AdditionalInfo', 'Ipv6AddressCount', 'Ipv6Addresses', 'PrivateDnsNameOptions']) {
      expect(input).not.toHaveProperty(key);
    }
  });

  it.each([
    ['a non-object PrivateDnsNameOptions', { PrivateDnsNameOptions: 'resource-name' }, /PrivateDnsNameOptions must be an object/],
    ['a non-boolean DNS flag', { PrivateDnsNameOptions: { EnableResourceNameDnsARecord: 'yes' } }, /EnableResourceNameDnsARecord must be a boolean/],
    ['a non-string HostnameType', { PrivateDnsNameOptions: { HostnameType: 5 } }, /HostnameType/],
    ['a negative Ipv6AddressCount', { Ipv6AddressCount: -1 }, /Ipv6AddressCount must be an integer >= 0/],
    ['a non-list Ipv6Addresses', { Ipv6Addresses: '2001:db8::7' }, /Ipv6Addresses must be a list of \{ Ipv6Address \} entries \(got a string\)/],
    ['an object Ipv6Addresses', { Ipv6Addresses: { Ipv6Address: '2001:db8::7' } }, /Ipv6Addresses must be a list of \{ Ipv6Address \} entries \(got an object\)/],
    ['an entry without Ipv6Address', { Ipv6Addresses: [{}] }, /Ipv6Addresses\[0\]\.Ipv6Address is required/],
    ['a null entry', { Ipv6Addresses: [null] }, /Ipv6Addresses\[0\] must be an object/],
    ['a blank Ipv6Address', { Ipv6Addresses: [{ Ipv6Address: '' }] }, /Ipv6Addresses\[0\]\.Ipv6Address is required/],
    ['a blank HostnameType', { PrivateDnsNameOptions: { HostnameType: '' } }, /HostnameType must not be empty/],
    ['a non-string AdditionalInfo', { AdditionalInfo: { a: 1 } }, /AdditionalInfo/],
  ])('refuses %s before RunInstances', async (_label, extra, message) => {
    const error = await new EC2Provider()
      .create('Inst', TYPE, { ...BASE, ...extra })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(message);
    expect(String(error)).toMatch(/was not launched/);
    expect(sent(RunInstancesCommand)).toHaveLength(0);
  });
});

describe('AWS::EC2::Instance PrivateDnsNameOptions update (#5630)', () => {
  it('changes the DNS record flags in place, with no stop', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { ...DNS_ON, EnableResourceNameDnsARecord: false } },
      { ...BASE, PrivateDnsNameOptions: DNS_ON }
    );
    expect(mutatingNames()).toEqual(['ModifyPrivateDnsNameOptionsCommand']);
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', EnableResourceNameDnsARecord: false },
    ]);
  });

  it('changes HostnameType on a stopped instance, with the flags in the same call, and starts it again', async () => {
    states = ['running', 'running', 'stopping', 'stopped', 'pending', 'running'];
    liveHostnameType = 'resource-name';
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      {
        ...BASE,
        PrivateDnsNameOptions: {
          HostnameType: 'ip-name',
          EnableResourceNameDnsARecord: false,
          EnableResourceNameDnsAAAARecord: false,
        },
      },
      { ...BASE, PrivateDnsNameOptions: DNS_ON }
    );
    expect(mutatingNames()).toEqual([
      'StopInstancesCommand',
      'ModifyPrivateDnsNameOptionsCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', PrivateDnsHostnameType: 'ip-name', EnableResourceNameDnsARecord: false },
    ]);
  });

  it('shares one stop with an InstanceType change', async () => {
    states = ['running', 'running', 'stopped', 'running'];
    liveHostnameType = 'resource-name';
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, InstanceType: 't3.micro', PrivateDnsNameOptions: { HostnameType: 'ip-name' } },
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } }
    );
    expect(mutatingNames()).toEqual([
      'StopInstancesCommand',
      'ModifyInstanceAttributeCommand',
      'ModifyPrivateDnsNameOptionsCommand',
      'StartInstancesCommand',
    ]);
  });

  it('adds the block to an instance without one in place (no replacement), sending what it declares', async () => {
    liveHostnameType = 'resource-name';
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name', EnableResourceNameDnsARecord: true } },
      BASE
    );
    // The live instance already has the HostnameType: it is not sent (EC2
    // refuses any HostnameType on a running instance), so there is no stop.
    expect(mutatingNames()).toEqual(['ModifyPrivateDnsNameOptionsCommand']);
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', EnableResourceNameDnsARecord: true },
    ]);
  });

  it('sends nothing when only an unchanged HostnameType the instance already has is left', async () => {
    liveHostnameType = 'resource-name';
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
      BASE
    );
    expect(mutatingNames()).toEqual([]);
  });

  it('sends nothing for a spelling change', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { ...DNS_ON, EnableResourceNameDnsARecord: 'true' } },
      { ...BASE, PrivateDnsNameOptions: DNS_ON }
    );
    expect(mutatingNames()).toEqual([]);
  });

  it.each(['HostnameType', 'EnableResourceNameDnsARecord', 'EnableResourceNameDnsAAAARecord'])(
    'refuses a removed %s before any call, as CloudFormation fails it',
    async (member) => {
      const { [member]: _gone, ...rest } = DNS_ON as Record<string, unknown>;
      const error = await new EC2Provider()
        .update(
          'Inst',
          'i-new',
          TYPE,
          { ...BASE, PrivateDnsNameOptions: rest },
          { ...BASE, PrivateDnsNameOptions: DNS_ON }
        )
        .catch((e: unknown) => e);
      expect(String(error)).toMatch(
        new RegExp(`PrivateDnsNameOptions ${member} was removed from the template.*No valid attributes specified`)
      );
      expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
      expect(mockSend).not.toHaveBeenCalled();
    }
  );

  it('refuses a removed member next to a changed one too (measured: CloudFormation fails it)', async () => {
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'ip-name' } },
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name', EnableResourceNameDnsARecord: true } }
      )
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/EnableResourceNameDnsARecord was removed/);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a rollback replay with a removed member warns and still applies the changed one', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { EnableResourceNameDnsARecord: false } },
      { ...BASE, PrivateDnsNameOptions: DNS_ON },
      { replayingState: true }
    );
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /does not declare PrivateDnsNameOptions HostnameType, EnableResourceNameDnsAAAARecord/
    );
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', EnableResourceNameDnsARecord: false },
    ]);
  });

  it('refuses a whole-block removal that reaches update() (CloudFormation replaces), and warns on a replay', async () => {
    const provider = new EC2Provider();
    const error = await provider
      .update('Inst', 'i-new', TYPE, BASE, { ...BASE, PrivateDnsNameOptions: DNS_ON }, {
        removedProperties: new Set(['PrivateDnsNameOptions']),
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toMatch(/creates a new instance when PrivateDnsNameOptions is removed/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();

    await provider.update('Inst', 'i-new', TYPE, BASE, { ...BASE, PrivateDnsNameOptions: DNS_ON }, {
      replayingState: true,
      removedProperties: new Set(['PrivateDnsNameOptions']),
    });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/does not declare PrivateDnsNameOptions, which needs a new instance/);
    expect(mutatingNames()).toEqual([]);
  });

  it('refuses a HostnameType change on an instance-store-backed instance, which cannot be stopped', async () => {
    rootDeviceType = 'instance-store';
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'ip-name' } }
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
    expect(String(error)).toMatch(
      /PrivateDnsNameOptions\.HostnameType can change only on a stopped instance.*cannot be stopped; it needs a new instance/
    );
    expect(String(error)).not.toMatch(/CloudFormation replaces it/);
    expect(mutatingNames()).toEqual([]);
  });

  it('starts the instance again and names the HostnameType change when the modify fails after the stop', async () => {
    states = ['running', 'running', 'stopped', 'running'];
    failDnsModify = new Error('InvalidParameterValue');
    const error = await new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'ip-name' } }
      )
      .catch((e: unknown) => e);
    expect(error).toBeDefined();
    expect(mutatingNames()).toEqual([
      'StopInstancesCommand',
      'ModifyPrivateDnsNameOptionsCommand',
      'StartInstancesCommand',
    ]);
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /the PrivateDnsNameOptions\.HostnameType change failed after instance i-new was stopped; cdkd started it again, with its previous settings/
    );
  });

  it('a drift --revert with a malformed recorded block warns and sends nothing', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { EnableResourceNameDnsARecord: 'yes' } },
      { ...BASE, PrivateDnsNameOptions: DNS_ON },
      { desiredFromAwsReadback: true }
    );
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /EnableResourceNameDnsARecord must be a boolean.*left at their current AWS value/
    );
    expect(mutatingNames()).toEqual([]);
  });

  it('a drift --revert whose record declares fewer members than the readback sends nothing', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
      {
        ...BASE,
        PrivateDnsNameOptions: { ...DNS_ON, EnableResourceNameDnsARecord: false },
      },
      { desiredFromAwsReadback: true }
    );
    expect(mutatingNames()).toEqual([]);
  });

  it('refuses a malformed desired block before any call, and warns on a rollback replay', async () => {
    const provider = new EC2Provider();
    const bad = { ...BASE, PrivateDnsNameOptions: { EnableResourceNameDnsARecord: 'yes' } };
    const error = await provider
      .update('Inst', 'i-new', TYPE, bad, { ...BASE, PrivateDnsNameOptions: DNS_ON })
      .catch((e: unknown) => e);
    expect(String(error)).toMatch(/EnableResourceNameDnsARecord must be a boolean.*was not updated/);
    expect(isRefusedBeforeApplying(error, 'Inst')).toBe(true);
    expect(mockSend).not.toHaveBeenCalled();

    await provider.update('Inst', 'i-new', TYPE, bad, { ...BASE, PrivateDnsNameOptions: DNS_ON }, {
      replayingState: true,
    });
    expect(warn.mock.calls.flat().join('\n')).toMatch(/left at their current AWS value/);
    expect(mutatingNames()).toEqual([]);
  });
});

describe('AWS::EC2::Instance PrivateDnsNameOptions revert and replay (#5630)', () => {
  it('a drift --revert sends the recorded flag back, in place', async () => {
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: DNS_ON },
      { ...BASE, PrivateDnsNameOptions: { ...DNS_ON, EnableResourceNameDnsARecord: false } },
      { desiredFromAwsReadback: true }
    );
    expect(mutatingNames()).toEqual(['ModifyPrivateDnsNameOptionsCommand']);
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', EnableResourceNameDnsARecord: true },
    ]);
  });

  it('a drift --revert of a HostnameType drift stops, sends it and starts the instance again', async () => {
    states = ['running', 'running', 'stopped', 'running'];
    liveHostnameType = 'ip-name';
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
      { ...BASE, PrivateDnsNameOptions: { ...DNS_ON, HostnameType: 'ip-name' } },
      { desiredFromAwsReadback: true }
    );
    expect(mutatingNames()).toEqual([
      'StopInstancesCommand',
      'ModifyPrivateDnsNameOptionsCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', PrivateDnsHostnameType: 'resource-name' },
    ]);
  });

  it('a rollback replay reverting a HostnameType change applies it with the stop and the start', async () => {
    states = ['running', 'running', 'stopped', 'running'];
    liveHostnameType = 'resource-name';
    await new EC2Provider().update(
      'Inst',
      'i-new',
      TYPE,
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'ip-name' } },
      { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
      { replayingState: true }
    );
    expect(mutatingNames()).toEqual([
      'StopInstancesCommand',
      'ModifyPrivateDnsNameOptionsCommand',
      'StartInstancesCommand',
    ]);
    expect(sent(ModifyPrivateDnsNameOptionsCommand)).toEqual([
      { InstanceId: 'i-new', PrivateDnsHostnameType: 'ip-name' },
    ]);
  });
});

describe('AWS::EC2::Instance stop-path messages when HostnameType is the only stop member (#5630)', () => {
  const hostnameChange = (): Promise<unknown> =>
    new EC2Provider()
      .update(
        'Inst',
        'i-new',
        TYPE,
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
        { ...BASE, PrivateDnsNameOptions: { HostnameType: 'ip-name' } }
      )
      .catch((e: unknown) => e);

  it('names it when the instance leaves the stoppable states before the stop', async () => {
    states = ['running', 'shutting-down'];
    const error = await hostnameChange();
    expect(String(error)).toMatch(
      /became shutting-down during the update, so its PrivateDnsNameOptions\.HostnameType were not changed/
    );
    expect(mutatingNames()).toEqual([]);
  });

  it('names it when the modify fails and starting the instance again fails too', async () => {
    states = ['running', 'running', 'stopped'];
    failDnsModify = new Error('InvalidParameterValue');
    failStart = new Error('IncorrectInstanceState');
    await hostnameChange();
    expect(warn.mock.calls.flat().join('\n')).toMatch(
      /was stopped for a PrivateDnsNameOptions\.HostnameType change that failed, and starting it again failed too.*Start it with: aws ec2 start-instances --instance-ids i-new/
    );
  });
});

describe('AWS::EC2::Instance AdditionalInfo update (#5630)', () => {
  it('sends nothing for an addition, a change or a removal', async () => {
    const provider = new EC2Provider();
    await provider.update('Inst', 'i-new', TYPE, { ...BASE, AdditionalInfo: 'a' }, BASE);
    await provider.update('Inst', 'i-new', TYPE, { ...BASE, AdditionalInfo: 'b' }, { ...BASE, AdditionalInfo: 'a' });
    await provider.update('Inst', 'i-new', TYPE, BASE, { ...BASE, AdditionalInfo: 'b' }, {
      removedProperties: new Set(['AdditionalInfo']),
    });
    expect(mutatingNames()).toEqual([]);
  });
});

describe('AWS::EC2::Instance replacement rules (#5630, third slice)', () => {
  const rules = new ReplacementRulesRegistry();

  it('replaces when the whole PrivateDnsNameOptions block is removed, as CloudFormation does', () => {
    expect(rules.requiresReplacement(TYPE, 'PrivateDnsNameOptions', DNS_ON, undefined)).toBe(true);
  });

  it.each([
    ['an addition', undefined, DNS_ON],
    ['a member change', DNS_ON, { ...DNS_ON, HostnameType: 'ip-name' }],
    ['a member removal (refused by the provider)', DNS_ON, { HostnameType: 'resource-name' }],
  ])('keeps the instance for %s', (_l, before, after) => {
    expect(rules.requiresReplacement(TYPE, 'PrivateDnsNameOptions', before, after)).toBe(false);
  });

  it.each(['Ipv6AddressCount', 'Ipv6Addresses'])(
    'classifies a %s change as a replacement without DescribeType',
    (key) => {
      expect(rules.requiresReplacement(TYPE, key, 'a', 'b')).toBe(true);
    }
  );

  it.each(['Ipv6AddressCount', 'Ipv6Addresses'])(
    'refuses a %s change that reaches update() (drift --revert) before any call',
    async (key) => {
      const error = await new EC2Provider()
        .update('Inst', 'i-new', TYPE, { ...BASE, [key]: key === 'Ipv6AddressCount' ? 2 : [{ Ipv6Address: '2001:db8::8' }] }, {
          ...BASE,
          [key]: key === 'Ipv6AddressCount' ? 1 : [{ Ipv6Address: '2001:db8::7' }],
        })
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResourceUpdateNotSupportedError);
      expect(String(error)).toMatch(new RegExp(key));
      expect(mutatingNames()).toEqual([]);
    }
  );
});

describe('AWS::EC2::Instance readCurrentState (#5630, third slice)', () => {
  it('reads PrivateDnsNameOptions with CloudFormation member names', async () => {
    const provider = new EC2Provider();
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand
        ? Promise.resolve({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-new',
                    State: { Name: 'running' },
                    PrivateDnsNameOptions: {
                      HostnameType: 'resource-name',
                      EnableResourceNameDnsARecord: true,
                      EnableResourceNameDnsAAAARecord: false,
                    },
                  },
                ],
              },
            ],
          })
        : Promise.resolve({ Volumes: [] })
    );
    const state = (await provider.readCurrentState('i-new', 'Inst', TYPE, {})) as Record<
      string,
      unknown
    >;
    expect(state['PrivateDnsNameOptions']).toEqual(DNS_ON);
  });

  it('emits only the members DescribeInstances reports', async () => {
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand
        ? Promise.resolve({
            Reservations: [
              {
                Instances: [
                  {
                    InstanceId: 'i-new',
                    State: { Name: 'running' },
                    PrivateDnsNameOptions: { HostnameType: 'ip-name' },
                  },
                ],
              },
            ],
          })
        : Promise.resolve({ Volumes: [] })
    );
    const state = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {})) as Record<
      string,
      unknown
    >;
    expect(state['PrivateDnsNameOptions']).toStrictEqual({ HostnameType: 'ip-name' });
  });

  it.each([
    ['no PrivateDnsNameOptions', {}],
    ['an empty PrivateDnsNameOptions', { PrivateDnsNameOptions: {} }],
  ])('omits the key when DescribeInstances reports %s', async (_l, extra) => {
    mockSend.mockImplementation((cmd: unknown) =>
      cmd instanceof DescribeInstancesCommand
        ? Promise.resolve({
            Reservations: [
              { Instances: [{ InstanceId: 'i-new', State: { Name: 'running' }, ...extra }] },
            ],
          })
        : Promise.resolve({ Volumes: [] })
    );
    const state = (await new EC2Provider().readCurrentState('i-new', 'Inst', TYPE, {})) as Record<
      string,
      unknown
    >;
    expect(state).not.toHaveProperty('PrivateDnsNameOptions');
  });

  it('declares the write-only launch inputs unreadable', () => {
    expect(new EC2Provider().getDriftUnknownPaths(TYPE)).toEqual(
      expect.arrayContaining(['AdditionalInfo', 'Ipv6AddressCount', 'Ipv6Addresses'])
    );
  });
});

describe('a reader of Instance PrivateDnsName (#5630)', () => {
  it('is promoted when the instance is updated in place (a HostnameType change moves the name)', async () => {
    const state: StackState = {
      version: 1,
      stackName: 'TestStack',
      resources: {
        Inst: {
          physicalId: 'i-1',
          resourceType: TYPE,
          properties: { ...BASE, PrivateDnsNameOptions: { HostnameType: 'ip-name' } },
          attributes: { PrivateDnsName: 'ip-10-0-0-5.ec2.internal' },
        },
        Param: {
          physicalId: 'p',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: 'p', Type: 'String', Value: 'ip-10-0-0-5.ec2.internal' },
          attributes: {},
        },
      },
      outputs: {},
      lastModified: 0,
    };
    const template: CloudFormationTemplate = {
      Resources: {
        Inst: {
          Type: TYPE,
          Properties: { ...BASE, PrivateDnsNameOptions: { HostnameType: 'resource-name' } },
        },
        Param: {
          Type: 'AWS::SSM::Parameter',
          Properties: { Name: 'p', Type: 'String', Value: { 'Fn::GetAtt': ['Inst', 'PrivateDnsName'] } },
        },
      },
    };
    const resolve = async (value: unknown): Promise<unknown> => {
      if (value !== null && typeof value === 'object' && 'Fn::GetAtt' in value) {
        const [id, attr] = (value as { 'Fn::GetAtt': [string, string] })['Fn::GetAtt'];
        return state.resources[id]?.attributes?.[attr];
      }
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value)) out[k] = await resolve(v);
        return out;
      }
      return value;
    };
    const changes = await new DiffCalculator().calculateDiff(state, template, resolve);
    expect(changes.get('Inst')?.changeType).toBe('UPDATE');
    expect(changes.get('Param')?.changeType).toBe('UPDATE');
  });
});
