/**
 * go-to-k/cdkd#7015: a pre-#7006 RDS DB instance record kept the port, CA or
 * Multi-AZ zone read right after an in-place modify (the OLD value). A
 * `Fn::GetAtt` of such a member re-reads the record once, detected from the
 * record alone (its properties contradict it), and the persist merge either
 * reconciles it or stamps it so the next deploy does not read again.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { StaleAttributeHealOutcome } from '../../../src/deployment/stale-attribute-heal.js';
import { AttributeHealer } from '../../../src/deployment/deploy-engine/attribute-healer.js';
import { createReadOnlyAttributeHealerFactory } from '../../../src/deployment/read-only-attribute-healer.js';
import {
  needsStaleShapeRead,
  staleShapeAttributeNames,
  staleShapeFingerprint,
} from '../../../src/deployment/intrinsic-resolver/getatt-stale-shape.js';
import type { ResourceState } from '../../../src/types/state.js';
import {
  recordResolvedPair,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => fns };
  return { getLogger: () => fns };
});
vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: {
      send: vi.fn().mockResolvedValue({
        Account: '123456789012',
        Arn: 'arn:aws:iam::123456789012:user/test',
      }),
    },
  }),
}));

const RDS = 'AWS::RDS::DBInstance';

/** A settled instance's recorded attributes (CloudFormation's shapes: strings). */
const ATTRS = {
  'Endpoint.Address': 'mydb.x.us-east-1.rds.amazonaws.com',
  'Endpoint.Port': '5432',
  'Endpoint.HostedZoneId': 'Z2R2ITUGPM61AM',
  'CertificateDetails.CAIdentifier': 'rds-ca-rsa2048-g1',
  'CertificateDetails.ValidTill': '2027-11-14T07:51:43Z',
  Arn: 'arn:aws:rds:us-east-1:123456789012:db:mydb',
};

function record(
  properties: Record<string, unknown>,
  attributes: Record<string, unknown> = ATTRS,
  extra: Partial<ResourceState> = {},
  resourceType = RDS
): ResourceState {
  return {
    physicalId: 'mydb',
    resourceType,
    properties,
    attributes,
    dependencies: [],
    provisionedBy: 'sdk',
    ...extra,
  } as ResourceState;
}

const resolveAttr = (
  resource: ResourceState,
  attribute: string,
  healer?: ResolverContext['attributeHealer']
): Promise<unknown> =>
  new IntrinsicFunctionResolver('us-east-1').resolve(
    { 'Fn::GetAtt': ['Db', attribute] },
    {
      template: { Resources: { Db: { Type: resource.resourceType, Properties: {} } } },
      resources: { Db: resource },
      ...(healer && { attributeHealer: healer }),
    }
  );

const healerReading = (attributes: Record<string, unknown>) =>
  vi.fn(async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'read', attributes }));

/** A deploy's healer over `baseline`, its provider's read answering `live`. */
function deployHealer(
  baseline: ResourceState,
  live: Record<string, unknown>,
  secrets?: RecordedSecretValues,
  pendingAttributeKeys?: string[]
) {
  const provider = {
    import: vi.fn(async () => ({
      physicalId: 'mydb',
      attributes: live,
      ...(pendingAttributeKeys && { pendingAttributeKeys }),
    })),
  };
  const healer = new AttributeHealer({
    providerRegistry: { getProviderFor: () => ({ provider, provisionedBy: 'sdk' }) } as never,
    baseline: { Db: baseline },
    stackRegion: 'us-east-1',
    logger: { debug: () => undefined },
    resolvedSecretsOf: () => secrets,
    namingSecrets: () => ({}) as never,
  });
  const asResolverHealer = (logicalId: string, resource: ResourceState) =>
    healer.heal(logicalId, resource, 'App');
  return { healer, provider, asResolverHealer };
}

