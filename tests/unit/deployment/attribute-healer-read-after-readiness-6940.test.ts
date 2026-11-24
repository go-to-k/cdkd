/**
 * go-to-k/cdkd#6940: a record THIS deploy wrote under `--no-wait` lacks what
 * its resource reports only once ready (an RDS endpoint). After the deferred
 * readiness wait, the record is read once more, and what the read found is
 * merged into the record at its next save — only keys it lacks, and only while
 * the record is still the one that was read.
 */
import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/deployment/intrinsic-function-resolver.js')>()),
  getAccountInfo: vi.fn(async (region?: string) => ({
    accountId: '123456789012',
    region: region ?? 'us-east-1',
    partition: 'aws',
  })),
}));

import { AttributeHealer } from '../../../src/deployment/deploy-engine/attribute-healer.js';
import type { ResourceState } from '../../../src/types/state.js';

const TYPE = 'AWS::RDS::DBInstance';

function record(attributes: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'mydb',
    resourceType: TYPE,
    properties: {},
    attributes,
    dependencies: [],
    provisionedBy: 'sdk',
  } as unknown as ResourceState;
}

function healerReading(live: Record<string, unknown>) {
  const provider = { import: vi.fn(async () => ({ physicalId: 'mydb', attributes: live })) };
  // Empty baseline: the record was CREATED by this deploy, which the #1852
  // heal never reads.
  const healer = new AttributeHealer({
    providerRegistry: { getProviderFor: () => ({ provider, provisionedBy: 'sdk' }) } as never,
    baseline: {},
    stackRegion: 'us-east-1',
    logger: { debug: () => undefined },
    resolvedSecretsOf: () => undefined,
    namingSecrets: () => ({}) as never,
  });
  return { healer, provider };
}

describe('AttributeHealer.readAfterReadiness (#6940)', () => {
  it('reads a record this deploy wrote, once, and the save adds only what it lacked', async () => {
    const created = record({ DBInstanceArn: 'arn:recorded' });
    const { healer, provider } = healerReading({
      DBInstanceArn: 'arn:live',
      'Endpoint.Address': 'mydb.x.rds.amazonaws.com',
    });
    // The #1852 heal does not read it: its attributes are the provider's own.
    await expect(healer.heal('Db', created, 'App')).resolves.toEqual({ kind: 'not-attempted' });

    const first = await healer.readAfterReadiness('Db', created, 'App');
    const second = await healer.readAfterReadiness('Db', created, 'App');
    expect(first).toBe(second);
    expect(provider.import).toHaveBeenCalledTimes(1);
    expect(healer.withHealedAttributes('Db', created).attributes).toEqual({
      DBInstanceArn: 'arn:recorded',
      'Endpoint.Address': 'mydb.x.rds.amazonaws.com',
    });
    expect(healer.hasUnpersistedHeals({ Db: created })).toBe(true);
  });

  it('a record the deploy rewrote after the read takes nothing', async () => {
    const created = record({});
    const { healer } = healerReading({ 'Endpoint.Address': 'mydb.x.rds.amazonaws.com' });
    await healer.readAfterReadiness('Db', created, 'App');
    const rewritten = record({ 'Endpoint.Address': 'after-update' });
    expect(healer.withHealedAttributes('Db', rewritten)).toBe(rewritten);
  });

  it('a failing read is an outcome, never a throw', async () => {
    const provider = { import: vi.fn(async () => Promise.reject(new Error('AccessDenied'))) };
    const healer = new AttributeHealer({
      providerRegistry: { getProviderFor: () => ({ provider, provisionedBy: 'sdk' }) } as never,
      baseline: {},
      stackRegion: 'us-east-1',
      logger: { debug: () => undefined },
      resolvedSecretsOf: () => undefined,
      namingSecrets: () => ({}) as never,
    });
    await expect(healer.readAfterReadiness('Db', record({}), 'App')).resolves.toMatchObject({
      kind: 'failed',
    });
  });
});
