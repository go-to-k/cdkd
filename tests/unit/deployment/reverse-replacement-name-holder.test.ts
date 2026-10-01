/**
 * `reverseReplacementNewHoldsName` (issue #3979): the rollback deletes the NEW
 * resource first only on `holds: true`, so every shape the two records cannot
 * decide must answer `holds: false`, and only a PROVEN holder may answer true.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vite-plus/test';
import {
  reverseReplacementCaseInsensitiveTypes,
  reverseReplacementNameKeyKind,
  reverseReplacementNewHoldsName,
  reverseReplacementRewrittenNameTypes,
  reverseReplacementTrustsGeneratedName,
  reverseReplacementVerbatimGeneratedTypes,
} from '../../../src/deployment/replacement-name-holder.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';
import { withSkipPrefix, withStackName } from '../../../src/provisioning/resource-name.js';

type Input = Parameters<typeof reverseReplacementNewHoldsName>[0];

const QUEUE = 'AWS::SQS::Queue';

function ask(over: Partial<Input>) {
  return reverseReplacementNewHoldsName({
    oldResourceType: QUEUE,
    newResourceType: QUEUE,
    requested: { QueueName: 'q' },
    recorded: { QueueName: 'q' },
    observed: undefined,
    physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
    ...over,
  });
}

/** The `known` flag and diagnosis of a `holds: false` verdict. */
function refusal(verdict: ReturnType<typeof ask>): { known: boolean; diagnosis: string } {
  expect(verdict.holds).toBe(false);
  if (verdict.holds) throw new Error('unreachable');
  return { known: verdict.known, diagnosis: verdict.diagnosis };
}

