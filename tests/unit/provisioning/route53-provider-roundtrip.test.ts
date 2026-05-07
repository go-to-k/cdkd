import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ChangeResourceRecordSetsCommand,
  UpdateHostedZoneCommentCommand,
} from '@aws-sdk/client-route-53';

// Mechanical guard for the 3 latent bug classes (Class 1 / Class 2 /
// truthy gate) that surface only on `cdkd drift --revert` round-trips
// through `provider.update()`. See docs/provider-development.md § 3b
// "Read-update round-trip test" and the canonical SQS / SNS tests.
//
// The shape of the round-trip is:
//   1. Build an `observed` snapshot the same way `readCurrentState`
//      would produce it (we exercise readCurrentState via mocks here so
//      the snapshot is the actual provider output, not a hand-crafted
//      stand-in).
//   2. Pass that snapshot back through `update()` as both `new` and
//      `old` (state == AWS-current).
//   3. Assert no AWS-side mutation rejects on the round-trip:
//      - HostedZone: UpdateHostedZoneComment may fire (it is
//        idempotent) but no AssociateVPCWithHostedZone / Disassociate
//        on a public zone.
//      - RecordSet: ChangeResourceRecordSets must NOT carry both
//        AliasTarget AND ResourceRecords (AWS rejects).

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

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';

