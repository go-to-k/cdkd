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
 * Issue #1633: `AWS::EC2::SecurityGroupIngress` `IpProtocol` reached the wire as
 * something other than what the template declared, and cdkd recorded the
 * DECLARED value — the identical shape #1591 fixed one method over.
 *
 * `createSecurityGroupIngress` warn-substitutes `-1` for a malformed
 * `IpProtocol` and SENDS that default, while `readSecurityGroupIngressCurrentState`
 * can only return what AWS holds. The difference was PERMANENT phantom drift:
 * reported by every `cdkd drift`, and "repaired" by `drift --revert` into
 * another `update()` that revokes, re-authorizes and re-emits the same warning.
 *
 * Both halves of the #1591 remedy are required and both are pinned here:
 * `effectiveProperties` (state describes what AWS holds) and
 * `canonicalizeDesiredProperties` (the diff describes the same thing). The
 * second is not optional polish — `IpProtocol` is create-only on this type in
 * the registry schema, so normalizing state alone would classify the template's
 * original value as a changed IMMUTABLE property and turn a green no-op deploy
 * into a replacement whose create, receiving no context, hits the refusal.
 */
describe('EC2Provider AWS::EC2::SecurityGroupIngress IpProtocol effectiveProperties (#1633)', () => {
  let provider: EC2Provider;

  const RESOURCE_TYPE = 'AWS::EC2::SecurityGroupIngress';
  const GROUP_ID = 'sg-123';
  const PHYSICAL_ID = `${GROUP_ID}|tcp|443|443`;

  beforeEach(() => {
    vi.clearAllMocks();
    childLogger.child.mockReturnValue(childLogger);
    provider = new EC2Provider();
    mockSend.mockResolvedValue({});
  });

  // FROZEN and rebuilt per call: the "does not MUTATE the caller's bag" row
  // below is only meaningful if an in-place write THROWS rather than quietly
  // succeeding, and a shared object would let one test's narrowing satisfy
  // another's assertion.
  const malformed = (ipProtocol: unknown) =>
    Object.freeze({
      GroupId: GROUP_ID,
      IpProtocol: ipProtocol,
      FromPort: 443,
      ToPort: 443,
      CidrIp: '10.0.0.0/16',
    }) as Record<string, unknown>;

  const sentIpProtocol = (): unknown => {
    const authorize = mockSend.mock.calls
      .map((c) => c[0])
      .find((c) => c?.constructor?.name === 'AuthorizeSecurityGroupIngressCommand');
    expect(authorize).toBeDefined();
    return authorize.input.IpPermissions[0].IpProtocol;
  };

  describe('the update arm — the path the drift actually reached users on', () => {
    // A malformed value can only survive to reach a rule that ALREADY exists:
    // the template-path create refuses it outright (#1513), so `update()` (which
    // revokes then re-creates under the warn callback) is the population that
    // hit the drift.
    it('records the substituted default, not the malformed declared value', async () => {
      const result = await provider.update(
        'Ingress',
        PHYSICAL_ID,
        RESOURCE_TYPE,
        malformed(''),
        { GroupId: GROUP_ID, IpProtocol: 'tcp', FromPort: 443, ToPort: 443, CidrIp: '10.0.0.0/8' }
      );

      expect(result.effectiveProperties).toEqual({
        GroupId: GROUP_ID,
        IpProtocol: '-1',
        FromPort: 443,
        ToPort: 443,
        CidrIp: '10.0.0.0/16',
      });
      expect(result.wasReplaced).toBe(true);
    });

    it('the RECORDED protocol is the one that reached AuthorizeSecurityGroupIngress', async () => {
      // Without this the suite only pins the returned object's shape, so a
      // change that sent one value and recorded another would leave every row
      // above green while re-creating the original bug with a different value.
      const result = await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, malformed({}), {
        GroupId: GROUP_ID,
        IpProtocol: 'tcp',
      });

      expect(result.effectiveProperties?.['IpProtocol']).toBe(sentIpProtocol());
      expect(sentIpProtocol()).toBe('-1');
    });

    it('the recorded bag matches what readCurrentState can return — the drift is gone', async () => {
      // The invariant the whole change exists for, asserted against the shape
      // `flattenIpPermissions` produces: AWS reports the protocol as the STRING
      // it holds, never as the template's malformed value.
      const result = await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, malformed(true), {
        GroupId: GROUP_ID,
        IpProtocol: 'tcp',
      });

      expect(typeof result.effectiveProperties?.['IpProtocol']).toBe('string');
      expect(result.effectiveProperties?.['IpProtocol']).toBe('-1');
    });

    it('still WARNS — recording the substitution does not replace announcing it', async () => {
      await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, malformed(''), {
        GroupId: GROUP_ID,
        IpProtocol: 'tcp',
      });

      expect(childLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('AWS::EC2::SecurityGroupIngress IpProtocol')
      );
    });

    it('does not MUTATE the caller’s bag', async () => {
      // The engine holds `resolvedProps` and records it for every resource that
      // does NOT narrow; an in-place write would corrupt that. Frozen, so the
      // write throws instead of silently succeeding.
      const desired = malformed('');
      await provider.update('Ingress', PHYSICAL_ID, RESOURCE_TYPE, desired, {
        GroupId: GROUP_ID,
        IpProtocol: 'tcp',
      });

      expect(desired['IpProtocol']).toBe('');
    });
  });

  describe('the state-replay create arm', () => {
    it('records the substituted default on a rollback replay', async () => {
      const result = await provider.create('Ingress', RESOURCE_TYPE, malformed(null), {
        replayingState: true,
      });

      expect(result.effectiveProperties?.['IpProtocol']).toBe('-1');
      expect(sentIpProtocol()).toBe('-1');
    });

    it('the idempotent "already exists" arm records it too', async () => {
      // That arm reports the rule as provisioned, so the engine writes state
      // from it — the narrowing has to reach it or the phantom drift survives
      // on exactly the re-run path.
      mockSend.mockRejectedValue(new Error('the specified rule already exists'));

      const result = await provider.create('Ingress', RESOURCE_TYPE, malformed(''), {
        replayingState: true,
      });

      expect(result.physicalId).toBe(`${GROUP_ID}|-1|443|443`);
      expect(result.effectiveProperties?.['IpProtocol']).toBe('-1');
    });

    it('a TEMPLATE-path create still REFUSES rather than substituting (#1513 unchanged)', async () => {
      // The fence that keeps this change from reading as a relaxation:
      // recording what was sent is the replay/update answer, NOT a new licence
      // to accept a malformed value from a template the user can fix.
      await expect(provider.create('Ingress', RESOURCE_TYPE, malformed(''))).rejects.toThrow(
        /AWS::EC2::SecurityGroupIngress IpProtocol/
      );
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe('the NUMBER arm — accepted by design, still not what state recorded', () => {
    // An unquoted YAML `IpProtocol: -1` is a NUMBER and deploys fine (#1513),
    // but it is STRINGIFIED before it is sent, so the un-narrowed record
    // produced the same permanent phantom drift via a completely different
    // route — and, on the delete path, handed the EC2 API a number.
    it('records the stringified protocol a numeric template declares', async () => {
      const result = await provider.create('Ingress', RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: -1,
        CidrIp: '10.0.0.0/16',
      });

      expect(result.effectiveProperties?.['IpProtocol']).toBe('-1');
      expect(sentIpProtocol()).toBe('-1');
    });

    it('does NOT warn — a lossless coercion has nothing to announce', async () => {
      // The `effectiveProperties` contract reaches for an ANNOUNCED narrowing so
      // a silent DROP cannot be laundered into a clean record. `-1` and `'-1'`
      // name the same protocol, so there is no loss and no warning; asserting
      // that keeps the two arms from being conflated.
      await provider.create('Ingress', RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: 6,
        CidrIp: '10.0.0.0/16',
      });

      expect(childLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('no narrowing — the field stays ABSENT so the engine records the desired bag', () => {
    it('an ordinary string protocol returns no effectiveProperties', async () => {
      const result = await provider.create('Ingress', RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: 'tcp',
        FromPort: 443,
        ToPort: 443,
      });

      // Absent, not "equal to the desired bag": the engine's fallback is
      // `?? desiredProperties`, and an eagerly-populated field would make every
      // rule look like it narrowed.
      expect(result.effectiveProperties).toBeUndefined();
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it('an ABSENT IpProtocol stays absent rather than gaining the default', async () => {
      // The drift comparator only descends into keys PRESENT in cdkd state, so
      // materializing `-1` here would START comparing a key the template never
      // declared — manufacturing drift in the one case that does not have it.
      const result = await provider.create('Ingress', RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        CidrIp: '10.0.0.0/16',
      });

      expect(result.effectiveProperties).toBeUndefined();
      expect(sentIpProtocol()).toBe('-1');
    });
  });

  describe('canonicalizeDesiredProperties — the diff-side half', () => {
    it('narrows a malformed value the same way the provisioning path does', () => {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, malformed(''));

      expect(canonical).toEqual({
        GroupId: GROUP_ID,
        IpProtocol: '-1',
        FromPort: 443,
        ToPort: 443,
        CidrIp: '10.0.0.0/16',
      });
    });

    it('narrows the NUMBER arm too, so a numeric template stops reading as a change', () => {
      const canonical = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: -1,
      });

      expect(canonical['IpProtocol']).toBe('-1');
    });

    it('normalizes BOTH comparison sides to the same value', () => {
      // The load-bearing property, and the one #1591 learned the hard way: a
      // record written BEFORE the narrowing existed still carries the raw
      // value, so a one-sided pass would flip the difference to a REMOVAL and
      // break exactly the population the fix exists for. Asserted as the two
      // sides agreeing, not as either side's literal shape.
      const stateSide = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: -1,
      });
      const templateSide = provider.canonicalizeDesiredProperties(RESOURCE_TYPE, {
        GroupId: GROUP_ID,
        IpProtocol: '-1',
      });

      expect(stateSide).toEqual(templateSide);
    });

    it('returns the bag UNTOUCHED for an ordinary protocol', () => {
      // Identity, not deep-equality: an ordinary rule must compare
      // byte-for-byte as before, and returning a fresh clone would be a silent
      // invitation for a future change to start rewriting it.
      const properties = { GroupId: GROUP_ID, IpProtocol: 'tcp' };

      expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, properties)).toBe(properties);
    });

    it('returns the bag UNTOUCHED when IpProtocol is absent', () => {
      const properties = { GroupId: GROUP_ID, CidrIp: '10.0.0.0/16' };

      expect(provider.canonicalizeDesiredProperties(RESOURCE_TYPE, properties)).toBe(properties);
    });

    it('never THROWS and never WARNS on a malformed value', () => {
      // A diff must not fail, and must not double-announce: the provisioning
      // path already warns about the identical substitution, so a diff pass
      // over an unchanged resource would otherwise emit it again.
      expect(() =>
        provider.canonicalizeDesiredProperties(RESOURCE_TYPE, malformed({ nested: true }))
      ).not.toThrow();
      expect(childLogger.warn).not.toHaveBeenCalled();
    });

    it('leaves an UNRELATED resource type alone', () => {
      // The narrowing is keyed on the standalone type. The INLINE
      // `SecurityGroupIngress` rules of an `AWS::EC2::SecurityGroup` are a
      // different shape (a list, diffed per rule), and applying a top-level
      // `IpProtocol` rewrite to that bag would corrupt it.
      const properties = { GroupDescription: 'sg', IpProtocol: '' };

      expect(provider.canonicalizeDesiredProperties('AWS::EC2::SecurityGroup', properties)).toBe(
        properties
      );
    });

    it('still narrows AWS::EC2::Route destinations (#1591 arm unchanged)', () => {
      // The two arms share one method; this fences the Route arm against a
      // refactor that adds the ingress branch and drops through.
      const canonical = provider.canonicalizeDesiredProperties('AWS::EC2::Route', {
        RouteTableId: 'rtb-1',
        DestinationCidrBlock: '10.0.0.0/16',
        DestinationIpv6CidrBlock: '::/0',
      });

      expect(canonical).toEqual({ RouteTableId: 'rtb-1', DestinationCidrBlock: '10.0.0.0/16' });
    });
  });

  describe('the readback key heals PRE-#1633 records', () => {
    // A record written before this change holds the NUMBER. AWS always reports
    // the protocol as a string, so `sgRuleKey` keyed `{"p":-1}` against AWS's
    // `{"p":"-1"}`, matched nothing, and `readSecurityGroupIngressCurrentState`
    // returned undefined — `cdkd drift` reported the rule GONE, forever. And
    // because the canonicalizer now makes such a record's diff NO_CHANGE, no
    // deploy ever rewrites it either, so normalizing at the KEY is the only
    // thing that heals the existing population.
    const liveRule = {
      IpPermissions: [
        {
          IpProtocol: '-1',
          IpRanges: [{ CidrIp: '10.0.0.0/16' }],
        },
      ],
    };

    it('matches a legacy record whose IpProtocol is the NUMBER -1', async () => {
      mockSend.mockResolvedValue({ SecurityGroups: [liveRule] });

      const read = await provider.readCurrentState!(
        `${GROUP_ID}|-1|-1|-1`,
        'Ingress',
        RESOURCE_TYPE,
        // The legacy shape: a NUMBER, as written by a pre-#1633 binary.
        { GroupId: GROUP_ID, IpProtocol: -1, CidrIp: '10.0.0.0/16' }
      );

      expect(read).toBeDefined();
      expect(read).toMatchObject({ IpProtocol: '-1', CidrIp: '10.0.0.0/16' });
    });

    it('still matches a record already holding the STRING', async () => {
      mockSend.mockResolvedValue({ SecurityGroups: [liveRule] });

      const read = await provider.readCurrentState!(
        `${GROUP_ID}|-1|-1|-1`,
        'Ingress',
        RESOURCE_TYPE,
        { GroupId: GROUP_ID, IpProtocol: '-1', CidrIp: '10.0.0.0/16' }
      );

      expect(read).toBeDefined();
    });
  });
});