describe('reverseReplacementNewHoldsName — the generic name property', () => {
  it('holds when the recorded names agree', () => {
    expect(ask({})).toEqual({ holds: true });
  });

  it('a case-only difference is a DIFFERENT name on a case-sensitive service', () => {
    // `Orders` and `orders` are two tables: a folded match would prove the
    // wrong holder and delete the live `orders` over an orphan `Orders`.
    const TABLE = 'AWS::DynamoDB::Table';
    const r = refusal(
      ask({
        oldResourceType: TABLE,
        newResourceType: TABLE,
        requested: { TableName: 'Orders' },
        recorded: { TableName: 'orders' },
        physicalId: 'orders',
      })
    );
    expect(r.known).toBe(true);
    // ...and the physical id is compared exactly too.
    expect(ask({ requested: { QueueName: 'Jobs' }, recorded: {}, physicalId: 'https://x/jobs' }).holds).toBe(
      false
    );
  });

  it('a case-insensitive name space folds case (IAM, the RDS family)', () => {
    const ROLE = 'AWS::IAM::Role';
    expect(
      ask({
        oldResourceType: ROLE,
        newResourceType: ROLE,
        requested: { RoleName: 'MyRole' },
        recorded: { RoleName: 'myrole' },
        physicalId: 'myrole',
      })
    ).toEqual({ holds: true });
    const DB = 'AWS::RDS::DBInstance';
    expect(
      ask({
        oldResourceType: DB,
        newResourceType: DB,
        requested: { DBInstanceIdentifier: 'MyDb' },
        recorded: {},
        physicalId: 'mydb',
      })
    ).toEqual({ holds: true });
  });

  it('a different recorded name is KNOWN to be elsewhere, and named', () => {
    const r = refusal(ask({ recorded: { QueueName: 'q-new' }, physicalId: 'https://x/q-new' }));
    expect(r.known).toBe(true);
    expect(r.diagnosis).toContain('QueueName "q"');
    expect(r.diagnosis).toContain('holds "q-new"');
    expect(r.diagnosis).not.toContain(', but ');
  });

  it('the observed name stands in for an absent recorded one', () => {
    expect(ask({ recorded: {}, observed: { QueueName: 'q' }, physicalId: 'opaque' })).toEqual({
      holds: true,
    });
  });

  it.each([
    ['a queue URL', 'https://sqs.us-east-1.amazonaws.com/123456789012/q'],
    ['an ARN', 'arn:aws:sqs:us-east-1:123456789012:q'],
    ['a bare name', 'q'],
    ['a composite id', 'parent|q'],
  ])('with no recorded name, %s naming it holds', (_label, physicalId) => {
    expect(ask({ recorded: {}, physicalId })).toEqual({ holds: true });
  });

  it('an ELBv2 ARN names its generated name through the segment before its id', () => {
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    const arn = (name: string) =>
      `arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/${name}/0123456789abcdef`;
    const base = { oldResourceType: TG, newResourceType: TG, requested: { Name: 'S-Tg' }, recorded: {} };
    expect(ask({ ...base, physicalId: arn('S-Tg') })).toEqual({ holds: true });
    expect(refusal(ask({ ...base, physicalId: arn('S-Other') })).known).toBe(false);
    const LB = 'AWS::ElasticLoadBalancingV2::LoadBalancer';
    for (const kind of ['app', 'net', 'gwy']) {
      expect(
        ask({
          oldResourceType: LB,
          newResourceType: LB,
          requested: { Name: 'S-Lb' },
          recorded: {},
          physicalId: `arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/${kind}/S-Lb/50dc6c495c0c9188`,
        })
      ).toEqual({ holds: true });
    }
  });

  it('a Secrets Manager ARN names the secret through its random suffix, in exact case', () => {
    const SECRET = 'AWS::SecretsManager::Secret';
    const base = { oldResourceType: SECRET, newResourceType: SECRET, recorded: {} };
    const arn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:My-Name-AbC123';
    expect(ask({ ...base, requested: { Name: 'My-Name' }, physicalId: arn })).toEqual({ holds: true });
    expect(ask({ ...base, requested: { Name: 'my-name' }, physicalId: arn }).holds).toBe(false);
  });

  it('with no recorded name and an id not naming it, it is UNPROVEN', () => {
    const r = refusal(ask({ recorded: {}, physicalId: 'https://x/other' }));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('cannot show');
  });

  it('a re-create that named nothing is unproven', () => {
    const r = refusal(ask({ requested: {} }));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('named no QueueName');
  });

  it('a GENERATED name proves only through the new id, and a mismatch is undecided', () => {
    // cdkd's generation rule is not every SDK provider's (a log group gets
    // `/cdkd/<name>`), so a generated name the new record does not match says
    // nothing about who holds the name.
    const LG = 'AWS::Logs::LogGroup';
    const base = { oldResourceType: LG, newResourceType: LG, requested: {} };
    const r = refusal(
      ask({
        ...base,
        generated: { LogGroupName: 'S-LG' },
        recorded: { LogGroupName: '/cdkd/S-LG' },
        physicalId: '/cdkd/S-LG',
      })
    );
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('named no LogGroupName');
    // On a TRUSTED type a generated mismatch is still undecided, and says the
    // name is cdkd's rule, not what the create asked for.
    const trusted = refusal(
      ask({ requested: {}, generated: { QueueName: 'S-Q' }, recorded: { QueueName: 'other' }, physicalId: 'x' })
    );
    expect(trusted.known).toBe(false);
    expect(trusted.diagnosis).toContain(`the cdkd naming rule generates QueueName "S-Q"`);
    expect(ask({ generated: { QueueName: 'q' }, requested: {}, recorded: {} })).toEqual({ holds: true });
    // A MATCH on a diverging type proves nothing either: its provider sent
    // `/cdkd/S-LG`, so a new log group holding `S-LG` is not the holder.
    const matched = refusal(
      ask({ ...base, generated: { LogGroupName: 'S-LG' }, recorded: { LogGroupName: 'S-LG' }, physicalId: 'S-LG' })
    );
    expect(matched.known).toBe(false);
    expect(matched.diagnosis).toContain('named no LogGroupName');
    // An explicit name wins over the generated one.
    expect(ask({ generated: { QueueName: 'other' } })).toEqual({ holds: true });
  });

  it('an observed value never stands behind a recorded mask', () => {
    const r = refusal(
      ask({ recorded: { QueueName: SECRET_MASK }, observed: { QueueName: 'q' }, physicalId: 'opaque' })
    );
    expect(r.known).toBe(false);
  });

  it.each([
    ['a redaction mask', SECRET_MASK],
    ['an unresolved reference', '{{resolve:ssm:/name}}'],
    ['a non-string', { Ref: 'X' }],
  ])('a requested name that is %s is unproven, never compared', (_label, value) => {
    const r = refusal(ask({ requested: { QueueName: value } }));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('redacted, unresolved or not a string');
  });

  it('an EMPTY requested name says so', () => {
    const r = refusal(ask({ requested: { QueueName: '' } }));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('asked for is empty');
  });
});

