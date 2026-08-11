import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

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

/**
 * Issue #1591: the multi-destination warn arm used to record a bag AWS cannot
 * represent, producing PERMANENT phantom drift.
 *
 * #1590 made `createRoute` REFUSE a template declaring more than one of
 * `DestinationCidrBlock` / `DestinationIpv6CidrBlock` / `DestinationPrefixListId`,
 * and downgraded that refusal to a WARNING on the state-borne paths — including
 * `updateRoute`, which deletes the route before re-creating it, so a throw
 * there would strand it.
 *
 * The residue: the update SUCCEEDS, so the deploy engine recorded the DESIRED
 * bag — every declared destination key — while `readRouteCurrentState` can only
 * ever return the ONE key AWS holds. The difference was reported by every
 * `cdkd drift`, and `drift --revert` "repaired" it by calling `update()` again,
 * which delete-and-recreated the route and re-emitted the same warning. Forever.
 *
 * The fix is the provider handing back what it actually SENT
 * (`effectiveProperties`), which the engine records instead of the desired bag.
 * The engine-side half is pinned in
 * `tests/unit/deployment/deploy-engine-effective-properties.test.ts`; this file
 * pins the provider's half.
 *
 * Note what is NOT asserted here: the CREATE path. `create()` still refuses a
 * multi-destination bag outright (#1566), so the only ways into the warn arm
 * are a state replay or `update()` — which is exactly the population that hit
 * the drift.
 */
