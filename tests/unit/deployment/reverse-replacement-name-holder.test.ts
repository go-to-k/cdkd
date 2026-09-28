/**
 * `reverseReplacementNewHoldsName` (issue #3979): the rollback deletes the NEW
 * resource first only on `holds: true`, so every shape the two records cannot
 * decide must answer `holds: false`, and only a PROVEN holder may answer true.
 */
import { describe, it, expect } from 'vite-plus/test';
import { readdirSync, readFileSync } from 'node:fs';
import {
  reverseReplacementCaseInsensitiveTypes,
  reverseReplacementNameKeyKind,
  reverseReplacementNewHoldsName,
  reverseReplacementTrustsGeneratedName,
} from '../../../src/deployment/replacement-name-holder.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { CREATE_ONLY_PATHS_SNAPSHOT } from '../../../src/provisioning/create-only-snapshot.generated.js';

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
    expect(trusted.diagnosis).toContain(`cdkd's rule generates QueueName "S-Q"`);
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
    expect(r.diagnosis).toContain('redacted or unresolved');
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
    const r = refusal(
      ask({ oldResourceType: 'AWS::SSM::Parameter', newResourceType: 'AWS::SNS::Topic', requested: { Name: 'q' } })
    );
    expect(r.known).toBe(true);
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
  // A provider that WRAPS cdkd's generation (`/cdkd/${generateResourceName(...)}`)
  // sends a name the mirror does not spell, so its type must be distrusted.
  // Read from the providers' SOURCE: a new wrapping site fails here until its
  // type is added to GENERATED_NAME_DIVERGES.
  it('every wrapped generation site belongs to a distrusted type', () => {
    const dir = new URL('../../../src/provisioning/providers/', import.meta.url);
    const wrapped = readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /`[^`]*\S\$\{generateResourceName/.test(readFileSync(new URL(f, dir), 'utf8')))
      .sort();
    expect(wrapped).toEqual(['logs-loggroup-provider.ts', 'ssm-parameter-provider.ts']);
    expect(reverseReplacementTrustsGeneratedName('AWS::Logs::LogGroup')).toBe(false);
    expect(reverseReplacementTrustsGeneratedName('AWS::SSM::Parameter')).toBe(false);
    expect(reverseReplacementTrustsGeneratedName('AWS::ElasticLoadBalancingV2::TargetGroup')).toBe(true);
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
