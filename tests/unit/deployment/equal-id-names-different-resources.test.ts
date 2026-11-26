import { describe, it, expect } from 'vite-plus/test';
import {
  equalIdNamesDifferentResources,
  equalIdNamesSameResource,
} from '../../../src/deployment/type-change-guard.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

/**
 * Issue #3892: a Glue table's id is placed by its recorded DatabaseName, so two
 * DIFFERENT tables can share one id. The predicate says so only when it can
 * tell: two usable, different database names. Every unreadable input answers
 * `false` — the pre-#3892 reading — because a wrong `true` would let the engine
 * delete "the old resource" by an id that is the one it just created.
 */
describe('equalIdNamesDifferentResources (issue #3892)', () => {
  const GLUE = 'AWS::Glue::Table';
  const check = (
    id: string | undefined,
    oldDb: unknown,
    newDb: unknown,
    resourceType = GLUE
  ): boolean =>
    equalIdNamesDifferentResources({
      resourceType,
      physicalId: id,
      oldProperties: { DatabaseName: oldDb },
      newProperties: { DatabaseName: newDb },
    });

  it('is true for two databases that both anchor the shared id', () => {
    expect(check('my|db|orders', 'my', 'my|db')).toBe(true);
    expect(check('my|db|orders', 'my|db', 'my')).toBe(true);
  });

  // A DatabaseName that does not prefix the id says nothing about the table
  // the id names: `cdkd import` records `a|b` beside a template `x`, and its
  // readers address `a.b`. Correcting the template to `a` is the SAME table.
  it('is false when one DatabaseName does not anchor the id', () => {
    expect(check('a|b', 'x', 'a')).toBe(false);
    expect(check('a|b', 'a', 'x')).toBe(false);
  });

  it.each([
    ['the same database', 'my|db|orders', 'my', 'my'],
    ['a {{resolve:...}} expression beside its plaintext', 'my|orders', '{{resolve:ssm:DbName}}', 'my'],
    ['an unresolved intrinsic', 'my|orders', { Ref: 'Db' }, 'my'],
    ['a redaction mask', 'my|orders', SECRET_MASK, 'my'],
    ['an empty name', 'my|orders', '', 'my'],
    ['an absent name', 'my|orders', undefined, 'my'],
  ])('is false for %s', (_n, id, oldDb, newDb) => {
    expect(check(id, oldDb, newDb)).toBe(false);
    expect(check(id, newDb, oldDb)).toBe(false);
  });

  it('is false with no id', () => {
    expect(check(undefined, 'my', 'my|db')).toBe(false);
  });

  it('is false for every other type, whatever the bags say', () => {
    expect(check('my|db|orders', 'my', 'my|db', 'AWS::SQS::Queue')).toBe(false);
  });

  it('is false with no bags at all', () => {
    expect(
      equalIdNamesDifferentResources({
        resourceType: GLUE,
        physicalId: 'my|db|orders',
        oldProperties: undefined,
        newProperties: undefined,
      })
    ).toBe(false);
  });
});

describe('equalIdNamesSameResource with property bags (issue #3892)', () => {
  it('answers false within one type when the bags name different Glue tables', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::Glue::Table',
        newType: 'AWS::Glue::Table',
        createLayer: 'sdk',
        oldProperties: { DatabaseName: 'my' },
        newProperties: { DatabaseName: 'my|db' },
        physicalId: 'my|db|orders',
      })
    ).toBe(false);
  });

  it('keeps the type-only answer without bags, and for another type', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::Glue::Table',
        newType: 'AWS::Glue::Table',
        createLayer: 'sdk',
      })
    ).toBe(true);
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::SQS::Queue',
        newType: 'AWS::SQS::Queue',
        createLayer: 'sdk',
        oldProperties: { DatabaseName: 'my' },
        newProperties: { DatabaseName: 'my|db' },
        physicalId: 'my|db|orders',
      })
    ).toBe(true);
  });
});

/**
 * go-to-k/cdkd#5137: a Lambda permission's id is a StatementId AWS scopes to
 * its function, so the same id on two different functions is two statements.
 * Only two readable unqualified spellings with different function names prove
 * it; every doubt keeps the same-resource reading.
 */
