/**
 * go-to-k/cdkd#6655: a record's identity id (`RoleId`, `PolicyId`,
 * `TableId`, `DbiResourceId`, `DBClusterResourceId`) is trusted on first use
 * and never replaced. A record without one (a legacy record, deleted by name
 * anyway) acquires it once from a read the deploy makes while acting on the
 * resource: the `Fn::GetAtt`-miss heal (ADD-only) or an in-place update's
 * result. A recorded one is never replaced from a live read: an in-place
 * update (deploy, rollback revert, `drift --revert`) answering another id keeps
 * the recorded one, since an in-place update cannot change an AWS-minted id.
 * A record whose resource a delete-first replacement deleted drops its dead
 * id (`withoutDeadIdentity`, `newCopyDeleteAttributes`).
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
import { SURVIVOR_IDENTITY_ATTRIBUTES } from '../../../src/deployment/rollback-executor/replaced-survivor.js';
import type { ResourceState } from '../../../src/types/state.js';
import { recordAfterRollbackUpdate } from '../../../src/deployment/rollback-executor/replay-retry.js';
import { identityWarner } from '../../../src/provisioning/recorded-identity.js';
import {
  attributesAfterUpdate,
  keepRecordedIdentity,
  newCopyDeleteAttributes,
  replaceDeadIdentity,
  withoutDeadIdentity,
} from '../../../src/deployment/recorded-identity-attributes.js';

const ROLE = 'AWS::IAM::Role';
const ROLE_ARN = 'arn:aws:iam::123456789012:role/my-role';

function roleRecord(attributes: Record<string, unknown>): ResourceState {
  return {
    physicalId: 'my-role',
    resourceType: ROLE,
    properties: {},
    attributes,
    dependencies: [],
    provisionedBy: 'sdk',
  } as unknown as ResourceState;
}

function healerFor(record: ResourceState, liveAttributes: Record<string, unknown>) {
  const provider = {
    import: vi.fn(async () => ({ physicalId: record.physicalId, attributes: liveAttributes })),
  };
  return new AttributeHealer({
    providerRegistry: {
      getProviderFor: () => ({ provider, provisionedBy: 'sdk' }),
    } as never,
    baseline: { R: record },
    stackRegion: 'us-east-1',
    logger: { debug: () => undefined },
    resolvedSecretsOf: () => undefined,
    namingSecrets: () => ({}) as never,
  });
}

describe('the GetAtt-miss heal and the identity id (go-to-k/cdkd#6655)', () => {
  it('a legacy record acquires the RoleId the heal read, once', async () => {
    const record = roleRecord({});
    const healer = healerFor(record, { Arn: ROLE_ARN, RoleId: 'role-id-live' });
    await healer.heal('R', record, 'App');
    expect(healer.withHealedAttributes('R', record).attributes).toEqual({
      Arn: ROLE_ARN,
      RoleId: 'role-id-live',
    });
  });

  it('a recorded RoleId is never replaced by the heal (ADD-only)', async () => {
    const record = roleRecord({ RoleId: 'role-id-recorded' });
    const healer = healerFor(record, { Arn: ROLE_ARN, RoleId: 'role-id-holder-now' });
    await healer.heal('R', record, 'App');
    expect(healer.withHealedAttributes('R', record).attributes).toEqual({
      Arn: ROLE_ARN,
      RoleId: 'role-id-recorded',
    });
  });
});

describe('an in-place update never replaces a recorded identity id (go-to-k/cdkd#6655)', () => {
  it('another returned RoleId keeps the recorded one, and says so', () => {
    const differing: string[] = [];
    expect(
      attributesAfterUpdate(
        ROLE,
        { Arn: ROLE_ARN, RoleId: 'recorded' },
        { attributes: { Arn: ROLE_ARN, RoleId: 'holder-now' } },
        (key) => differing.push(key)
      )
    ).toEqual({ Arn: ROLE_ARN, RoleId: 'recorded' });
    expect(differing).toEqual(['RoleId']);
  });

  it('a legacy record acquires the returned RoleId (trust on first use), with no warning', () => {
    const differing: string[] = [];
    const next = { Arn: 'new', RoleId: 'live' };
    expect(attributesAfterUpdate(ROLE, { Arn: ROLE_ARN }, { attributes: next }, (k) => differing.push(k))).toBe(
      next
    );
    expect(differing).toEqual([]);
  });

  it('a returned set without the id keeps the recorded one, with no warning', () => {
    const differing: string[] = [];
    expect(
      attributesAfterUpdate(ROLE, { RoleId: 'recorded' }, { attributes: { Arn: 'a' } }, (k) =>
        differing.push(k)
      )
    ).toEqual({ Arn: 'a', RoleId: 'recorded' });
    expect(differing).toEqual([]);
  });

  it('a masked or secret-reference recorded value is no id: the returned one is acquired, no warning', () => {
    for (const held of ['***', 'role-***-x', '{{resolve:ssm:p}}', '']) {
      const differing: string[] = [];
      expect(
        attributesAfterUpdate(ROLE, { RoleId: held }, { attributes: { RoleId: 'live' } }, (k) =>
          differing.push(k)
        )
      ).toEqual({ RoleId: 'live' });
      expect(differing).toEqual([]);
    }
  });

  it('the same id, other types, and a returned-nothing update are unchanged', () => {
    const same = { Arn: ROLE_ARN, RoleId: 'recorded' };
    expect(attributesAfterUpdate(ROLE, { RoleId: 'recorded' }, { attributes: same })).toBe(same);
    const queue = { QueueUrl: 'u', RoleId: 'x' };
    expect(attributesAfterUpdate('AWS::SQS::Queue', { RoleId: 'y' }, { attributes: queue })).toBe(
      queue
    );
    const previous = { Arn: ROLE_ARN, RoleId: 'recorded' };
    expect(attributesAfterUpdate(ROLE, previous, {})).toBe(previous);
    expect(attributesAfterUpdate(ROLE, undefined, {})).toBeUndefined();
  });

  it('a replacement records its new resource id as returned', () => {
    const replaced = { Arn: 'new-arn', RoleId: 'new-id' };
    expect(
      attributesAfterUpdate(ROLE, { RoleId: 'recorded' }, { attributes: replaced, wasReplaced: true })
    ).toBe(replaced);
    expect(attributesAfterUpdate(ROLE, { RoleId: 'recorded' }, { wasReplaced: true })).toBeUndefined();
  });

  it('keepRecordedIdentity covers every listed type', () => {
    expect(Object.keys(SURVIVOR_IDENTITY_ATTRIBUTES).sort()).toEqual([
      'AWS::DynamoDB::Table',
      'AWS::ECR::Repository',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::Role',
      'AWS::IAM::User',
      'AWS::Logs::LogGroup',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::StepFunctions::StateMachine',
    ]);
    for (const [type, key] of Object.entries(SURVIVOR_IDENTITY_ATTRIBUTES)) {
      expect(keepRecordedIdentity(type, { [key]: 'old' }, { [key]: 'new', X: 1 })).toEqual({
        [key]: 'old',
        X: 1,
      });
      expect(keepRecordedIdentity(type, {}, { [key]: 'new' })).toEqual({ [key]: 'new' });
    }
  });
});

describe('a rollback / drift --revert in-place update (go-to-k/cdkd#6655)', () => {
  it('in place: the recorded RoleId stands over the returned one', () => {
    const record = recordAfterRollbackUpdate(roleRecord({ Arn: ROLE_ARN, RoleId: 'recorded' }), {
      physicalId: 'my-role',
      wasReplaced: false,
      attributes: { RoleId: 'holder-now' },
    });
    expect(record.attributes).toEqual({ Arn: ROLE_ARN, RoleId: 'recorded' });
  });

  it('in place: another returned RoleId reaches the warning callback, attribute only', () => {
    const warned: string[] = [];
    recordAfterRollbackUpdate(
      roleRecord({ RoleId: 'recorded' }),
      { physicalId: 'my-role', wasReplaced: false, attributes: { RoleId: 'holder-now' } },
      identityWarner({ warn: (m) => warned.push(m) }, (t) => t.replace('MyRole', '<masked>'), {
        logicalId: 'MyRole',
        resourceType: ROLE,
      })
    );
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('another RoleId than the recorded one');
    // Through the op's masker, and no id value.
    expect(warned[0]).toContain('<masked>');
    expect(warned[0]).not.toContain('holder-now');
  });

  it('in place on a legacy record: the returned RoleId is acquired', () => {
    const record = recordAfterRollbackUpdate(roleRecord({ Arn: ROLE_ARN }), {
      physicalId: 'my-role',
      wasReplaced: false,
      attributes: { RoleId: 'live' },
    });
    expect(record.attributes).toEqual({ Arn: ROLE_ARN, RoleId: 'live' });
  });

  it('replaced: the new resource id is recorded', () => {
    const record = recordAfterRollbackUpdate(roleRecord({ Arn: ROLE_ARN, RoleId: 'recorded' }), {
      physicalId: 'my-role-2',
      wasReplaced: true,
      attributes: { Arn: 'arn-2', RoleId: 'new-id' },
    });
    expect(record.attributes).toEqual({ Arn: 'arn-2', RoleId: 'new-id' });
  });
});

describe('a dead identity id (go-to-k/cdkd#6655)', () => {
  it('withoutDeadIdentity drops only the type identity key', () => {
    expect(withoutDeadIdentity(ROLE, { Arn: 'a', RoleId: 'dead' })).toEqual({ Arn: 'a' });
    const none = { Arn: 'a' };
    expect(withoutDeadIdentity(ROLE, none)).toBe(none);
    const other = { RoleId: 'x' };
    expect(withoutDeadIdentity('AWS::SQS::Queue', other)).toBe(other);
    expect(withoutDeadIdentity(ROLE, undefined)).toBeUndefined();
  });

  it('newCopyDeleteAttributes drops the id only when it is the deleted old record id', () => {
    const stale = { Arn: 'a', RoleId: 'old' };
    expect(newCopyDeleteAttributes(ROLE, stale, true, { RoleId: 'old' })).toEqual({ Arn: 'a' });
    // The record moved to the new copy: its id is the one to compare.
    const moved = { Arn: 'b', RoleId: 'new' };
    expect(newCopyDeleteAttributes(ROLE, moved, true, { RoleId: 'old' })).toBe(moved);
    // Not a delete-first replacement: the old resource is not proven gone.
    expect(newCopyDeleteAttributes(ROLE, stale, false, { RoleId: 'old' })).toBe(stale);
    expect(newCopyDeleteAttributes(ROLE, stale, undefined, { RoleId: 'old' })).toBe(stale);
  });

  it('replaceDeadIdentity records the id the failed create made, else drops the dead one', () => {
    const dead = { Arn: 'a', RoleId: 'old' };
    expect(replaceDeadIdentity(ROLE, dead, { RoleId: 'old' }, 'made')).toEqual({ Arn: 'a', RoleId: 'made' });
    expect(replaceDeadIdentity(ROLE, dead, { RoleId: 'old' }, undefined)).toEqual({ Arn: 'a' });
    // The record already names the new resource: left alone.
    const moved = { RoleId: 'new' };
    expect(replaceDeadIdentity(ROLE, moved, { RoleId: 'old' }, 'made')).toBe(moved);
    // A legacy record has no dead id to replace.
    const legacy = { Arn: 'a' };
    expect(replaceDeadIdentity(ROLE, legacy, {}, 'made')).toBe(legacy);
  });
});