describe('reverseReplacementNewHoldsName — scoped and nested names', () => {
  const RULE = 'AWS::Events::Rule';

  it('a name placed by a scope holds only in the same scope', () => {
    const base = { oldResourceType: RULE, newResourceType: RULE, physicalId: 'bus|r' };
    expect(
      ask({ ...base, requested: { Name: 'r', EventBusName: 'b' }, recorded: { Name: 'r', EventBusName: 'b' } })
    ).toEqual({ holds: true });
    const other = refusal(
      ask({ ...base, requested: { Name: 'r', EventBusName: 'b' }, recorded: { Name: 'r', EventBusName: 'c' } })
    );
    expect(other.known).toBe(true);
    expect(other.diagnosis).toContain('is under EventBusName "c", not "b"');
  });

  it.each([
    ['AWS::Events::Rule', 'Name', 'EventBusName'],
    ['AWS::ECS::Service', 'ServiceName', 'Cluster'],
    ['AWS::Scheduler::Schedule', 'Name', 'GroupName'],
  ])('%s: an absent %s scope reads as its default on either side', (type, name, scope) => {
    const base = { oldResourceType: type, newResourceType: type, physicalId: 'r' };
    expect(ask({ ...base, requested: { [name]: 'r' }, recorded: { [name]: 'r', [scope]: 'default' } })).toEqual({
      holds: true,
    });
    expect(ask({ ...base, requested: { [name]: 'r', [scope]: 'default' }, recorded: { [name]: 'r' } })).toEqual({
      holds: true,
    });
  });

  it('a scope differing only in case, or spelled as an ARN against a name, is not proven', () => {
    const ECS = 'AWS::ECS::Service';
    const base = { oldResourceType: ECS, newResourceType: ECS, physicalId: 'svc' };
    const cased = refusal(
      ask({ ...base, requested: { ServiceName: 'svc', Cluster: 'Prod' }, recorded: { ServiceName: 'svc', Cluster: 'prod' } })
    );
    expect(cased.known).toBe(true);
    const arn = refusal(
      ask({
        ...base,
        requested: { ServiceName: 'svc', Cluster: 'prod' },
        recorded: { ServiceName: 'svc', Cluster: 'arn:aws:ecs:us-east-1:123456789012:cluster/prod' },
      })
    );
    expect(arn.known).toBe(false);
  });

  it('a scope with no default: absent on both sides agrees, on one side is unproven', () => {
    const SG = 'AWS::EC2::SecurityGroup';
    const base = { oldResourceType: SG, newResourceType: SG, physicalId: 'sg-1' };
    expect(ask({ ...base, requested: { GroupName: 'g' }, recorded: { GroupName: 'g' } })).toEqual({
      holds: true,
    });
    const r = refusal(
      ask({ ...base, requested: { GroupName: 'g', VpcId: 'vpc-1' }, recorded: { GroupName: 'g' } })
    );
    expect(r.known).toBe(false);
  });

  it('a redacted scope on either side is unproven, not read as the default', () => {
    const base = { oldResourceType: RULE, newResourceType: RULE, physicalId: 'r' };
    for (const [requested, recorded, observed] of [
      [{ Name: 'r', EventBusName: SECRET_MASK }, { Name: 'r' }, undefined],
      [{ Name: 'r' }, { Name: 'r', EventBusName: SECRET_MASK }, undefined],
      [{ Name: 'r' }, { Name: 'r' }, { EventBusName: SECRET_MASK }],
    ] as const) {
      const r = refusal(ask({ ...base, requested, recorded, observed }));
      expect(r.known).toBe(false);
      expect(r.diagnosis).toContain('cannot read the EventBusName');
    }
  });

  it('a Glue table in another database is elsewhere, even under a shared id (#3892)', () => {
    const TABLE = 'AWS::Glue::Table';
    const r = refusal(
      ask({
        oldResourceType: TABLE,
        newResourceType: TABLE,
        requested: { DatabaseName: 'my', TableInput: { Name: 'db|orders' } },
        recorded: { DatabaseName: 'my|db', TableInput: { Name: 'orders' } },
        physicalId: 'my|db|orders',
      })
    );
    expect(r.known).toBe(true);
    expect(r.diagnosis).toContain('DatabaseName');
  });

  it('reads a nested name, and the first of alternative paths that yields one', () => {
    const BUDGET = 'AWS::Budgets::Budget';
    expect(
      ask({
        oldResourceType: BUDGET,
        newResourceType: BUDGET,
        requested: { Budget: { BudgetName: 'b' } },
        recorded: { Budget: { BudgetName: 'b' } },
        physicalId: 'b',
      })
    ).toEqual({ holds: true });
    const DB = 'AWS::Glue::Database';
    expect(
      ask({
        oldResourceType: DB,
        newResourceType: DB,
        requested: { DatabaseName: 'd' },
        recorded: { DatabaseInput: { Name: 'd' } },
        physicalId: 'opaque',
      })
    ).toEqual({ holds: true });
  });
});

