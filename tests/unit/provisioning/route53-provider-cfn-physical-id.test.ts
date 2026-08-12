import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ChangeResourceRecordSetsCommand,
  ListHostedZonesByNameCommand,
  ListResourceRecordSetsCommand,
} from '@aws-sdk/client-route-53';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-route-53')>(
    '@aws-sdk/client-route-53'
  );
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
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

import {
  Route53Provider,
  parseRecordSetCompositeId,
} from '../../../src/provisioning/providers/route53-provider.js';

const RECORD_PROPS = {
  HostedZoneId: 'Z0123456789ABCDEFGHIJ',
  Name: 'record.example.com.',
  Type: 'A',
  TTL: 300,
  ResourceRecords: ['1.2.3.4'],
};

/** The shape `ListResourceRecordSets` returns for RECORD_PROPS. */
const AWS_RECORD = {
  ResourceRecordSets: [
    {
      Name: 'record.example.com.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: [{ Value: '1.2.3.4' }],
    },
  ],
};

describe('Route53 RecordSet physicalId: CloudFormation form vs cdkd composite (issue #1658)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  describe('parseRecordSetCompositeId', () => {
    it('parses cdkd composite ids', () => {
      expect(parseRecordSetCompositeId('Z1|record.example.com.|A')).toEqual({
        hostedZoneId: 'Z1',
        name: 'record.example.com.',
        type: 'A',
      });
    });

    it("rejects CloudFormation's scalar physicalId (the record name)", () => {
      expect(parseRecordSetCompositeId('record.example.com')).toBeUndefined();
    });

    it('rejects wrong-arity and blank-segment ids', () => {
      expect(parseRecordSetCompositeId('Z1|record.example.com.')).toBeUndefined();
      expect(parseRecordSetCompositeId('Z1|record.example.com.|A|extra')).toBeUndefined();
      expect(parseRecordSetCompositeId('Z1||A')).toBeUndefined();
    });
  });

  describe('import()', () => {
    it("canonicalizes CloudFormation's record-name physicalId into cdkd's composite", async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        // What `--migrate-from-cloudformation` pre-populates from
        // DescribeStackResources: CFn's physicalId, not cdkd's composite.
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toEqual({
        physicalId: 'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        attributes: {},
      });
      const verify = mockSend.mock.calls[0]?.[0];
      expect(verify).toBeInstanceOf(ListResourceRecordSetsCommand);
      expect(verify.input).toMatchObject({ HostedZoneId: 'Z0123456789ABCDEFGHIJ' });
    });

    it('passes an already-composite override through without an AWS call', async () => {
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        knownPhysicalId: 'Z9|record.example.com.|A',
      });

      expect(result).toEqual({ physicalId: 'Z9|record.example.com.|A', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('resolves the zone via HostedZoneName when the template has no HostedZoneId', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [{ Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'example.com.' }],
        })
        .mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { ...RECORD_PROPS, HostedZoneId: undefined, HostedZoneName: 'example.com' },
        knownPhysicalId: 'record.example.com',
      });

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListHostedZonesByNameCommand);
      expect(result).toEqual({
        physicalId: 'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        attributes: {},
      });
    });

    it('stays override-only: declines with no override, per docs/import.md', async () => {
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
      });

      expect(result).toBeNull();
      expect(mockSend).not.toHaveBeenCalled();
    });

    // The import command aborts only when ZERO resources import, so a `null`
    // here lets --migrate-from-cloudformation retire the CFn stack while the
    // record is in NEITHER system. Adopting verbatim is safe because delete
    // and drift both accept the scalar form.
    it('adopts VERBATIM (never null) when the record cannot be found in AWS', async () => {
      mockSend.mockResolvedValueOnce({ ResourceRecordSets: [] });

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toEqual({ physicalId: 'record.example.com', attributes: {} });
    });

    it('adopts VERBATIM when the zone cannot be resolved from the template', async () => {
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: { Name: 'record.example.com.', Type: 'A' },
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toEqual({ physicalId: 'record.example.com', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('adopts VERBATIM when HostedZoneId is still an unresolved intrinsic', async () => {
      // `import.ts` substitutes only single-key {Ref}; Fn::ImportValue / GetAtt
      // reach the provider as objects. An unguarded read would stringify this
      // to '[object Object]' and send it to AWS as a zone id.
      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: {
          ...RECORD_PROPS,
          HostedZoneId: { 'Fn::ImportValue': 'SharedZoneId' },
        },
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toEqual({ physicalId: 'record.example.com', attributes: {} });
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('adopts VERBATIM when verification throws (e.g. a throttle)', async () => {
      mockSend.mockRejectedValueOnce(new Error('Throttling: Rate exceeded'));

      const result = await provider.import({
        logicalId: 'WebsiteRecord',
        resourceType: 'AWS::Route53::RecordSet',
        stackName: 'MyStack',
        region: 'us-east-1',
        properties: RECORD_PROPS,
        knownPhysicalId: 'record.example.com',
      });

      expect(result).toEqual({ physicalId: 'record.example.com', attributes: {} });
    });

  });

  describe('delete()', () => {
    it('deletes a record whose state carries the cdkd composite id', async () => {
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'WebsiteRecord',
        'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(call.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    });

    it("deletes a record whose state carries CloudFormation's scalar id, by resolving the zone from properties", async () => {
      mockSend.mockResolvedValueOnce({});

      // Pre-#1658 state written by `cdkd import --migrate-from-cloudformation`.
      await provider.delete(
        'WebsiteRecord',
        'record.example.com',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      const call = mockSend.mock.calls[0]?.[0];
      expect(call).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(call.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
      expect(call.input.ChangeBatch.Changes[0].Action).toBe('DELETE');
    });

    it('resolves the zone via HostedZoneName when state carries the scalar id and no HostedZoneId', async () => {
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [{ Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'example.com.' }],
        })
        .mockResolvedValueOnce({});

      await provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
        ...RECORD_PROPS,
        HostedZoneId: undefined,
        HostedZoneName: 'example.com',
      });

      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ListHostedZonesByNameCommand);
      const del = mockSend.mock.calls[1]?.[0];
      expect(del).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(del.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    });

    it('refuses to guess between split-horizon zones of the same name', async () => {
      // A public and a private zone can share one name. Deleting from the
      // wrong one is unrecoverable, and this fallback is what newly routes
      // delete through name resolution.
      mockSend.mockResolvedValueOnce({
        HostedZones: [
          { Id: '/hostedzone/ZPUBLIC000000000000', Name: 'example.com.' },
          { Id: '/hostedzone/ZPRIVATE00000000000', Name: 'example.com.' },
        ],
      });

      await expect(
        provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
          ...RECORD_PROPS,
          HostedZoneId: undefined,
          HostedZoneName: 'example.com',
        })
      ).rejects.toThrow(/matches 2 hosted zones/);

      // Reverting to MaxItems: 1 would make the guard UNREACHABLE in
      // production (AWS would only ever return one zone) while this mock
      // still returned two — the assertion exists so that cannot pass.
      expect(mockSend.mock.calls[0]?.[0].input.MaxItems).toBeGreaterThan(1);
    });

    it('deletes with a COMPOSITE id and no HostedZoneName lookup', async () => {
      // Pins the reordered guard: the composite short-circuits zone
      // resolution entirely, so no ListHostedZonesByName is issued.
      mockSend.mockResolvedValueOnce({});

      await provider.delete(
        'WebsiteRecord',
        'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        'AWS::Route53::RecordSet',
        { ...RECORD_PROPS, HostedZoneId: undefined, HostedZoneName: 'example.com' }
      );

      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend.mock.calls[0]?.[0]).toBeInstanceOf(ChangeResourceRecordSetsCommand);
    });

    it('rejects a composite id with no properties at all', async () => {
      await expect(
        provider.delete(
          'WebsiteRecord',
          'Z0123456789ABCDEFGHIJ|record.example.com.|A',
          'AWS::Route53::RecordSet',
          undefined
        )
      ).rejects.toThrow(/Properties required/);
    });

    it('treats a vanished hosted zone as already-gone rather than erroring', async () => {
      // A name that resolves cleanly to ZERO zones means the zone (and its
      // records) are gone. Surfacing "HostedZoneId or HostedZoneName is
      // required" there would be the wrong description AND would block
      // `cdkd destroy`.
      mockSend.mockResolvedValueOnce({ HostedZones: [] });

      await expect(
        provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
          ...RECORD_PROPS,
          HostedZoneId: undefined,
          HostedZoneName: 'example.com',
        })
      ).resolves.toBeUndefined();

      // Only the lookup ran — no ChangeResourceRecordSets was attempted.
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('matches a zone whose template spelling differs only in CASE', async () => {
      // DNS is case-insensitive and AWS lowercases what it returns. Without
      // the lowercase fold this resolved to "zone is gone" and would DROP the
      // state row while leaving the record live in AWS.
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [{ Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'example.com.' }],
        })
        .mockResolvedValueOnce({});

      await provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
        ...RECORD_PROPS,
        HostedZoneId: undefined,
        HostedZoneName: 'Example.COM',
      });

      const del = mockSend.mock.calls[1]?.[0];
      expect(del).toBeInstanceOf(ChangeResourceRecordSetsCommand);
      expect(del.input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    });

    it('sends the CASE-FOLDED, ENCODED name as the list START KEY (#1658)', async () => {
      // The compare-side fold is only half the fix. AWS positions the window
      // by the name it STORES, so a verbatim `Example.COM` start key can put
      // an existing zone outside a bounded page -- and this arm reads an
      // empty page as "zone is gone" and DROPS the state row. Pin the query
      // side, not just the answer.
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [{ Id: '/hostedzone/Z0123456789ABCDEFGHIJ', Name: 'example.com.' }],
        })
        .mockResolvedValueOnce({});

      await provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
        ...RECORD_PROPS,
        HostedZoneId: undefined,
        HostedZoneName: 'Example.COM',
      });

      const list = mockSend.mock.calls[0]?.[0];
      expect(list).toBeInstanceOf(ListHostedZonesByNameCommand);
      expect(list.input.DNSName).toBe('example.com.');
    });

    it('does NOT treat a FAILED zone lookup as already-deleted (#1658)', async () => {
      // The dangerous polarity of the skip-as-gone arm. A throttle / creds /
      // network failure must never authorize dropping the state row -- if it
      // did, a transient error would silently orphan a live record. The
      // original error has to reach the user, too: the pre-fix message named
      // neither the zone nor the cause.
      const throttle = new Error('Rate exceeded');
      throttle.name = 'Throttling';
      mockSend.mockRejectedValueOnce(throttle);

      await expect(
        provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
          ...RECORD_PROPS,
          HostedZoneId: undefined,
          HostedZoneName: 'example.com',
        })
      ).rejects.toThrow(/Rate exceeded/);

      // and it must NOT have issued the delete, nor silently resolved
      expect(
        mockSend.mock.calls.some(
          (c: unknown[]) => c[0] instanceof ChangeResourceRecordSetsCommand
        )
      ).toBe(false);
    });

    it('does NOT conclude "gone" from an EMPTY TRUNCATED page (#1658)', async () => {
      // An empty page that AWS says is truncated proves nothing about whether
      // the zone exists, so it must not authorize the state-row drop.
      mockSend.mockResolvedValueOnce({ HostedZones: [], IsTruncated: true });

      await expect(
        provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
          ...RECORD_PROPS,
          HostedZoneId: undefined,
          HostedZoneName: 'example.com',
        })
      ).rejects.toThrow(/HostedZoneId or HostedZoneName is required/);

      expect(
        mockSend.mock.calls.some(
          (c: unknown[]) => c[0] instanceof ChangeResourceRecordSetsCommand
        )
      ).toBe(false);
    });

    it('still errors when neither the id nor the properties identify a zone', async () => {
      await expect(
        provider.delete('WebsiteRecord', 'record.example.com', 'AWS::Route53::RecordSet', {
          Name: 'record.example.com.',
          Type: 'A',
        })
      ).rejects.toThrow(/HostedZoneId or HostedZoneName is required/);
    });
  });

  describe('create / update paths (the guard is not import-only)', () => {
    // Pin BOTH polarities of the typeof guard: the fix's stated create/update
    // benefit is otherwise unpinned, and a regression there sends AWS the
    // string '[object Object]' as a hosted zone id.
    it('refuses an object HostedZoneId on create instead of sending [object Object]', async () => {
      await expect(
        provider.create('WebsiteRecord', 'AWS::Route53::RecordSet', {
          ...RECORD_PROPS,
          HostedZoneId: { 'Fn::ImportValue': 'SharedZoneId' },
        })
      ).rejects.toThrow(/HostedZoneId or HostedZoneName is required/);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('still accepts a plain-string HostedZoneId on create', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await provider.create(
        'WebsiteRecord',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      expect(result.physicalId).toBe('Z0123456789ABCDEFGHIJ|record.example.com.|A');
      expect(mockSend.mock.calls[0]?.[0].input.HostedZoneId).toBe('Z0123456789ABCDEFGHIJ');
    });

    it('does NOT refuse split-horizon on create (first-match preserved)', async () => {
      // Deliberate asymmetry: refusing here would break deploys that work
      // today. Only the destructive / state-freezing paths require an
      // unambiguous zone.
      mockSend
        .mockResolvedValueOnce({
          HostedZones: [
            { Id: '/hostedzone/ZPUBLIC000000000000', Name: 'example.com.' },
            { Id: '/hostedzone/ZPRIVATE00000000000', Name: 'example.com.' },
          ],
        })
        .mockResolvedValueOnce({});

      const result = await provider.create('WebsiteRecord', 'AWS::Route53::RecordSet', {
        ...RECORD_PROPS,
        HostedZoneId: undefined,
        HostedZoneName: 'example.com',
      });

      expect(result.physicalId).toBe('ZPUBLIC000000000000|record.example.com.|A');
    });
  });

  describe('readCurrentState()', () => {
    it("reports drift for a record whose state carries CloudFormation's scalar id", async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.readCurrentState(
        'record.example.com',
        'WebsiteRecord',
        'AWS::Route53::RecordSet',
        RECORD_PROPS
      );

      expect(result).toMatchObject({
        HostedZoneId: 'Z0123456789ABCDEFGHIJ',
        Name: 'record.example.com.',
        Type: 'A',
        TTL: 300,
        ResourceRecords: ['1.2.3.4'],
      });
    });

    it('reads back a composite-id record without consulting properties', async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|record.example.com.|A',
        'WebsiteRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toMatchObject({ Name: 'record.example.com.', Type: 'A' });
    });

    it('matches a composite whose Name lacks the trailing dot AWS reports', async () => {
      mockSend.mockResolvedValueOnce(AWS_RECORD);

      const result = await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|record.example.com|A',
        'WebsiteRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toMatchObject({ Type: 'A', TTL: 300 });
    });

    it('reads back a WILDCARD record AWS reports octal-escaped (#1658)', async () => {
      // Deleting the octal decode leaves every wildcard record reporting
      // "drift unknown" — silently, because `undefined` is not an error.
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [
          { Name: '\\052.example.com.', Type: 'A', TTL: 300, ResourceRecords: [{ Value: '1.2.3.4' }] },
        ],
      });

      const result = await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|*.example.com.|A',
        'WildcardRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toMatchObject({ Name: '*.example.com.', Type: 'A', TTL: 300 });
    });

    it('does NOT ask for a single record (AWS orders on the ESCAPED form)', async () => {
      // With MaxItems: 1 the page can skip past `\\052…` entirely, so the
      // compare-side decode alone would not fix wildcards.
      mockSend.mockResolvedValueOnce({ ResourceRecordSets: [] });

      await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|*.example.com.|A',
        'WildcardRecord',
        'AWS::Route53::RecordSet'
      );

      expect(mockSend.mock.calls[0]?.[0].input.MaxItems).toBeGreaterThan(1);
    });

    it('does NOT collapse an escaped period into a label separator', async () => {
      // `a\\056b.example.com.` is the SINGLE-label record `a.b`; decoding it
      // would make it equal the different two-label `a.b.example.com`.
      // A false match here targets the wrong record.
      mockSend.mockResolvedValueOnce({
        ResourceRecordSets: [{ Name: 'a\\056b.example.com.', Type: 'A', TTL: 60 }],
      });

      const result = await provider.readCurrentState(
        'Z0123456789ABCDEFGHIJ|a.b.example.com.|A',
        'AmbiguousRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toBeUndefined();
    });

    it('returns undefined when the id is unparsable and no properties are available', async () => {
      const result = await provider.readCurrentState(
        'record.example.com',
        'WebsiteRecord',
        'AWS::Route53::RecordSet'
      );

      expect(result).toBeUndefined();
      expect(mockSend).not.toHaveBeenCalled();
    });
  });
});