describe('equalIdNamesDifferentResources: AWS::Lambda::Permission (go-to-k/cdkd#5137)', () => {
  const check = (oldFn: unknown, newFn: unknown): boolean =>
    equalIdNamesDifferentResources({
      resourceType: 'AWS::Lambda::Permission',
      physicalId: 'ApiPermission',
      oldProperties: { FunctionName: oldFn },
      newProperties: { FunctionName: newFn },
    });
  const ARN = (name: string): string => `arn:aws:lambda:us-east-1:123456789012:function:${name}`;

  it('is true for two different function names, in any unqualified spelling', () => {
    expect(check('old-fn', 'changed-name')).toBe(true);
    expect(check(ARN('old-fn'), ARN('changed-name'))).toBe(true);
    expect(check('123456789012:function:old-fn', 'changed-name')).toBe(true);
  });

  it.each([
    ['the same function', 'fn', 'fn'],
    ['one function spelled as a name and as an ARN', 'fn', ARN('fn')],
    ['a qualified ARN', `${ARN('old-fn')}:live`, 'changed-name'],
    ['a {{resolve:...}} expression', '{{resolve:ssm:FnName}}', 'changed-name'],
    ['an unresolved intrinsic', { Ref: 'Fn' }, 'changed-name'],
    ['a redaction mask', SECRET_MASK, 'changed-name'],
    ['an absent name', undefined, 'changed-name'],
  ])('is false for %s', (_n, oldFn, newFn) => {
    expect(check(oldFn, newFn)).toBe(false);
    expect(check(newFn, oldFn)).toBe(false);
  });

  it('makes equalIdNamesSameResource read the equal id as two statements', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::Lambda::Permission',
        newType: 'AWS::Lambda::Permission',
        createLayer: 'sdk',
        oldProperties: { FunctionName: 'old-fn' },
        newProperties: { FunctionName: 'changed-name' },
        physicalId: 'ApiPermission',
      })
    ).toBe(false);
  });
});

/**
 * go-to-k/cdkd#7071: a standalone ingress rule's id is
 * `<GroupId>|<IpProtocol>|<FromPort>|<ToPort>`, with no source, so a source
 * change creates a new rule under the old id. Two readable sources that differ
 * (after EC2's own CIDR canonicalization) are two rules; every doubt keeps the
 * same-resource reading.
 */