describe('reverseReplacementNewHoldsName — Route 53 record sets', () => {
  const RS = 'AWS::Route53::RecordSet';
  const rec = (over: Record<string, unknown>) => ({
    HostedZoneId: 'Z1',
    Name: 'swap.example.com',
    Type: 'A',
    ...over,
  });
  const askRs = (requested: Record<string, unknown>, recorded: Record<string, unknown>) =>
    ask({ oldResourceType: RS, newResourceType: RS, requested, recorded, physicalId: 'Z1|x|A' });

  it('a CNAME on either side conflicts with every record of its name', () => {
    expect(askRs(rec({ Type: 'CNAME' }), rec({}))).toEqual({ holds: true });
    expect(askRs(rec({}), rec({ Type: 'CNAME' }))).toEqual({ holds: true });
  });

  it('otherwise only the same type and SetIdentifier hold it', () => {
    expect(askRs(rec({ SetIdentifier: 's' }), rec({ SetIdentifier: 's' }))).toEqual({ holds: true });
    expect(refusal(askRs(rec({}), rec({ Type: 'AAAA' }))).known).toBe(true);
    expect(refusal(askRs(rec({ SetIdentifier: 's' }), rec({ SetIdentifier: 't' }))).known).toBe(true);
    // Two CNAMEs of one name coexist under different SetIdentifiers.
    expect(
      refusal(askRs(rec({ Type: 'CNAME', SetIdentifier: 'a' }), rec({ Type: 'CNAME', SetIdentifier: 'b' })))
        .known
    ).toBe(true);
    expect(askRs(rec({ Type: 'CNAME' }), rec({ Type: 'CNAME' }))).toEqual({ holds: true });
    // A SetIdentifier on one side only is undecided.
    expect(refusal(askRs(rec({}), rec({ SetIdentifier: 's' }))).known).toBe(false);
  });

  it('compares zone NAMES when neither side has a zone id', () => {
    const byName = (zone: string) => ({ HostedZoneName: zone, Name: 'swap.example.com', Type: 'CNAME' });
    expect(askRs(byName('example.com.'), { ...byName('EXAMPLE.com'), Type: 'A' })).toEqual({ holds: true });
    expect(refusal(askRs(byName('example.com'), { ...byName('other.com'), Type: 'A' })).known).toBe(true);
  });

  it('an unreadable Name or Type is unproven, and an escaped name pair is undecided', () => {
    const { Type: _t, ...noType } = rec({});
    expect(refusal(askRs(noType, rec({}))).known).toBe(false);
    expect(refusal(askRs(rec({ Type: 'CNAME' }), rec({ Name: SECRET_MASK }))).known).toBe(false);
    expect(
      refusal(askRs(rec({ Type: 'CNAME', Name: '\\052.example.com.' }), rec({ Name: '*.example.com' }))).known
    ).toBe(false);
  });

  it('compares names without the trailing dot and case, zones without the path prefix', () => {
    expect(
      askRs(
        rec({ Type: 'CNAME', Name: 'SWAP.example.com.' }),
        rec({ HostedZoneId: '/hostedzone/Z1' })
      )
    ).toEqual({ holds: true });
  });

  it('another name or zone is elsewhere; an unreadable zone pairing is unproven', () => {
    expect(refusal(askRs(rec({ Type: 'CNAME' }), rec({ Name: 'other.example.com' }))).known).toBe(true);
    expect(refusal(askRs(rec({ Type: 'CNAME' }), rec({ HostedZoneId: 'Z2' }))).known).toBe(true);
    const mixed = refusal(
      askRs(rec({ Type: 'CNAME' }), { HostedZoneName: 'example.com', Name: 'swap.example.com', Type: 'A' })
    );
    expect(mixed.known).toBe(false);
  });
});

describe('reverseReplacementNewHoldsName — types', () => {
  it('a Type change holds only between types sharing a name space', () => {
    expect(
      ask({
        oldResourceType: 'AWS::DynamoDB::Table',
        newResourceType: 'AWS::DynamoDB::GlobalTable',
        requested: { TableName: 't' },
        recorded: { TableName: 't' },
        physicalId: 't',
      })
    ).toEqual({ holds: true });
    // The RDS API family is one identifier space per account and region.
    for (const [from, to, property] of [
      ['AWS::RDS::DBCluster', 'AWS::DocDB::DBCluster', 'DBClusterIdentifier'],
      ['AWS::Neptune::DBInstance', 'AWS::RDS::DBInstance', 'DBInstanceIdentifier'],
      ['AWS::DocDB::DBSubnetGroup', 'AWS::Neptune::DBSubnetGroup', 'DBSubnetGroupName'],
    ] as const) {
      const bag = { [property]: 'db1' };
      expect(
        ask({ oldResourceType: from, newResourceType: to, requested: bag, recorded: bag, physicalId: 'db1' })
      ).toEqual({ holds: true });
    }
    // Any other pair is UNKNOWN, never "another resource holds it": a cluster
    // and an instance of one engine, or two unrelated services.
    for (const [from, to] of [
      ['AWS::RDS::DBCluster', 'AWS::RDS::DBInstance'],
      ['AWS::SSM::Parameter', 'AWS::SNS::Topic'],
    ] as const) {
      const r = refusal(ask({ oldResourceType: from, newResourceType: to, requested: { Name: 'q' } }));
      expect(r.known).toBe(false);
      expect(r.diagnosis).toContain('does not know to share a name space');
      expect(r.diagnosis).toContain(`is of type ${to}`);
    }
  });

  it('a type no name proves, or one cdkd has no key for, is unproven', () => {
    for (const type of ['AWS::Lambda::Permission', 'AWS::Some::Unknown']) {
      const r = refusal(ask({ oldResourceType: type, newResourceType: type }));
      expect(r.known).toBe(false);
    }
    // Not name-keyed although the generic table names a property: a user pool
    // name is not unique, and an inline policy's put is an upsert, so equal
    // names prove nothing.
    for (const [type, property] of [
      ['AWS::Cognito::UserPool', 'UserPoolName'],
      ['AWS::IAM::Policy', 'PolicyName'],
    ] as const) {
      const bag = { [property]: 'n' };
      const r = refusal(
        ask({ oldResourceType: type, newResourceType: type, requested: bag, recorded: bag, physicalId: 'n' })
      );
      expect(r.known).toBe(false);
    }
  });

  it('a nested stack is never proven: its child name is a state key AWS never sees', () => {
    const NESTED = 'AWS::CloudFormation::Stack';
    const r = refusal(ask({ oldResourceType: NESTED, newResourceType: NESTED, requested: {} }));
    expect(r.known).toBe(false);
  });

  it('masks a value BEFORE rendering it, so an escaped or cut secret cannot slip past', () => {
    const secret = 'tok"en-SECRETVALUE';
    const mask = (v: string) => v.split(secret).join('***');
    const quotedSecret = refusal(
      ask({ requested: { QueueName: `q-${secret}` }, recorded: { QueueName: 'q-new' }, physicalId: 'x', mask })
    );
    expect(quotedSecret.diagnosis).not.toContain('SECRETVALUE');
    // The same order for an identifier rendered bare (the new physical id).
    const idSecret = refusal(
      ask({ recorded: { QueueName: 'q-new' }, physicalId: `id-${secret}`, mask })
    );
    expect(idSecret.diagnosis).not.toContain('SECRETVALUE');
    const long = 'L'.repeat(300);
    const cut = refusal(
      ask({
        requested: { QueueName: long },
        recorded: { QueueName: 'q-new' },
        physicalId: 'x',
        mask: (v) => v.split(long).join('***'),
      })
    );
    expect(cut.diagnosis).not.toContain('LLLLLLLLLL');
  });

  it('the diagnosis quotes a forged id instead of printing its line break', () => {
    const r = refusal(ask({ recorded: { QueueName: 'x' }, physicalId: 'new\nTo orphan it: evil' }));
    expect(r.diagnosis).not.toContain('\n');
  });
});

