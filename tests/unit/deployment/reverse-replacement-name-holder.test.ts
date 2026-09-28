/**
 * `reverseReplacementNewHoldsName` (issue #3979): the rollback deletes the NEW
 * resource first only on `holds: true`, so every shape the two records cannot
 * decide must answer `holds: false`, and only a PROVEN holder may answer true.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  reverseReplacementNameKeyKind,
  reverseReplacementNewHoldsName,
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
  it('holds when the recorded names agree, case-insensitively', () => {
    expect(ask({})).toEqual({ holds: true });
    expect(ask({ recorded: { QueueName: 'Q' } })).toEqual({ holds: true });
  });

  it('a different recorded name is KNOWN to be elsewhere, and named', () => {
    const r = refusal(ask({ recorded: { QueueName: 'q-new' }, physicalId: 'https://x/q-new' }));
    expect(r.known).toBe(true);
    expect(r.diagnosis).toContain('QueueName "q"');
    expect(r.diagnosis).toContain('holds "q-new"');
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
    expect(
      ask({
        oldResourceType: LB,
        newResourceType: LB,
        requested: { Name: 'S-Lb' },
        recorded: {},
        physicalId: 'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/S-Lb/50dc6c495c0c9188',
      })
    ).toEqual({ holds: true });
  });

  it('with no recorded name and an id not naming it, it is UNPROVEN', () => {
    const r = refusal(ask({ recorded: {}, physicalId: 'https://x/other' }));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('cannot show');
  });

  it('a re-create that asked for NO name generated one: unproven', () => {
    const r = refusal(ask({ requested: {} }));
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('asked for no QueueName');
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

  it('an absent scope reads as its default on either side', () => {
    const base = { oldResourceType: RULE, newResourceType: RULE, physicalId: 'r' };
    expect(
      ask({ ...base, requested: { Name: 'r' }, recorded: { Name: 'r', EventBusName: 'default' } })
    ).toEqual({ holds: true });
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

  it('a redacted scope is unproven, not read as the default', () => {
    const base = { oldResourceType: RULE, newResourceType: RULE, physicalId: 'r' };
    const r = refusal(
      ask({ ...base, requested: { Name: 'r', EventBusName: SECRET_MASK }, recorded: { Name: 'r' } })
    );
    expect(r.known).toBe(false);
    expect(r.diagnosis).toContain('cannot read the EventBusName');
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
  });

  it('a nested stack is named from its logical id, so the new one holds it', () => {
    const NESTED = 'AWS::CloudFormation::Stack';
    expect(ask({ oldResourceType: NESTED, newResourceType: NESTED, requested: {} })).toEqual({
      holds: true,
    });
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