describe('Route53Provider read-update round-trip', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  // ─── HostedZone ──────────────────────────────────────────────────

  it('public HostedZone: round-trip does not emit a VPCs placeholder', async () => {
    // Class 1 guard: VPCs is private-zone-only. On a public zone
    // readCurrentState must NOT carry `VPCs: []`, otherwise the
    // observedProperties baseline fires false drift against state
    // (which doesn't have the key on public zones) AND the round-trip
    // would attempt to re-associate VPCs the zone never had.
    mockSend
      .mockResolvedValueOnce({
        HostedZone: {
          Id: '/hostedzone/Z1',
          Name: 'example.com.',
          Config: { Comment: 'public', PrivateZone: false },
        },
        VPCs: [],
      })
      .mockResolvedValueOnce({ ResourceTagSet: { ResourceId: 'Z1', Tags: [] } });

    const observed = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');

    expect(observed).toBeDefined();
    expect(observed).not.toHaveProperty('VPCs');
    expect(observed?.['HostedZoneTags']).toEqual([]);

    // Now round-trip the snapshot through update().
    mockSend.mockReset();
    // update() walks: UpdateHostedZoneComment, ChangeTagsForResource
    // (skipped — empty tag array), CreateQueryLoggingConfig (skipped —
    // no QueryLoggingConfig in snapshot), syncVPCAssociations (early-
    // returns when desiredVpcs is empty/undefined), GetHostedZone for
    // NameServers.
    mockSend
      .mockResolvedValueOnce({}) // UpdateHostedZoneComment
      .mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
        DelegationSet: { NameServers: ['ns-1.example.com'] },
      });

    await provider.update(
      'L',
      'Z1',
      'AWS::Route53::HostedZone',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    // No AssociateVPCWithHostedZone / Disassociate calls on a public
    // zone — the absent-VPCs gate must hold through the round-trip.
    const associateCalls = mockSend.mock.calls.filter((c) => {
      const name = c[0]?.constructor?.name as string | undefined;
      return name === 'AssociateVPCWithHostedZoneCommand' ||
        name === 'DisassociateVPCFromHostedZoneCommand';
    });
    expect(associateCalls).toHaveLength(0);
  });

  it('private HostedZone: round-trip preserves VPCs and triggers no Associate/Disassociate', async () => {
    // Complement of the public-zone test: a private zone legitimately
    // has VPCs and the snapshot must surface them. The round-trip
    // through update()'s syncVPCAssociations must be a logical no-op
    // (state == AWS, so neither add nor remove).
    mockSend
      .mockResolvedValueOnce({
        HostedZone: {
          Id: '/hostedzone/Z2',
          Name: 'internal.example.com.',
          Config: { Comment: 'private', PrivateZone: true },
        },
        VPCs: [
          { VPCId: 'vpc-aaa', VPCRegion: 'us-east-1' },
          { VPCId: 'vpc-bbb', VPCRegion: 'us-west-2' },
        ],
      })
      .mockResolvedValueOnce({ ResourceTagSet: { ResourceId: 'Z2', Tags: [] } });

    const observed = await provider.readCurrentState('Z2', 'L', 'AWS::Route53::HostedZone');

    expect(observed?.['VPCs']).toEqual([
      { VPCId: 'vpc-aaa', VPCRegion: 'us-east-1' },
      { VPCId: 'vpc-bbb', VPCRegion: 'us-west-2' },
    ]);

    // Round-trip through update(): syncVPCAssociations re-fetches
    // current VPCs and diffs against desired.
    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({}) // UpdateHostedZoneComment
      .mockResolvedValueOnce({
        // GetHostedZone inside syncVPCAssociations
        HostedZone: { Id: '/hostedzone/Z2', Name: 'internal.example.com.' },
        VPCs: [
          { VPCId: 'vpc-aaa', VPCRegion: 'us-east-1' },
          { VPCId: 'vpc-bbb', VPCRegion: 'us-west-2' },
        ],
      })
      .mockResolvedValueOnce({
        // GetHostedZone for NameServers
        HostedZone: { Id: '/hostedzone/Z2', Name: 'internal.example.com.' },
        DelegationSet: { NameServers: ['ns-3.example.com'] },
      });

    await provider.update(
      'L',
      'Z2',
      'AWS::Route53::HostedZone',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const associateCalls = mockSend.mock.calls.filter((c) => {
      const name = c[0]?.constructor?.name as string | undefined;
      return name === 'AssociateVPCWithHostedZoneCommand' ||
        name === 'DisassociateVPCFromHostedZoneCommand';
    });
    expect(associateCalls).toHaveLength(0);
  });

  // ─── RecordSet ───────────────────────────────────────────────────

  it('A-record (TTL + ResourceRecords): round-trip ChangeResourceRecordSets has TTL/ResourceRecords and no AliasTarget', async () => {
    mockSend.mockResolvedValueOnce({
      ResourceRecordSets: [
        {
          Name: 'a.example.com.',
          Type: 'A',
          TTL: 300,
          ResourceRecords: [{ Value: '1.2.3.4' }, { Value: '5.6.7.8' }],
        },
      ],
    });

    const observed = await provider.readCurrentState(
      'Z1|a.example.com.|A',
      'L',
      'AWS::Route53::RecordSet'
    );
    expect(observed).toEqual({
      HostedZoneId: 'Z1',
      Name: 'a.example.com.',
      Type: 'A',
      TTL: 300,
      ResourceRecords: ['1.2.3.4', '5.6.7.8'],
    });

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({}); // ChangeResourceRecordSets

    await provider.update(
      'L',
      'Z1|a.example.com.|A',
      'AWS::Route53::RecordSet',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const changeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ChangeResourceRecordSetsCommand
    );
    expect(changeCalls).toHaveLength(1);

    const input = (
      changeCalls[0]![0] as ChangeResourceRecordSetsCommand
    ).input as {
      ChangeBatch: { Changes: Array<{ Action: string; ResourceRecordSet: any }> };
    };
    const rrs = input.ChangeBatch.Changes[0]!.ResourceRecordSet;
    expect(rrs.Name).toBe('a.example.com.');
    expect(rrs.Type).toBe('A');
    expect(rrs.TTL).toBe(300);
    expect(rrs.ResourceRecords).toEqual([
      { Value: '1.2.3.4' },
      { Value: '5.6.7.8' },
    ]);
    // Critically: AliasTarget must be absent for a standard record.
    expect(rrs.AliasTarget).toBeUndefined();
  });

  it('alias record: round-trip ChangeResourceRecordSets has AliasTarget and NEITHER TTL NOR ResourceRecords', async () => {
    // Class 1 guard: TTL / ResourceRecords are mutually exclusive with
    // AliasTarget per AWS. If readCurrentState carried `[]` /
    // placeholder TTL on an alias record, the round-trip update would
    // reject with `InvalidChangeBatch: Tried to create an alias that
    // targets ... but the alias is not allowed to have a TTL / RRs`.
    mockSend.mockResolvedValueOnce({
      ResourceRecordSets: [
        {
          Name: 'alias.example.com.',
          Type: 'A',
          AliasTarget: {
            HostedZoneId: 'Z2',
            DNSName: 'lb-1.us-east-1.elb.amazonaws.com.',
            EvaluateTargetHealth: false,
          },
        },
      ],
    });

    const observed = await provider.readCurrentState(
      'Z1|alias.example.com.|A',
      'L',
      'AWS::Route53::RecordSet'
    );
    expect(observed).toEqual({
      HostedZoneId: 'Z1',
      Name: 'alias.example.com.',
      Type: 'A',
      AliasTarget: {
        HostedZoneId: 'Z2',
        DNSName: 'lb-1.us-east-1.elb.amazonaws.com.',
        EvaluateTargetHealth: false,
      },
    });
    // Class 1: alias snapshot does NOT carry TTL / ResourceRecords.
    expect(observed).not.toHaveProperty('TTL');
    expect(observed).not.toHaveProperty('ResourceRecords');

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({}); // ChangeResourceRecordSets

    await provider.update(
      'L',
      'Z1|alias.example.com.|A',
      'AWS::Route53::RecordSet',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const changeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ChangeResourceRecordSetsCommand
    );
    expect(changeCalls).toHaveLength(1);

    const input = (
      changeCalls[0]![0] as ChangeResourceRecordSetsCommand
    ).input as {
      ChangeBatch: { Changes: Array<{ Action: string; ResourceRecordSet: any }> };
    };
    const rrs = input.ChangeBatch.Changes[0]!.ResourceRecordSet;
    expect(rrs.AliasTarget).toEqual({
      HostedZoneId: 'Z2',
      DNSName: 'lb-1.us-east-1.elb.amazonaws.com.',
      EvaluateTargetHealth: false,
    });
    // Critically: TTL and ResourceRecords must be absent — AWS rejects
    // alias records that carry either field.
    expect(rrs.TTL).toBeUndefined();
    expect(rrs.ResourceRecords).toBeUndefined();
  });

  it('round-trip on a no-drift snapshot makes only the idempotent UPSERT-shape calls', async () => {
    // Stronger structural assertion: on state == AWS, round-trip
    // should make at most one UPSERT (or zero if the provider becomes
    // diff-based). It must NEVER make a CREATE or DELETE — those are
    // the failure modes the placeholder-driven false drift would
    // produce.
    mockSend.mockResolvedValueOnce({
      ResourceRecordSets: [
        {
          Name: 'a.example.com.',
          Type: 'A',
          TTL: 300,
          ResourceRecords: [{ Value: '1.2.3.4' }],
        },
      ],
    });

    const observed = await provider.readCurrentState(
      'Z1|a.example.com.|A',
      'L',
      'AWS::Route53::RecordSet'
    );

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'L',
      'Z1|a.example.com.|A',
      'AWS::Route53::RecordSet',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const changeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ChangeResourceRecordSetsCommand
    );
    for (const call of changeCalls) {
      const input = (call[0] as ChangeResourceRecordSetsCommand).input as {
        ChangeBatch: { Changes: Array<{ Action: string }> };
      };
      for (const change of input.ChangeBatch.Changes) {
        // CREATE/DELETE on a no-drift round-trip is the bug we're
        // guarding against.
        expect(change.Action).toBe('UPSERT');
      }
    }
  });

  it('weighted record (Weight=0): round-trip preserves the falsy weight (truthy-gate guard)', async () => {
    // Truthy-gate guard: `if (weight)` would silently drop a weighted
    // record with Weight=0 (a valid AWS configuration meaning "this
    // record is never returned"). The fix is `!== undefined`.
    mockSend.mockResolvedValueOnce({
      ResourceRecordSets: [
        {
          Name: 'w.example.com.',
          Type: 'A',
          TTL: 60,
          ResourceRecords: [{ Value: '10.0.0.1' }],
          SetIdentifier: 'primary',
          Weight: 0,
        },
      ],
    });

    const observed = await provider.readCurrentState(
      'Z1|w.example.com.|A',
      'L',
      'AWS::Route53::RecordSet'
    );
    expect(observed?.['Weight']).toBe(0);
    expect(observed?.['SetIdentifier']).toBe('primary');

    mockSend.mockReset();
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'L',
      'Z1|w.example.com.|A',
      'AWS::Route53::RecordSet',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const changeCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof ChangeResourceRecordSetsCommand
    );
    expect(changeCalls).toHaveLength(1);
    const input = (
      changeCalls[0]![0] as ChangeResourceRecordSetsCommand
    ).input as {
      ChangeBatch: { Changes: Array<{ ResourceRecordSet: any }> };
    };
    const rrs = input.ChangeBatch.Changes[0]!.ResourceRecordSet;
    // Weight=0 must survive the round-trip — silently dropping it
    // would change the routing behavior on `cdkd drift --revert`.
    expect(rrs.Weight).toBe(0);
    expect(rrs.SetIdentifier).toBe('primary');
  });

  // Sanity check that the HostedZone path still issues the comment
  // update (the only mutating call we expect on a no-drift round-trip
  // for HostedZone — it is idempotent).
  it('public HostedZone round-trip issues UpdateHostedZoneComment exactly once', async () => {
    mockSend
      .mockResolvedValueOnce({
        HostedZone: {
          Id: '/hostedzone/Z1',
          Name: 'example.com.',
          Config: { Comment: 'public', PrivateZone: false },
        },
        VPCs: [],
      })
      .mockResolvedValueOnce({ ResourceTagSet: { ResourceId: 'Z1', Tags: [] } });

    const observed = await provider.readCurrentState('Z1', 'L', 'AWS::Route53::HostedZone');

    mockSend.mockReset();
    mockSend
      .mockResolvedValueOnce({}) // UpdateHostedZoneComment
      .mockResolvedValueOnce({
        HostedZone: { Id: '/hostedzone/Z1', Name: 'example.com.' },
        DelegationSet: { NameServers: ['ns-1.example.com'] },
      });

    await provider.update(
      'L',
      'Z1',
      'AWS::Route53::HostedZone',
      observed as Record<string, unknown>,
      observed as Record<string, unknown>
    );

    const commentCalls = mockSend.mock.calls.filter(
      (c) => c[0] instanceof UpdateHostedZoneCommentCommand
    );
    expect(commentCalls).toHaveLength(1);
  });
});