describe('every snapshot type with a name-shaped create-only property is classified', () => {
  // Population by ENUMERATION: the committed create-only snapshot, not a
  // hand-picked list. A type that gains a name-shaped create-only property
  // must be given a key (or declared not name-keyed) here, or this fails.
  it('none is left unknown', () => {
    const named = [...CREATE_ONLY_PATHS_SNAPSHOT]
      .filter(([, paths]) => paths.some((p) => /(Name|Identifier)$/.test(p.join('.'))))
      .map(([type]) => type);
    // The floor is a LITERAL, measured 2026-09-29: an enumeration that silently
    // matched nothing would otherwise pass.
    expect(named.length).toBeGreaterThanOrEqual(84);
    const unknown = named.filter((type) => reverseReplacementNameKeyKind(type) === 'unknown');
    expect(unknown).toEqual([]);
  });
});

describe('the generated-name mirror is trusted only where the provider mints it verbatim', () => {
  // An ALLOW-list, not a scan: a provider that wraps or re-options cdkd's
  // generation (a prefix, a suffix, a concatenation, a variable, a different
  // maxLength) would slip past any text fence, so an unaudited type simply
  // ignores the generated bag and can only refuse. Changing the list is a
  // deliberate edit of this literal, after reading the provider's generation.
  it('is exactly the audited set, and excludes the known wrapping providers', () => {
    expect(reverseReplacementVerbatimGeneratedTypes()).toEqual([
      'AWS::CloudWatch::Alarm',
      'AWS::DocDB::DBCluster',
      'AWS::DocDB::DBInstance',
      'AWS::DocDB::DBSubnetGroup',
      'AWS::DynamoDB::Table',
      'AWS::ECR::Repository',
      'AWS::ECS::Cluster',
      'AWS::ECS::Service',
      'AWS::ElastiCache::CacheCluster',
      'AWS::ElastiCache::SubnetGroup',
      'AWS::Events::Rule',
      'AWS::Kinesis::Stream',
      'AWS::Lambda::Function',
      'AWS::Neptune::DBCluster',
      'AWS::Neptune::DBInstance',
      'AWS::Neptune::DBSubnetGroup',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::RDS::DBSubnetGroup',
      'AWS::SNS::Topic',
      'AWS::SQS::Queue',
      'AWS::SecretsManager::Secret',
      'AWS::StepFunctions::StateMachine',
      'AWS::WAFv2::WebACL',
    ]);
    for (const wrapping of ['AWS::Logs::LogGroup', 'AWS::SSM::Parameter', 'AWS::S3Express::DirectoryBucket', 'AWS::S3::Bucket']) {
      expect(reverseReplacementTrustsGeneratedName(wrapping)).toBe(false);
    }
    // A rewriting type is owned by its own table, never by this list.
    for (const type of Object.keys(reverseReplacementRewrittenNameTypes())) {
      expect(reverseReplacementTrustsGeneratedName(type)).toBe(false);
    }
  });
});