describe('equalIdNamesDifferentResources: AWS::EC2::SecurityGroupIngress (go-to-k/cdkd#7071)', () => {
  const ID = 'sg-0dst|tcp|443|443';
  const check = (oldSource: Record<string, unknown>, newSource: Record<string, unknown>): boolean =>
    equalIdNamesDifferentResources({
      resourceType: 'AWS::EC2::SecurityGroupIngress',
      physicalId: ID,
      oldProperties: { GroupId: 'sg-0dst', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, ...oldSource },
      newProperties: { GroupId: 'sg-0dst', IpProtocol: 'tcp', FromPort: 443, ToPort: 443, ...newSource },
    });

  it.each([
    ['two CIDRs', { CidrIp: '10.0.0.0/16' }, { CidrIp: '0.0.0.0/0' }],
    ['two IPv6 CIDRs', { CidrIpv6: '2001:db8::/32' }, { CidrIpv6: '::/0' }],
    ['two source groups', { SourceSecurityGroupId: 'sg-0old' }, { SourceSecurityGroupId: 'sg-0new' }],
    ['two prefix lists', { SourcePrefixListId: 'pl-0a' }, { SourcePrefixListId: 'pl-0b' }],
    ['a CIDR moved to a source group', { CidrIp: '10.0.0.0/16' }, { SourceSecurityGroupId: 'sg-0new' }],
    ['an IPv4 CIDR moved to IPv6', { CidrIp: '0.0.0.0/0' }, { CidrIpv6: '::/0' }],
  ])('is true for %s', (_n, oldSource, newSource) => {
    expect(check(oldSource, newSource)).toBe(true);
    expect(check(newSource, oldSource)).toBe(true);
  });

  it.each([
    ['the same CIDR', { CidrIp: '10.0.0.0/16' }, { CidrIp: '10.0.0.0/16' }],
    // EC2 stores 10.0.0.5/16 as 10.0.0.0/16 and refuses the second as a duplicate.
    ['two spellings of one network', { CidrIp: '10.0.0.5/16' }, { CidrIp: '10.0.0.0/16' }],
    ['two spellings of one IPv6 network', { CidrIpv6: '2001:DB8:0:0:0:0:0:0/32' }, { CidrIpv6: '2001:db8::/32' }],
    ['the same source group', { SourceSecurityGroupId: 'sg-0a' }, { SourceSecurityGroupId: 'sg-0a' }],
    // The owner only qualifies a group id AWS mints unique.
    [
      'one group with and without its owner',
      { SourceSecurityGroupId: 'sg-0a' },
      { SourceSecurityGroupId: 'sg-0a', SourceSecurityGroupOwnerId: '123456789012' },
    ],
    // A name can denote the group another rule names by id.
    ['a group named by SourceSecurityGroupName', { SourceSecurityGroupName: 'web' }, { SourceSecurityGroupId: 'sg-0a' }],
    // The name beside an id still keeps it: the two can denote one group.
    [
      'a SourceSecurityGroupName beside a source key',
      { SourceSecurityGroupName: 'web', SourceSecurityGroupId: 'sg-0a' },
      { SourceSecurityGroupId: 'sg-0b' },
    ],
    ['an unresolved intrinsic', { SourceSecurityGroupId: { 'Fn::GetAtt': ['Sg', 'GroupId'] } }, { SourceSecurityGroupId: 'sg-0a' }],
    ['a redaction mask', { CidrIp: SECRET_MASK }, { CidrIp: '0.0.0.0/0' }],
    ['a value that holds a mask', { SourceSecurityGroupId: `sg-${SECRET_MASK}` }, { SourceSecurityGroupId: 'sg-0a' }],
    ['no source at all', {}, { CidrIp: '0.0.0.0/0' }],
    ['two sources in one bag', { CidrIp: '10.0.0.0/16', SourcePrefixListId: 'pl-0a' }, { CidrIp: '0.0.0.0/0' }],
    ['an empty source', { CidrIp: '' }, { CidrIp: '0.0.0.0/0' }],
  ])('is false for %s', (_n, oldSource, newSource) => {
    expect(check(oldSource, newSource)).toBe(false);
    expect(check(newSource, oldSource)).toBe(false);
  });

  it('is false for an absent bag', () => {
    expect(
      equalIdNamesDifferentResources({
        resourceType: 'AWS::EC2::SecurityGroupIngress',
        physicalId: ID,
        oldProperties: undefined,
        newProperties: { CidrIp: '0.0.0.0/0' },
      })
    ).toBe(false);
  });

  it('makes equalIdNamesSameResource read the equal id as two rules', () => {
    expect(
      equalIdNamesSameResource({
        oldType: 'AWS::EC2::SecurityGroupIngress',
        newType: 'AWS::EC2::SecurityGroupIngress',
        createLayer: 'sdk',
        oldProperties: { CidrIp: '10.0.0.0/16' },
        newProperties: { CidrIp: '0.0.0.0/0' },
        physicalId: ID,
      })
    ).toBe(false);
  });
});

/**
 * go-to-k/cdkd#7072: a stage's id is its bare name, scoped by an API the id
 * does not carry, so a stage moved to a replaced API is a new stage under the
 * old id. Only two readable API ids that differ prove it.
 */
describe.each([
  ['AWS::ApiGatewayV2::Stage', 'ApiId', '$default'],
  ['AWS::ApiGateway::Stage', 'RestApiId', 'prod'],
])('equalIdNamesDifferentResources: %s (go-to-k/cdkd#7072)', (resourceType, key, id) => {
  const check = (oldApi: unknown, newApi: unknown): boolean =>
    equalIdNamesDifferentResources({
      resourceType,
      physicalId: id,
      oldProperties: { StageName: id, [key]: oldApi },
      newProperties: { StageName: id, [key]: newApi },
    });

  it('is true for two different API ids', () => {
    expect(check('abc123def0', 'xyz789ghi1')).toBe(true);
  });

  it.each([
    ['the same API', 'abc123def0', 'abc123def0'],
    ['a redaction mask', SECRET_MASK, 'xyz789ghi1'],
    ['a secret reference', '{{resolve:ssm:/app/api}}', 'xyz789ghi1'],
    ['an unresolved intrinsic', { Ref: 'Api' }, 'xyz789ghi1'],
    ['an absent API id', undefined, 'xyz789ghi1'],
    ['an empty API id', '', 'xyz789ghi1'],
  ])('is false for %s', (_n, oldApi, newApi) => {
    expect(check(oldApi, newApi)).toBe(false);
    expect(check(newApi, oldApi)).toBe(false);
  });
});