describe('EC2Provider AWS::EC2::Route effectiveProperties (#1591)', () => {
  let provider: EC2Provider;

  const RESOURCE_TYPE = 'AWS::EC2::Route';
  const ROUTE_TABLE = 'rtb-123';

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
    mockSend.mockResolvedValue({});
  });

  // Every destination key AWS could hold, so the losing set is never empty and
  // the precedence winner is unambiguous.
  const multiDestination = {
    RouteTableId: ROUTE_TABLE,
    DestinationCidrBlock: '10.0.0.0/16',
    DestinationIpv6CidrBlock: '::/0',
    DestinationPrefixListId: 'pl-1234',
    GatewayId: 'igw-abc',
  };

  describe('the state-replay create arm', () => {
    it('returns the NARROWED bag, keeping only the precedence winner', async () => {
      const result = await provider.create('R', RESOURCE_TYPE, multiDestination, {
        replayingState: true,
      });

      // `DestinationCidrBlock` wins the `||` chain, so it is the one key AWS
      // actually holds — and the only destination key state may record.
      expect(result.effectiveProperties).toEqual({
        RouteTableId: ROUTE_TABLE,
        DestinationCidrBlock: '10.0.0.0/16',
        GatewayId: 'igw-abc',
      });
    });

    it('keeps every NON-destination property verbatim', async () => {
      // The narrowing is scoped to the destination keys; dropping anything
      // else would silently disable the #1160 absent-field removal derivation
      // for those properties on the next deploy, since it reads this bag as
      // the previous side.
      const result = await provider.create(
        'R',
        RESOURCE_TYPE,
        { ...multiDestination, NatGatewayId: 'nat-1', VpcEndpointId: 'vpce-1' },
        { replayingState: true }
      );

      expect(result.effectiveProperties).toMatchObject({
        GatewayId: 'igw-abc',
        NatGatewayId: 'nat-1',
        VpcEndpointId: 'vpce-1',
        RouteTableId: ROUTE_TABLE,
      });
    });

    it('does not MUTATE the caller’s bag', async () => {
      // The engine holds `resolvedProps` and records it for every resource that
      // does not narrow; mutating it in place would corrupt that.
      const desired = { ...multiDestination };
      await provider.create('R', RESOURCE_TYPE, desired, { replayingState: true });

      expect(desired).toEqual(multiDestination);
    });

    it('still warns — recording the narrowing does not replace announcing it', async () => {
      await provider.create('R', RESOURCE_TYPE, multiDestination, { replayingState: true });

      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Continuing with DestinationCidrBlock and ignoring the rest')
      );
    });
  });

  describe('the update arm — the path the drift actually reached users on', () => {
    it('forwards the narrowed bag from the re-create', async () => {
      const result = await provider.update(
        'R',
        `${ROUTE_TABLE}|10.0.0.0/16`,
        RESOURCE_TYPE,
        multiDestination,
        { RouteTableId: ROUTE_TABLE, DestinationCidrBlock: '10.0.0.0/16' }
      );

      expect(result.effectiveProperties).toEqual({
        RouteTableId: ROUTE_TABLE,
        DestinationCidrBlock: '10.0.0.0/16',
        GatewayId: 'igw-abc',
      });
      expect(result.wasReplaced).toBe(true);
    });

    it('recorded bag matches what readCurrentState can return — the drift is gone', async () => {
      // The point of the whole change, asserted as the invariant rather than as
      // an implementation detail: whatever destination keys the recorded bag
      // carries must be exactly the ones AWS holds, which for a route is
      // always exactly one.
      const result = await provider.update(
        'R',
        `${ROUTE_TABLE}|10.0.0.0/16`,
        RESOURCE_TYPE,
        multiDestination,
        { RouteTableId: ROUTE_TABLE, DestinationCidrBlock: '10.0.0.0/16' }
      );

      const destinationKeys = Object.keys(result.effectiveProperties ?? {}).filter((k) =>
        k.startsWith('Destination')
      );
      expect(destinationKeys).toEqual(['DestinationCidrBlock']);
    });
  });

  describe('precedence: the recorded key is the one actually SENT', () => {
    // A bag whose winner is NOT the first-listed key would expose a narrowing
    // computed from the declaration order instead of from the resolved
    // destination — recording a key AWS does not hold, i.e. the same bug with
    // a different key.
    it('records DestinationIpv6CidrBlock when the CIDR key is absent', async () => {
      const result = await provider.create(
        'R',
        RESOURCE_TYPE,
        {
          RouteTableId: ROUTE_TABLE,
          DestinationIpv6CidrBlock: '::/0',
          DestinationPrefixListId: 'pl-1234',
        },
        { replayingState: true }
      );

      expect(result.effectiveProperties).toEqual({
        RouteTableId: ROUTE_TABLE,
        DestinationIpv6CidrBlock: '::/0',
      });
      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Continuing with DestinationIpv6CidrBlock')
      );
    });
  });

  describe('no narrowing — the field stays ABSENT so the engine records the desired bag', () => {
    it('a single-destination create returns no effectiveProperties', async () => {
      const result = await provider.create('R', RESOURCE_TYPE, {
        RouteTableId: ROUTE_TABLE,
        DestinationCidrBlock: '10.0.0.0/16',
        GatewayId: 'igw-abc',
      });

      // Absent, not "equal to the desired bag": the engine's fallback is
      // `?? desiredProperties`, and an eagerly-populated field would make every
      // route look like it narrowed.
      expect(result.effectiveProperties).toBeUndefined();
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it('a single-destination update returns no effectiveProperties', async () => {
      const result = await provider.update(
        'R',
        `${ROUTE_TABLE}|10.0.0.0/16`,
        RESOURCE_TYPE,
        { RouteTableId: ROUTE_TABLE, DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-xyz' },
        { RouteTableId: ROUTE_TABLE, DestinationCidrBlock: '10.0.0.0/16', GatewayId: 'igw-abc' }
      );

      expect(result.effectiveProperties).toBeUndefined();
    });

    it('a TEMPLATE-path create still REFUSES rather than narrowing (#1566 unchanged)', async () => {
      // The fence that keeps this change from being mistaken for a relaxation:
      // recording the narrowed bag is the replay/update answer, NOT a new
      // licence to accept the CFn-invalid shape from a template.
      await expect(provider.create('R', RESOURCE_TYPE, multiDestination)).rejects.toThrow(
        /declares more than one destination/
      );
    });
  });
});