describe('the case-insensitive name spaces are a reviewed list', () => {
  // A member folds case into a PROOF that leads to a delete, so a service
  // that is in fact case-sensitive here deletes the wrong resource. Changing
  // the list is a deliberate edit of this literal.
  it('is exactly the audited set', () => {
    expect(reverseReplacementCaseInsensitiveTypes()).toEqual([
      'AWS::DocDB::DBCluster',
      'AWS::DocDB::DBInstance',
      'AWS::DocDB::DBSubnetGroup',
      'AWS::ElastiCache::CacheCluster',
      'AWS::ElastiCache::SubnetGroup',
      'AWS::IAM::Group',
      'AWS::IAM::InstanceProfile',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::Role',
      'AWS::IAM::User',
      'AWS::Neptune::DBCluster',
      'AWS::Neptune::DBInstance',
      'AWS::Neptune::DBSubnetGroup',
      'AWS::RDS::DBCluster',
      'AWS::RDS::DBInstance',
      'AWS::RDS::DBSubnetGroup',
    ]);
  });
});

describe('a provider that rewrites the name it sends (review M1, #4018)', () => {
  const ROLE = 'AWS::IAM::Role';
  const role = (over: Partial<Input>) =>
    ask({
      oldResourceType: ROLE,
      newResourceType: ROLE,
      requested: { RoleName: 'my-role' },
      recorded: { RoleName: 'my-role' },
      logicalId: 'MyRole',
      ...over,
    });

  it('outside withSkipPrefix the SENT name is prefixed, so a new role holding the recorded one is not proven', () => {
    // `cdkd rollback` enters withStackName but not withSkipPrefix.
    const r = withStackName('Stk', () => refusal(role({ physicalId: 'my-role' })));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('RoleName "my-role", which its provider sends as "Stk-my-role"');
    expect(withStackName('Stk', () => role({ physicalId: 'Stk-my-role' }))).toEqual({ holds: true });
  });

  it('under withSkipPrefix the sent name is the declared one', () => {
    expect(
      withSkipPrefix(true, () => withStackName('Stk', () => role({ physicalId: 'my-role' })))
    ).toEqual({ holds: true });
  });

  it("the provider's charset rewrite is applied too: `my_role` is sent as `my-role`", () => {
    const requested = { RoleName: 'my_role' };
    expect(role({ requested, recorded: requested, physicalId: 'my-role' })).toEqual({ holds: true });
    expect(refusal(role({ requested, recorded: requested, physicalId: 'my_role' })).known).toBe(false);
  });

  it('G3: a recorded name matching (case-folded) is no proof behind a non-name id', () => {
    // Before M1 this held through the case-insensitive recorded-name branch.
    const r = refusal(
      role({ requested: { RoleName: 'MyRole' }, recorded: { RoleName: 'myrole' }, physicalId: 'AROAEXAMPLE123' })
    );
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('a recorded name is no proof');
    // The id still folds case for a case-insensitive IAM name.
    expect(role({ requested: { RoleName: 'MyRole' }, recorded: {}, physicalId: 'myrole' })).toEqual({ holds: true });
    // ...and the recorded-name branch still folds for a NON-rewriting member.
    const DB = 'AWS::RDS::DBInstance';
    expect(
      ask({
        oldResourceType: DB,
        newResourceType: DB,
        requested: { DBInstanceIdentifier: 'MyDb' },
        recorded: { DBInstanceIdentifier: 'mydb' },
        physicalId: 'db-OPAQUE',
      })
    ).toEqual({ holds: true });
  });

  it('an UNNAMED create derives the name from the logical id, and needs one', () => {
    for (const [type, property, id] of [
      ['AWS::IAM::Role', 'RoleName', 'Stk-MyRole'],
      ['AWS::IAM::ManagedPolicy', 'ManagedPolicyName', 'arn:aws:iam::123456789012:policy/Stk-MyRole'],
      ['AWS::IAM::InstanceProfile', 'InstanceProfileName', 'Stk-MyRole'],
    ] as const) {
      const base = { oldResourceType: type, newResourceType: type, requested: {}, recorded: {} };
      expect(withStackName('Stk', () => ask({ ...base, logicalId: 'MyRole', physicalId: id }))).toEqual({
        holds: true,
      });
      const other = refusal(withStackName('Stk', () => ask({ ...base, logicalId: 'MyRole', physicalId: 'x' })));
      expect(other.diagnosis).toContain(`its provider generates ${property} "Stk-MyRole" here`);
      const noId = refusal(withStackName('Stk', () => ask({ ...base, logicalId: 7, physicalId: id })));
      expect(noId.diagnosis).toContain('cannot derive the name its provider generates');
    }
  });

  it('on the Cloud Control route the bag IS what was sent, proven only by the new id', () => {
    expect(withStackName('Stk', () => role({ createdVia: 'cc-api', physicalId: 'my-role' }))).toEqual({
      holds: true,
    });
    // The NEW resource may have been made by the SDK provider (a replacement
    // routes afresh): its record keeps the template value while AWS holds the
    // rewritten name, so an equal recorded name must not prove it.
    const sdkMadeRole = refusal(
      withStackName('Stk', () =>
        role({
          createdVia: 'cc-api',
          requested: { RoleName: 'my_role' },
          recorded: { RoleName: 'my_role' },
          physicalId: 'Stk-my-role',
        })
      )
    );
    expect(sdkMadeRole.known).toBe(false);
    const TG = 'AWS::ElasticLoadBalancingV2::TargetGroup';
    const sdkMadeTg = refusal(
      withStackName('Stk', () =>
        ask({
          oldResourceType: TG,
          newResourceType: TG,
          createdVia: 'cc-api',
          requested: { Name: 'tg' },
          recorded: { Name: 'tg' },
          physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/Stk-tg/abc',
        })
      )
    );
    expect(sdkMadeTg.known).toBe(false);
    // A nameless Cloud Control bag has nothing to compare.
    expect(refusal(role({ createdVia: 'cc-api', requested: {}, physicalId: 'MyRole' })).known).toBe(false);
  });

  it('an EMPTY sent name, or an empty logical id, never proves a holder', () => {
    // Outside a stack scope, `___` sanitises to nothing; an empty id then
    // "names" it by equality.
    const empty = refusal(role({ requested: { RoleName: '___' }, recorded: {}, physicalId: '' }));
    expect(empty.diagnosis).toContain('sends for RoleName is empty');
    const noId = refusal(role({ requested: {}, recorded: {}, logicalId: '', physicalId: '' }));
    expect(noId.diagnosis).toContain('cannot derive the name its provider generates');
  });

  it('a managed policy ARN with a path names the policy through its last segment', () => {
    const MP = 'AWS::IAM::ManagedPolicy';
    expect(
      withStackName('Stk', () =>
        ask({
          oldResourceType: MP,
          newResourceType: MP,
          requested: { ManagedPolicyName: 'p' },
          recorded: {},
          logicalId: 'P',
          physicalId: 'arn:aws:iam::123456789012:policy/team/app/Stk-p',
        })
      )
    ).toEqual({ holds: true });
  });

  it('a secret-derived declared name is never followed by its rewritten spelling', () => {
    const secret = 'tok_SECRET';
    const r = refusal(
      withStackName('Stk', () =>
        role({
          requested: { RoleName: secret },
          physicalId: 'x',
          mask: (v) => v.split(secret).join('***'),
        })
      )
    );
    expect(r.diagnosis).not.toContain('SECRET');
    expect(r.diagnosis).toContain('which its provider rewrites before sending it');
  });
});

