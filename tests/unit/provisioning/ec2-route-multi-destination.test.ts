import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateRouteCommand, DeleteRouteCommand } from '@aws-sdk/client-ec2';

const mockSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

// The child logger is built EAGERLY inside the factory, so it has to come from
// `vi.hoisted` for the assertions below to reference the same object.
const { childLogger } = vi.hoisted(() => ({
  childLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  },
}));

vi.mock('../../../src/utils/logger.js', () => {
  childLogger.child.mockReturnValue(childLogger);
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { ProvisioningError } from '../../../src/utils/error-handler.js';

/**
 * AWS::EC2::Route multi-destination refusal (issue #1566).
 *
 * `createRoute` picks the destination via
 * `DestinationCidrBlock || DestinationIpv6CidrBlock || DestinationPrefixListId`.
 * A (CFn-invalid) template carrying MORE than one destination key used to
 * deploy with only the highest-precedence one and silently drop the rest,
 * while CloudFormation / EC2 reject the combination.
 *
 * The refusal is TEMPLATE-path only. Both state-borne paths — the rollback
 * executor's reverse-replacement create (`CreateContext.replayingState`) and
 * `update()`'s delete-and-recreate, which `rollback --revert` / `drift
 * --revert` also drive — downgrade to a warning and keep the pre-fix
 * precedence, because a state record is not something the user can edit.
 */
describe('EC2Provider AWS::EC2::Route multi-destination (#1566)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
  });

  const createInput = (): Record<string, unknown> => {
    const call = mockSend.mock.calls.find((c) => c[0] instanceof CreateRouteCommand);
    expect(call).toBeDefined();
    return (call![0] as CreateRouteCommand).input as unknown as Record<string, unknown>;
  };

  const warnings = (): string[] => childLogger.warn.mock.calls.map((c) => String(c[0]));

  describe('create (template path) refuses', () => {
    it('throws when both an IPv4 and an IPv6 destination are declared', async () => {
      await expect(
        provider.create('MyRoute', 'AWS::EC2::Route', {
          RouteTableId: 'rtb-123',
          DestinationCidrBlock: '0.0.0.0/0',
          DestinationIpv6CidrBlock: '::/0',
          GatewayId: 'igw-1',
        })
      ).rejects.toThrow(ProvisioningError);

      // The refusal is PRE-FLIGHT: nothing may reach the wire.
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('names every declared destination key in the error message', async () => {
      await expect(
        provider.create('MyRoute', 'AWS::EC2::Route', {
          RouteTableId: 'rtb-123',
          DestinationCidrBlock: '0.0.0.0/0',
          DestinationIpv6CidrBlock: '::/0',
          DestinationPrefixListId: 'pl-123',
          GatewayId: 'igw-1',
        })
      ).rejects.toThrow(
        /declares more than one destination \(DestinationCidrBlock, DestinationIpv6CidrBlock, DestinationPrefixListId\)/
      );
    });

    it('throws for the IPv4 + prefix-list pair too', async () => {
      await expect(
        provider.create('MyRoute', 'AWS::EC2::Route', {
          RouteTableId: 'rtb-123',
          DestinationCidrBlock: '0.0.0.0/0',
          DestinationPrefixListId: 'pl-123',
          GatewayId: 'igw-1',
        })
      ).rejects.toThrow(/DestinationCidrBlock, DestinationPrefixListId/);
    });

    it('throws for the IPv6 + prefix-list pair, with no IPv4 key present', async () => {
      // Every other refusal case carries DestinationCidrBlock, so without this
      // one the reported key list could be hardcoded to the IPv4 spelling (or
      // the IPv6 tuple dropped from the guard's array) and the suite would
      // stay green.
      await expect(
        provider.create('MyRoute', 'AWS::EC2::Route', {
          RouteTableId: 'rtb-123',
          DestinationIpv6CidrBlock: '::/0',
          DestinationPrefixListId: 'pl-123',
          GatewayId: 'igw-1',
        })
      ).rejects.toThrow(/\(DestinationIpv6CidrBlock, DestinationPrefixListId\)/);
    });

    it('treats an explicit null sibling as absent, not as a second destination', async () => {
      // A state record can carry an explicit null where the template had nothing.
      mockSend.mockResolvedValue({});

      const result = await provider.create('MyRoute', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-123',
        DestinationCidrBlock: '0.0.0.0/0',
        DestinationIpv6CidrBlock: null,
        GatewayId: 'igw-1',
      });

      expect(result.physicalId).toBe('rtb-123|0.0.0.0/0');
    });

    it('counts destinations with the same predicate the precedence chain uses', async () => {
      // The casts promise `string | undefined`, but the bag is unknown-valued
      // at runtime and an unquoted YAML scalar arrives as a NUMBER. The chain
      // (`a || b || c`) skips a falsy `0`, so the guard must too — otherwise it
      // counts a destination the chain ignores and refuses a template that
      // carries exactly one usable destination.
      mockSend.mockResolvedValue({});

      const result = await provider.create('MyRoute', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-123',
        DestinationCidrBlock: 0,
        DestinationIpv6CidrBlock: '::/0',
        GatewayId: 'igw-1',
      });

      expect(result.physicalId).toBe('rtb-123|::/0');
      expect(createInput()['DestinationIpv6CidrBlock']).toBe('::/0');
    });

    it('still refuses when a context is present but not a state replay', async () => {
      // Pins `context?.replayingState === true` against being loosened to a
      // bare `context !== undefined`.
      await expect(
        provider.create(
          'MyRoute',
          'AWS::EC2::Route',
          {
            RouteTableId: 'rtb-123',
            DestinationCidrBlock: '0.0.0.0/0',
            DestinationIpv6CidrBlock: '::/0',
            GatewayId: 'igw-1',
          },
          { replayingState: false }
        )
      ).rejects.toThrow(ProvisioningError);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('create (template path) still accepts every single-destination shape', () => {
    it.each([
      ['DestinationCidrBlock', '0.0.0.0/0'],
      ['DestinationIpv6CidrBlock', '::/0'],
      ['DestinationPrefixListId', 'pl-123'],
    ])('accepts %s alone', async (key, value) => {
      mockSend.mockResolvedValue({});

      const result = await provider.create('MyRoute', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-123',
        [key]: value,
        GatewayId: 'igw-1',
      });

      expect(result.physicalId).toBe(`rtb-123|${value}`);
      expect(createInput()[key]).toBe(value);
      expect(warnings()).toHaveLength(0);
    });

    it('does not treat an EMPTY-string sibling as a second destination', async () => {
      // '' is falsy, so the `||` precedence chain already skips it — the guard
      // must agree, or a template with an Fn::If-blanked key would be refused.
      mockSend.mockResolvedValue({});

      const result = await provider.create('MyRoute', 'AWS::EC2::Route', {
        RouteTableId: 'rtb-123',
        DestinationCidrBlock: '0.0.0.0/0',
        DestinationIpv6CidrBlock: '',
        GatewayId: 'igw-1',
      });

      expect(result.physicalId).toBe('rtb-123|0.0.0.0/0');
      expect(createInput()['DestinationCidrBlock']).toBe('0.0.0.0/0');
    });
  });

  describe('state-borne paths downgrade to a warning', () => {
    it('warns and keeps the precedence winner on a replaying-state create', async () => {
      mockSend.mockResolvedValue({});

      const result = await provider.create(
        'MyRoute',
        'AWS::EC2::Route',
        {
          RouteTableId: 'rtb-123',
          DestinationCidrBlock: '0.0.0.0/0',
          DestinationIpv6CidrBlock: '::/0',
          GatewayId: 'igw-1',
        },
        { replayingState: true }
      );

      expect(result.physicalId).toBe('rtb-123|0.0.0.0/0');

      const input = createInput();
      expect(input['DestinationCidrBlock']).toBe('0.0.0.0/0');
      // The narrowing is what the pre-fix code did; the point is that it is now
      // ANNOUNCED rather than silent.
      expect(input['DestinationIpv6CidrBlock']).toBeUndefined();

      expect(warnings().some((m) => /declares more than one destination/.test(m))).toBe(true);
      expect(warnings().some((m) => /Continuing with DestinationCidrBlock/.test(m))).toBe(true);
      // The warning must not claim a state origin: `updateRoute` passes the
      // same callback on an ordinary template-borne deploy, where that would
      // be false and would contradict "remove the extra keys from the template".
      expect(warnings().some((m) => /come from cdkd state/.test(m))).toBe(false);
    });

    it('names the ACTUAL winning key when the winner is not the IPv4 one', async () => {
      // Without an IPv4-free warn case, `usedKey` can be hardcoded to
      // 'DestinationCidrBlock' and the whole suite stays green (verified by
      // mutation). This is the warn-arm twin of the IPv6+prefix throw case.
      mockSend.mockResolvedValue({});

      const result = await provider.create(
        'MyRoute',
        'AWS::EC2::Route',
        {
          RouteTableId: 'rtb-123',
          DestinationIpv6CidrBlock: '::/0',
          DestinationPrefixListId: 'pl-123',
          GatewayId: 'igw-1',
        },
        { replayingState: true }
      );

      expect(result.physicalId).toBe('rtb-123|::/0');
      expect(createInput()['DestinationIpv6CidrBlock']).toBe('::/0');
      expect(createInput()['DestinationPrefixListId']).toBeUndefined();
      expect(warnings().some((m) => /Continuing with DestinationIpv6CidrBlock/.test(m))).toBe(true);
    });

    it('warns rather than stranding the route on the update delete-and-recreate', async () => {
      mockSend.mockResolvedValue({});

      const result = await provider.update(
        'MyRoute',
        'rtb-123|0.0.0.0/0',
        'AWS::EC2::Route',
        {
          RouteTableId: 'rtb-123',
          DestinationCidrBlock: '0.0.0.0/0',
          DestinationIpv6CidrBlock: '::/0',
          GatewayId: 'igw-2',
        },
        {
          RouteTableId: 'rtb-123',
          DestinationCidrBlock: '0.0.0.0/0',
          DestinationIpv6CidrBlock: '::/0',
          GatewayId: 'igw-1',
        }
      );

      expect(result.wasReplaced).toBe(true);
      // update() deletes BEFORE re-creating, which is precisely why the guard
      // cannot throw here — a refusal would leave the route deleted. Assert the
      // ORDER, not mere presence: a presence check also passes if the calls
      // were swapped, which would invalidate the reason for the downgrade.
      const deleteAt = mockSend.mock.calls.findIndex((c) => c[0] instanceof DeleteRouteCommand);
      const createAt = mockSend.mock.calls.findIndex((c) => c[0] instanceof CreateRouteCommand);
      expect(deleteAt).toBeGreaterThanOrEqual(0);
      expect(createAt).toBeGreaterThan(deleteAt);
      expect(createInput()['GatewayId']).toBe('igw-2');
      expect(warnings().some((m) => /declares more than one destination/.test(m))).toBe(true);
    });

    it('leaves the unchanged-properties short-circuit untouched', async () => {
      const properties = {
        RouteTableId: 'rtb-123',
        DestinationCidrBlock: '0.0.0.0/0',
        DestinationIpv6CidrBlock: '::/0',
        GatewayId: 'igw-1',
      };

      const result = await provider.update(
        'MyRoute',
        'rtb-123|0.0.0.0/0',
        'AWS::EC2::Route',
        properties,
        { ...properties }
      );

      expect(result.wasReplaced).toBe(false);
      expect(mockSend).not.toHaveBeenCalled();
      expect(warnings()).toHaveLength(0);
    });
  });
});
