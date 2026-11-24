import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { ChangeResourceRecordSetsCommand } from '@aws-sdk/client-route-53';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual<typeof import('@aws-sdk/client-route-53')>(
    '@aws-sdk/client-route-53'
  );
  return {
    ...actual,
    Route53Client: vi.fn(() => ({
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
    child: vi.fn(function (this: unknown) { return this; }),
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
import { PROPERTY_COVERAGE_BY_TYPE } from '../../../src/provisioning/property-coverage.generated.js';

const TYPE = 'AWS::Route53::RecordSet';
const ZONE = 'Z1234567890';
const NAME = 'aza.example.com.';
const PHYSICAL_ID = `${ZONE}|${NAME}|A`;

function record(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    HostedZoneId: ZONE,
    Name: NAME,
    Type: 'A',
    TTL: '60',
    ResourceRecords: ['192.0.2.1'],
    SetIdentifier: 'aza-use1-az1',
    ...extra,
  };
}

/** The ResourceRecordSet of the `index`-th ChangeResourceRecordSets call's first change. */
function sentRecordSet(index = 0): Record<string, unknown> {
  const calls = mockSend.mock.calls
    .map((c) => c[0])
    .filter((cmd): cmd is ChangeResourceRecordSetsCommand => cmd instanceof ChangeResourceRecordSetsCommand);
  const change = calls[index]?.input.ChangeBatch?.Changes?.[0];
  expect(change, `ChangeResourceRecordSets call #${index} was not sent`).toBeDefined();
  return change!.ResourceRecordSet as unknown as Record<string, unknown>;
}

describe('AWS::Route53::RecordSet AZAffinity on the SDK route (#6719)', () => {
  let provider: Route53Provider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = new Route53Provider();
  });

  it('is handled, so the resource stays on the SDK route', () => {
    const coverage = PROPERTY_COVERAGE_BY_TYPE.get(TYPE);
    expect(coverage?.handled.has('AZAffinity')).toBe(true);
    expect(coverage?.sdkUnwired.has('AZAffinity')).toBe(false);
  });

  it('create sends LocationType + LocationId with the SetIdentifier', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.create(
      'AzaRecord',
      TYPE,
      record({ AZAffinity: { LocationType: 'AvailabilityZone', LocationId: 'use1-az1' } })
    );

    const sent = sentRecordSet();
    expect(sent['SetIdentifier']).toBe('aza-use1-az1');
    expect(sent['AZAffinity']).toEqual({ LocationType: 'AvailabilityZone', LocationId: 'use1-az1' });
  });

  it.each(['AvailabilityZoneGroup', 'Region', 'Partition', 'Global'])(
    'create forwards LocationType %s unchanged',
    async (locationType) => {
      mockSend.mockResolvedValueOnce({});

      await provider.create(
        'AzaRecord',
        TYPE,
        record({ AZAffinity: { LocationType: locationType, LocationId: 'loc-1' } })
      );

      expect(sentRecordSet()['AZAffinity']).toEqual({
        LocationType: locationType,
        LocationId: 'loc-1',
      });
    }
  );

  it('create omits AZAffinity when the template has none', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.create('PlainRecord', TYPE, record({}));

    expect(sentRecordSet()).not.toHaveProperty('AZAffinity');
  });

  it('update UPSERTs the desired AZAffinity', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AzaRecord',
      PHYSICAL_ID,
      TYPE,
      record({ AZAffinity: { LocationType: 'Region', LocationId: 'us-east-1' } }),
      record({ AZAffinity: { LocationType: 'AvailabilityZone', LocationId: 'use1-az1' } })
    );

    const calls = mockSend.mock.calls.map((c) => c[0]);
    const upsert = calls.find(
      (cmd) =>
        cmd instanceof ChangeResourceRecordSetsCommand &&
        cmd.input.ChangeBatch?.Changes?.some((ch) => ch.Action === 'UPSERT')
    ) as ChangeResourceRecordSetsCommand | undefined;
    expect(upsert).toBeDefined();
    const change = upsert!.input.ChangeBatch!.Changes!.find((ch) => ch.Action === 'UPSERT')!;
    expect(change.ResourceRecordSet?.AZAffinity).toEqual({
      LocationType: 'Region',
      LocationId: 'us-east-1',
    });
  });

  it.each([
    ['a rollback replay', { replayingState: true }],
    ['a drift revert', { desiredFromAwsReadback: true }],
  ])('%s UPSERTs the state-borne AZAffinity', async (_label, context) => {
    mockSend.mockResolvedValueOnce({});

    await provider.update(
      'AzaRecord',
      PHYSICAL_ID,
      TYPE,
      record({ AZAffinity: { LocationType: 'AvailabilityZone', LocationId: 'use1-az1' } }),
      record({ AZAffinity: { LocationType: 'Region', LocationId: 'us-east-1' } }),
      context
    );

    const upsert = mockSend.mock.calls
      .map((c) => c[0])
      .find(
        (cmd) =>
          cmd instanceof ChangeResourceRecordSetsCommand &&
          cmd.input.ChangeBatch?.Changes?.some((ch) => ch.Action === 'UPSERT')
      ) as ChangeResourceRecordSetsCommand | undefined;
    expect(upsert).toBeDefined();
    const change = upsert!.input.ChangeBatch!.Changes!.find((ch) => ch.Action === 'UPSERT')!;
    expect(change.ResourceRecordSet?.AZAffinity).toEqual({
      LocationType: 'AvailabilityZone',
      LocationId: 'use1-az1',
    });
  });

  it('delete addresses the record with its AZAffinity', async () => {
    mockSend.mockResolvedValueOnce({});

    await provider.delete(
      'AzaRecord',
      PHYSICAL_ID,
      TYPE,
      record({ AZAffinity: { LocationType: 'AvailabilityZone', LocationId: 'use1-az1' } })
    );

    const cmd = mockSend.mock.calls[0]![0] as ChangeResourceRecordSetsCommand;
    expect(cmd.input.ChangeBatch?.Changes?.[0]?.Action).toBe('DELETE');
    expect(sentRecordSet()['AZAffinity']).toEqual({
      LocationType: 'AvailabilityZone',
      LocationId: 'use1-az1',
    });
  });

  it('readCurrentState surfaces AZAffinity when Route 53 returns it', async () => {
    mockSend.mockResolvedValueOnce({
      ResourceRecordSets: [
        {
          Name: NAME,
          Type: 'A',
          TTL: 60,
          ResourceRecords: [{ Value: '192.0.2.1' }],
          SetIdentifier: 'aza-use1-az1',
          AZAffinity: { LocationType: 'AvailabilityZone', LocationId: 'use1-az1' },
        },
      ],
    });

    const result = (await provider.readCurrentState(PHYSICAL_ID, 'AzaRecord', TYPE)) as Record<
      string,
      unknown
    >;

    expect(result).toEqual({
      HostedZoneId: ZONE,
      Name: NAME,
      Type: 'A',
      TTL: 60,
      ResourceRecords: ['192.0.2.1'],
      SetIdentifier: 'aza-use1-az1',
      AZAffinity: { LocationType: 'AvailabilityZone', LocationId: 'use1-az1' },
    });
  });

  it('readCurrentState omits AZAffinity when Route 53 does not return it', async () => {
    mockSend.mockResolvedValueOnce({
      ResourceRecordSets: [
        { Name: NAME, Type: 'A', TTL: 60, ResourceRecords: [{ Value: '192.0.2.1' }] },
      ],
    });

    const result = (await provider.readCurrentState(PHYSICAL_ID, 'AzaRecord', TYPE)) as Record<
      string,
      unknown
    >;

    expect(result).not.toHaveProperty('AZAffinity');
  });
});