describe('the rewriting-types table matches every caller of generateResourceNameWithFallback', () => {
  // Population by ENUMERATION of the tree: every provider call site, its
  // property and its maxLength must be one table entry, and every entry must
  // be seen at a call site. A new caller file is a failure until mapped here.
  const DIR = join(process.cwd(), 'src', 'provisioning', 'providers');
  const FILE_TYPES: Record<string, readonly string[]> = {
    'elbv2-provider.ts': [
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
      'AWS::ElasticLoadBalancingV2::TargetGroup',
    ],
    'iam-instance-profile-provider.ts': ['AWS::IAM::InstanceProfile'],
    'iam-managed-policy-provider.ts': ['AWS::IAM::ManagedPolicy'],
    'iam-role-provider.ts': ['AWS::IAM::Role'],
    'iam-user-group-provider.ts': ['AWS::IAM::User', 'AWS::IAM::Group'],
  };
  /**
   * Call sites per file, a LITERAL measured 2026-09-29: two types sharing one
   * property and maxLength (ELBv2's `Name` / 32) cannot be told apart by the
   * table check, so a dropped call is caught here.
   */
  const FILE_CALLS: Record<string, number> = {
    'elbv2-provider.ts': 2,
    'iam-instance-profile-provider.ts': 1,
    'iam-managed-policy-provider.ts': 2,
    'iam-role-provider.ts': 2,
    'iam-user-group-provider.ts': 3,
  };

  /** The text of each `generateResourceNameWithFallback(...)` call, cut at its own closing paren. */
  function callsIn(text: string): string[] {
    const out: string[] = [];
    const needle = 'generateResourceNameWithFallback(';
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
      let depth = 0;
      let end = at + needle.length - 1;
      for (; end < text.length; end += 1) {
        if (text[end] === '(') depth += 1;
        else if (text[end] === ')' && --depth === 0) break;
      }
      out.push(text.slice(at + needle.length, end));
    }
    return out;
  }

  it('each call site is a table entry, and each entry is a call site', () => {
    const table = reverseReplacementRewrittenNameTypes();
    const seen = new Set<string>();
    const callers: string[] = [];
    let calls = 0;
    let specCalls = 0;
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(DIR, file), 'utf8');
      const constant = (expr: string): number => {
        if (/^\d+$/.test(expr)) return Number(expr);
        const m = new RegExp(`const ${expr} = (\\d+);`).exec(text);
        if (!m) throw new Error(`${file}: unresolved maxLength ${expr}`);
        return Number(m[1]);
      };
      const bodies = callsIn(text);
      if (bodies.length === 0) continue;
      callers.push(file);
      expect(bodies.length, `${file}: call sites`).toBe(FILE_CALLS[file]);
      const types = FILE_TYPES[file];
      expect(types, `${file} calls the generator but is not mapped`).toBeDefined();
      for (const body of bodies) {
        // The options must be exactly `{ maxLength: <n> }`, the call's last
        // argument: any other option would change the name the table derives.
        const options = /,\s*\{ maxLength: ([\w.]+) \}\s*,?\s*$/.exec(body);
        expect(options, `${file}: options other than { maxLength } in ${body}`).not.toBeNull();
        const [, max] = options!;
        const args = body.slice(0, options!.index);
        calls += 1;
        const prop = /properties\['(\w+)'\]/.exec(args!)?.[1];
        const pairs: Array<[string, number]> =
          prop !== undefined
            ? [[prop, constant(max!)]]
            : // The shared-spec shape: `{ key: '<prop>', maxLength: <CONST> }` rows.
              [...text.matchAll(/\{ key: '(\w+)', maxLength: (\w+) \}/g)].map(
                (m) => [m[1]!, constant(m[2]!)] as [string, number]
              );
        if (prop === undefined) specCalls += 1;
        expect(pairs.length, `${file}: a call whose property cannot be read`).toBeGreaterThan(0);
        for (const [property, maxLength] of pairs) {
          const match = types!.filter(
            (t) => table[t]?.property === property && table[t]?.maxLength === maxLength
          );
          expect(match, `${file}: ${property} / ${maxLength} has no table entry`).not.toEqual([]);
          for (const t of match) seen.add(t);
        }
      }
    }
    // Floors are LITERALS, measured 2026-09-29: 10 call sites in 5 files, one
    // of them the shared-spec shape.
    expect(calls).toBeGreaterThanOrEqual(10);
    expect(specCalls).toBeGreaterThanOrEqual(1);
    expect(callers.sort()).toEqual(Object.keys(FILE_TYPES).sort());
    // No caller outside the providers directory, except the generator's own
    // module and this helper, which derives the sent name with it.
    const src = join(process.cwd(), 'src');
    const everywhere = (readdirSync(src, { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => readFileSync(join(src, f), 'utf8').includes('generateResourceNameWithFallback('))
      .map((f) => f.split('\\').join('/'))
      .sort();
    expect(everywhere).toEqual(
      [
        'deployment/replacement-name-holder.ts',
        'provisioning/resource-name.ts',
        ...Object.keys(FILE_TYPES).map((f) => `provisioning/providers/${f}`),
      ].sort()
    );
    expect([...seen].sort()).toEqual(Object.keys(table).sort());
    // Nothing reaches the generator under another name: outside comments and
    // import statements, every mention of it is a call (no alias, no
    // destructuring, no bare reference handed on). And nothing in
    // provisioning but the generator's own module sets `userSupplied`, so no
    // provider applies the prefix rule by calling the inner generator.
    for (const f of (readdirSync(src, { recursive: true }) as string[]).filter((x) => x.endsWith('.ts'))) {
      const rel = f.split('\\').join('/');
      if (rel === 'provisioning/resource-name.ts') continue;
      const raw = readFileSync(join(src, f), 'utf8');
      expect(/generateResourceNameWithFallback\s+as\s/.test(raw), `${rel}: aliased import`).toBe(false);
      const code = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
        .replace(/^import\s[\s\S]*?;$/gm, '');
      const mentions = code.split(/\bgenerateResourceNameWithFallback\b/).length - 1;
      const calls = code.split('generateResourceNameWithFallback(').length - 1;
      expect(mentions, `${rel}: a reference to the generator that is not a call`).toBe(calls);
      if (rel.startsWith('provisioning/')) {
        expect(/\buserSupplied\b/.test(code), `${rel}: sets userSupplied itself`).toBe(false);
      }
    }
  });

  it('the call parser cuts each call at its own paren and sees an options drift', () => {
    const bodies = callsIn(
      "generateResourceNameWithFallback(properties['RoleName'] as string, logicalId, OPTS);\n" +
        'generateResourceName(logicalId, { maxLength: 64 });'
    );
    expect(bodies).toEqual(["properties['RoleName'] as string, logicalId, OPTS"]);
    expect(/,\s*\{ maxLength: ([\w.]+) \}\s*,?\s*$/.test(bodies[0]!)).toBe(false);
  });
});