describe('stale-shape predicates (#7015)', () => {
  it('a recorded port the Port property contradicts makes the endpoint stale', () => {
    expect([...staleShapeAttributeNames(record({ Port: '5433' }))]).toEqual([
      'Endpoint.Port',
      'Endpoint',
      'ListenerEndpoint.Port',
      'ListenerEndpoint',
    ]);
    // A numeric template port compares as its text.
    expect(staleShapeAttributeNames(record({ Port: 5432 })).size).toBe(0);
    expect(staleShapeAttributeNames(record({ Port: 5433 })).has('Endpoint.Port')).toBe(true);
  });

  it('an Aurora member instance (DBClusterIdentifier) never fires on Port or MultiAZ', () => {
    const member = record(
      { Port: '3306', DBClusterIdentifier: 'mycluster' },
      { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' }
    );
    expect(staleShapeAttributeNames(member).size).toBe(0);
  });

  it('CACertificateIdentifier vs CertificateDetails.CAIdentifier, case-insensitively', () => {
    expect(
      staleShapeAttributeNames(record({ CACertificateIdentifier: 'rds-ca-ecc384-g1' }))
    ).toEqual(
      new Set(['CertificateDetails.CAIdentifier', 'CertificateDetails.ValidTill', 'CertificateDetails'])
    );
    expect(
      staleShapeAttributeNames(record({ CACertificateIdentifier: 'RDS-CA-RSA2048-G1' })).size
    ).toBe(0);
  });

  it('Multi-AZ off (false or absent) while a secondary zone is recorded; on without one is a miss', () => {
    const withZone = { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' };
    expect(staleShapeAttributeNames(record({ MultiAZ: false }, withZone))).toEqual(
      new Set(['SecondaryAvailabilityZone'])
    );
    expect(staleShapeAttributeNames(record({ MultiAZ: 'false' }, withZone)).size).toBe(1);
    expect(staleShapeAttributeNames(record({}, withZone)).size).toBe(1);
    expect(staleShapeAttributeNames(record({ MultiAZ: true }, withZone)).size).toBe(0);
    expect(staleShapeAttributeNames(record({ MultiAZ: true })).size).toBe(0);
  });

  it('a Neptune cluster has no check: its DBPort is reported by the first read (#7006)', () => {
    const cluster = record(
      { DBPort: 8183 },
      { Port: '8182', 'Endpoint.Port': '8182' },
      {},
      'AWS::Neptune::DBCluster'
    );
    expect(staleShapeAttributeNames(cluster).size).toBe(0);
  });

  it('an ordinary record, a masked input, or another type never fires', () => {
    expect(staleShapeAttributeNames(record({ Port: '5432', MultiAZ: true })).size).toBe(0);
    expect(staleShapeAttributeNames(record({ Port: '***' })).size).toBe(0);
    expect(staleShapeAttributeNames(record({ Port: '5433' }, ATTRS, {}, 'AWS::RDS::DBCluster')).size).toBe(0);
    expect(staleShapeFingerprint(record({ Port: '5433' }, ATTRS, {}, 'AWS::RDS::DBCluster'))).toBe(
      undefined
    );
  });

  it('a stamp equal to the current inputs turns the check off; a changed input re-arms it', () => {
    const stale = record({ Port: '5433' });
    const stamped = { ...stale, attributesReadAfterApply: staleShapeFingerprint(stale) };
    expect(needsStaleShapeRead(stamped, 'Endpoint.Port')).toBe(false);
    // An in-place update to another port (the record a later writer carries
    // the stamp onto) no longer matches it.
    expect(needsStaleShapeRead({ ...stamped, properties: { Port: '5434' } }, 'Endpoint.Port')).toBe(
      true
    );
    // Only the contradicted attributes ask.
    expect(needsStaleShapeRead(stale, 'Endpoint.Address')).toBe(false);
  });
});

describe('Fn::GetAtt of a stale-shape record (#7015)', () => {
  beforeEach(() => resetAccountInfoCache());

  it('re-reads and serves what AWS reports, member and whole object', async () => {
    const stale = record({ Port: '5433' });
    const healer = healerReading({ ...ATTRS, 'Endpoint.Port': '5433' });
    await expect(resolveAttr(stale, 'Endpoint.Port', healer)).resolves.toBe('5433');
    await expect(resolveAttr(stale, 'Endpoint', healer)).resolves.toEqual({
      Address: 'mydb.x.us-east-1.rds.amazonaws.com',
      HostedZoneId: 'Z2R2ITUGPM61AM',
      Port: '5433',
    });
    expect(healer).toHaveBeenCalled();
  });

  it('an ordinary record never triggers a read', async () => {
    const healer = healerReading({});
    const ordinary = record({ Port: '5432', CACertificateIdentifier: 'rds-ca-rsa2048-g1' });
    await expect(resolveAttr(ordinary, 'Endpoint.Port', healer)).resolves.toBe('5432');
    await expect(resolveAttr(ordinary, 'CertificateDetails.CAIdentifier', healer)).resolves.toBe(
      'rds-ca-rsa2048-g1'
    );
    // A stale record's UNcontradicted attribute does not read either.
    await expect(resolveAttr(record({ Port: '5433' }), 'Endpoint.Address', healer)).resolves.toBe(
      'mydb.x.us-east-1.rds.amazonaws.com'
    );
    expect(healer).not.toHaveBeenCalled();
  });

  it('a read that fails serves the recorded value, as before', async () => {
    const healer = vi.fn(
      async (): Promise<StaleAttributeHealOutcome> => ({ kind: 'failed', error: new Error('denied') })
    );
    await expect(resolveAttr(record({ Port: '5433' }), 'Endpoint.Port', healer)).resolves.toBe(
      '5432'
    );
    expect(healer).toHaveBeenCalledTimes(1);
  });

  it('a completed read naming no secondary zone does not serve the stale one', async () => {
    const stale = record({ MultiAZ: false }, { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' });
    const healer = healerReading({ ...ATTRS });
    const value = await resolveAttr(stale, 'SecondaryAvailabilityZone', healer).catch(
      (error: unknown) => error
    );
    expect(value).not.toBe('us-east-1b');
  });
});

describe('the bound: one re-read per record shape (#7015)', () => {
  beforeEach(() => resetAccountInfoCache());

  it('AWS still reporting the old port: the save stamps it and the next deploy reads nothing', async () => {
    const stale = record({ Port: '5433' });
    const first = deployHealer(stale, { ...ATTRS });
    await expect(resolveAttr(stale, 'Endpoint.Port', first.asResolverHealer)).resolves.toBe('5432');
    expect(first.provider.import).toHaveBeenCalledTimes(1);
    expect(first.healer.hasUnpersistedHeals({ Db: stale })).toBe(true);
    const saved = first.healer.withHealedAttributes('Db', stale);
    expect(saved.attributesReadAfterApply).toBe(staleShapeFingerprint(stale));
    expect(saved.attributes).toEqual(ATTRS);

    // The next deploy loads the saved record.
    const second = deployHealer(saved, { ...ATTRS });
    await expect(resolveAttr(saved, 'Endpoint.Port', second.asResolverHealer)).resolves.toBe(
      '5432'
    );
    await expect(resolveAttr(saved, 'Endpoint', second.asResolverHealer)).resolves.toMatchObject({
      Port: '5432',
    });
    expect(second.provider.import).not.toHaveBeenCalled();
  });

  it('a read that reconciles the record replaces the stale member and needs no stamp', async () => {
    const stale = record({ Port: '5433' }, { ...ATTRS, 'ListenerEndpoint.Port': '5432' });
    const first = deployHealer(stale, { ...ATTRS, 'Endpoint.Port': '5433' });
    await resolveAttr(stale, 'Endpoint.Port', first.asResolverHealer);
    const saved = first.healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['Endpoint.Port']).toBe('5433');
    // Not reported by the read: absence proves nothing for a port, so kept.
    expect(saved.attributes?.['ListenerEndpoint.Port']).toBe('5432');
    expect(saved.attributesReadAfterApply).toBeUndefined();
    // Members the check does not cover stay add-only.
    expect(saved.attributes?.['Arn']).toBe(ATTRS.Arn);

    const second = deployHealer(saved, {});
    await expect(resolveAttr(saved, 'Endpoint.Port', second.asResolverHealer)).resolves.toBe(
      '5433'
    );
    expect(second.provider.import).not.toHaveBeenCalled();
  });

  it('a Multi-AZ-off record drops the secondary zone the read no longer reports', async () => {
    const stale = record({ MultiAZ: false }, { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' });
    const { healer, asResolverHealer } = deployHealer(stale, { ...ATTRS });
    await resolveAttr(stale, 'SecondaryAvailabilityZone', asResolverHealer).catch(() => undefined);
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes).not.toHaveProperty('SecondaryAvailabilityZone');
    expect(staleShapeAttributeNames(saved).size).toBe(0);
  });

  /** The next deploy over `saved`: a reader of `attribute` must not re-read it. */
  const expectNoReadNextDeploy = async (saved: ResourceState, attribute: string) => {
    const next = deployHealer(saved, { ...ATTRS });
    await resolveAttr(saved, attribute, next.asResolverHealer).catch(() => undefined);
    expect(next.provider.import).not.toHaveBeenCalled();
  };

  it('a member the read withheld as masked is kept and served, stamped, and not read again', async () => {
    const stale = record({ Port: '5433' });
    const { healer, asResolverHealer } = deployHealer(stale, { ...ATTRS, 'Endpoint.Port': '***' });
    await expect(resolveAttr(stale, 'Endpoint.Port', asResolverHealer)).resolves.toBe('5432');
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['Endpoint.Port']).toBe('5432');
    expect(saved.attributesReadAfterApply).toBe(staleShapeFingerprint(saved));
    await expectNoReadNextDeploy(saved, 'Endpoint.Port');
  });

  it('a secondary zone the read withheld as masked is no proof of absence, and is bounded', async () => {
    const stale = record({ MultiAZ: false }, { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' });
    const { healer, asResolverHealer } = deployHealer(stale, {
      ...ATTRS,
      SecondaryAvailabilityZone: '***',
    });
    await expect(resolveAttr(stale, 'SecondaryAvailabilityZone', asResolverHealer)).resolves.toBe(
      'us-east-1b'
    );
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['SecondaryAvailabilityZone']).toBe('us-east-1b');
    expect(saved).toHaveProperty('attributesReadAfterApply');
    await expectNoReadNextDeploy(saved, 'SecondaryAvailabilityZone');
  });

  it('a read reporting no endpoint (mid-rename) keeps the recorded port, stamped, read once', async () => {
    const stale = record({ Port: '5433' });
    const { 'Endpoint.Port': _port, ...withoutPort } = ATTRS;
    const { healer, asResolverHealer } = deployHealer(stale, withoutPort);
    await expect(resolveAttr(stale, 'Endpoint.Port', asResolverHealer)).resolves.toBe('5432');
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['Endpoint.Port']).toBe('5432');
    expect(saved).toHaveProperty('attributesReadAfterApply');
    await expectNoReadNextDeploy(saved, 'Endpoint.Port');
  });

  it('a recorded listener port the live instance no longer reports is read once, then never', async () => {
    // AWS genuinely reports 5432 against the declared 5433, and the instance
    // has no listener endpoint any more.
    const stale = record({ Port: '5433' }, { ...ATTRS, 'ListenerEndpoint.Port': '5432' });
    const { healer, provider, asResolverHealer } = deployHealer(stale, { ...ATTRS });
    await resolveAttr(stale, 'ListenerEndpoint.Port', asResolverHealer);
    expect(provider.import).toHaveBeenCalledTimes(1);
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['ListenerEndpoint.Port']).toBe('5432');
    expect(saved).toHaveProperty('attributesReadAfterApply');
    await expectNoReadNextDeploy(saved, 'ListenerEndpoint.Port');
    await expectNoReadNextDeploy(saved, 'Endpoint.Port');
  });

  it('a recorded {{resolve:...}} expression on either side never reads, serves or stamps', async () => {
    const stale = record(
      { Port: '{{resolve:secretsmanager:s:SecretString:port}}' },
      { ...ATTRS, 'Endpoint.Port': '{{resolve:ssm-secure:/db/port}}' }
    );
    expect(staleShapeAttributeNames(stale).size).toBe(0);
    expect(staleShapeFingerprint(stale)).toBeUndefined();
    const { healer, provider } = deployHealer(stale, { ...ATTRS });
    await healer.heal('Db', stale, 'App');
    expect(provider.import).toHaveBeenCalledTimes(1);
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['Endpoint.Port']).toBe('{{resolve:ssm-secure:/db/port}}');
    expect(saved).not.toHaveProperty('attributesReadAfterApply');
  });

  it('never stamps a hash over an input the run secrets would mask', async () => {
    const stale = record({ CACertificateIdentifier: 'rds-ca-ecc384-g1' });
    const secrets: RecordedSecretValues = new Map();
    secrets.set('rds-ca-rsa2048-g1', '{{resolve:secretsmanager:ca}}');
    recordResolvedPair(secrets, '{{resolve:secretsmanager:ca}}', 'rds-ca-rsa2048-g1');
    const { healer, asResolverHealer } = deployHealer(stale, { ...ATTRS }, secrets);
    await resolveAttr(stale, 'CertificateDetails.CAIdentifier', asResolverHealer);
    expect(healer.withHealedAttributes('Db', stale)).not.toHaveProperty('attributesReadAfterApply');
    // The same read with no such secret stamps.
    const plain = deployHealer(stale, { ...ATTRS });
    await resolveAttr(stale, 'CertificateDetails.CAIdentifier', plain.asResolverHealer);
    expect(plain.healer.withHealedAttributes('Db', stale)).toHaveProperty('attributesReadAfterApply');
  });

  it('a stamped record is not re-read, and keeps its members add-only, on a miss heal', async () => {
    const stale = record({ Port: '5433' });
    const stamped = { ...stale, attributesReadAfterApply: staleShapeFingerprint(stale) };
    const { healer } = deployHealer(stamped, { ...ATTRS, 'Endpoint.Port': '5433' });
    await healer.heal('Db', stamped, 'App');
    expect(healer.withHealedAttributes('Db', stamped).attributes?.['Endpoint.Port']).toBe('5432');
  });
});

describe('a modification AWS still lists as pending (#7015)', () => {
  beforeEach(() => resetAccountInfoCache());

  it('serves the live port, neither replaces nor stamps it, and re-reads next deploy', async () => {
    const stale = record({ Port: '5433' });
    const pending = ['Endpoint.Port', 'ListenerEndpoint.Port'];
    // The port change has not been applied: AWS still reports 5432.
    const first = deployHealer(stale, { ...ATTRS, 'Endpoint.Port': '5432' }, undefined, pending);
    await expect(resolveAttr(stale, 'Endpoint.Port', first.asResolverHealer)).resolves.toBe('5432');
    const saved = first.healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['Endpoint.Port']).toBe('5432');
    expect(saved).not.toHaveProperty('attributesReadAfterApply');

    // Applied by the next deploy: the record is still unstamped, so it reads.
    const second = deployHealer(saved, { ...ATTRS, 'Endpoint.Port': '5433' });
    await expect(resolveAttr(saved, 'Endpoint.Port', second.asResolverHealer)).resolves.toBe(
      '5433'
    );
    expect(second.provider.import).toHaveBeenCalledTimes(1);
  });

  it('a pending value is never replaced over, nor added to, the record', async () => {
    const stale = record({ Port: '5433' });
    const { healer, asResolverHealer } = deployHealer(
      stale,
      { ...ATTRS, 'Endpoint.Port': '5434', 'ListenerEndpoint.Port': '5434' },
      undefined,
      ['Endpoint.Port', 'ListenerEndpoint.Port']
    );
    await expect(resolveAttr(stale, 'Endpoint.Port', asResolverHealer)).resolves.toBe('5434');
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['Endpoint.Port']).toBe('5432');
    expect(saved.attributes).not.toHaveProperty('ListenerEndpoint.Port');
    expect(saved).not.toHaveProperty('attributesReadAfterApply');
  });

  it('a pending Multi-AZ-off keeps serving the live secondary zone, and keeps it recorded', async () => {
    const stale = record({ MultiAZ: false }, { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' });
    const { healer, asResolverHealer } = deployHealer(
      stale,
      { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' },
      undefined,
      ['SecondaryAvailabilityZone']
    );
    await expect(resolveAttr(stale, 'SecondaryAvailabilityZone', asResolverHealer)).resolves.toBe(
      'us-east-1b'
    );
    const saved = healer.withHealedAttributes('Db', stale);
    expect(saved.attributes?.['SecondaryAvailabilityZone']).toBe('us-east-1b');
    expect(saved).not.toHaveProperty('attributesReadAfterApply');
  });

  it('a read after the --no-wait readiness wait records no pending key either (#6940 branch)', async () => {
    const created = record({ Port: '5433' }, { Arn: ATTRS.Arn });
    // Empty baseline: the record was written by this deploy.
    const { healer } = deployHealer(
      { ...created, physicalId: 'other' },
      { ...ATTRS, 'Endpoint.Port': '5432' },
      undefined,
      ['Endpoint.Port', 'ListenerEndpoint.Port']
    );
    await healer.readAfterReadiness('Db', created, 'App');
    const saved = healer.withHealedAttributes('Db', created);
    expect(saved.attributes?.['Endpoint.Address']).toBe(ATTRS['Endpoint.Address']);
    expect(saved.attributes).not.toHaveProperty('Endpoint.Port');
  });

  it('a pending key the read no longer reports is no proof of absence either', async () => {
    const stale = record({ MultiAZ: false }, { ...ATTRS, SecondaryAvailabilityZone: 'us-east-1b' });
    const { healer, asResolverHealer } = deployHealer(stale, { ...ATTRS }, undefined, [
      'SecondaryAvailabilityZone',
    ]);
    await expect(resolveAttr(stale, 'SecondaryAvailabilityZone', asResolverHealer)).resolves.toBe(
      'us-east-1b'
    );
    expect(healer.withHealedAttributes('Db', stale).attributes?.['SecondaryAvailabilityZone']).toBe(
      'us-east-1b'
    );
  });
});

describe('cdkd diff heals without persisting (#7015)', () => {
  beforeEach(() => resetAccountInfoCache());

  it('serves the read and leaves the record exactly as loaded', async () => {
    const stale = record({ Port: '5433' });
    const snapshot = structuredClone(stale);
    const provider = {
      import: vi.fn(async () => ({
        physicalId: 'mydb',
        attributes: { ...ATTRS, 'Endpoint.Port': '5433' },
      })),
    };
    const factory = createReadOnlyAttributeHealerFactory({
      getProvider: () => provider as never,
      inRegion: (_region, fn) => fn(),
    });
    await expect(resolveAttr(stale, 'Endpoint.Port', factory('App', 'us-east-1'))).resolves.toBe(
      '5433'
    );
    expect(provider.import).toHaveBeenCalledTimes(1);
    expect(stale).toEqual(snapshot);
    expect(stale).not.toHaveProperty('attributesReadAfterApply');
  });

  it('serves a pending live value and leaves the record exactly as loaded', async () => {
    const stale = record({ Port: '5433' });
    const snapshot = structuredClone(stale);
    const provider = {
      import: vi.fn(async () => ({
        physicalId: 'mydb',
        attributes: { ...ATTRS, 'Endpoint.Port': '5434' },
        pendingAttributeKeys: ['Endpoint.Port', 7],
      })),
    };
    const healer = createReadOnlyAttributeHealerFactory({
      getProvider: () => provider as never,
      inRegion: (_region, fn) => fn(),
    })('App', 'us-east-1');
    await expect(healer('Db', stale)).resolves.toMatchObject({ pendingKeys: ['Endpoint.Port'] });
    await expect(resolveAttr(stale, 'Endpoint.Port', healer)).resolves.toBe('5434');
    expect(stale).toEqual(snapshot);
  });
});
