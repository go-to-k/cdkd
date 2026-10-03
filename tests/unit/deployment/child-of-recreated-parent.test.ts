import { describe, it, expect } from 'vite-plus/test';
import {
  childLostWithRecreatedParent,
  childStoredInParentTypes,
  lostChildActions,
  noChangeChildrenOfRecreatedParents,
  withRecreatedAttachmentsDropped,
} from '../../../src/deployment/child-of-recreated-parent.js';

/** go-to-k/cdkd#4411: which resource went with a parent recreated under the same id. */
describe('childLostWithRecreatedParent', () => {
  const types: Record<string, string> = {
    Fn: 'AWS::Lambda::Function',
    Alias: 'AWS::Lambda::Alias',
    Version: 'AWS::Lambda::Version',
    Topic: 'AWS::SNS::Topic',
    Role: 'AWS::IAM::Role',
  };
  const recordedTypeOf = (id: string): string | undefined =>
    Object.hasOwn(types, id) ? types[id] : undefined;
  const ask = (
    resourceType: string,
    templateProperties: Record<string, unknown>,
    recreated: string[] = ['Fn', 'Topic', 'Role', 'Alias', 'Version']
  ): ReturnType<typeof childLostWithRecreatedParent> =>
    childLostWithRecreatedParent({
      resourceType,
      templateProperties,
      recreatedUnderSameId: new Set(recreated),
      recordedTypeOf,
    });

  it('names the parent of a permission reading it by Ref or Fn::GetAtt', () => {
    expect(ask('AWS::Lambda::Permission', { FunctionName: { Ref: 'Fn' } })).toEqual({
      parent: 'Fn',
      property: 'FunctionName',
      mode: 'recreate',
    });
    expect(
      ask('AWS::Lambda::Permission', { FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] } })
    ).toEqual({ parent: 'Fn', property: 'FunctionName', mode: 'recreate' });
  });

  it('reads the parent from a list property, and re-puts a child naming several parents', () => {
    expect(ask('AWS::IAM::Policy', { Roles: ['other-role', { Ref: 'Role' }] })).toEqual({
      parent: 'Role',
      property: 'Roles',
      mode: 'reput',
    });
    expect(ask('AWS::SNS::TopicPolicy', { Topics: [{ Ref: 'Topic' }] })?.mode).toBe('reput');
    expect(ask('AWS::IAM::RolePolicy', { RoleName: { Ref: 'Role' } })?.mode).toBe('recreate');
  });

  it('answers undefined when the parent was not recreated under the same id', () => {
    expect(
      ask('AWS::Lambda::Permission', { FunctionName: { Ref: 'Fn' } }, ['Topic'])
    ).toBeUndefined();
  });

  it('answers undefined for a reference held by a property that does not name the parent', () => {
    expect(
      ask('AWS::Lambda::Permission', { FunctionName: 'literal', SourceArn: { Ref: 'Topic' } })
    ).toBeUndefined();
  });

  it('takes a permission on an alias of the function: the alias went with it', () => {
    expect(ask('AWS::Lambda::Permission', { FunctionName: { Ref: 'Alias' } })?.parent).toBe('Alias');
    // ...and on a version re-published under the same ARN.
    expect(ask('AWS::Lambda::Permission', { FunctionName: { Ref: 'Version' } })?.parent).toBe(
      'Version'
    );
  });

  it('answers undefined when the referenced resource is not of a parent type', () => {
    // An event invoke config names the function, never a topic.
    expect(ask('AWS::Lambda::EventInvokeConfig', { FunctionName: { Ref: 'Topic' } })).toBeUndefined();
  });

  it('reads only the taken Fn::If arm when the deploy evaluated its condition', () => {
    const props = { FunctionName: { 'Fn::If': ['UseOther', { Ref: 'Other' }, { Ref: 'Fn' }] } };
    const withConditions = (conditions: Record<string, boolean>) =>
      childLostWithRecreatedParent({
        resourceType: 'AWS::Lambda::Permission',
        templateProperties: props,
        recreatedUnderSameId: new Set(['Fn']),
        recordedTypeOf,
        conditions,
      });
    expect(withConditions({ UseOther: true })).toBeUndefined();
    expect(withConditions({ UseOther: false })?.parent).toBe('Fn');
    // No evaluated conditions: both arms count.
    expect(ask('AWS::Lambda::Permission', props, ['Fn'])?.parent).toBe('Fn');
  });

  it('answers undefined for a type not stored inside its parent', () => {
    expect(ask('AWS::Lambda::EventSourceMapping', { FunctionName: { Ref: 'Fn' } })).toBeUndefined();
    expect(ask('AWS::SSM::Parameter', { Value: { Ref: 'Fn' } })).toBeUndefined();
    // An inherited member is no table entry.
    expect(ask('constructor', { FunctionName: { Ref: 'Fn' } })).toBeUndefined();
  });

  it('pins the child types', () => {
    expect(childStoredInParentTypes()).toEqual([
      'AWS::IAM::GroupPolicy',
      'AWS::IAM::InstanceProfile',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::Policy',
      'AWS::IAM::RolePolicy',
      'AWS::IAM::User',
      'AWS::IAM::UserPolicy',
      'AWS::IAM::UserToGroupAddition',
      'AWS::Lambda::Alias',
      'AWS::Lambda::EventInvokeConfig',
      'AWS::Lambda::Permission',
      'AWS::Lambda::Version',
      'AWS::Logs::LogStream',
      'AWS::Logs::MetricFilter',
      'AWS::Logs::SubscriptionFilter',
      'AWS::S3::BucketPolicy',
      'AWS::SNS::Subscription',
      'AWS::SNS::TopicInlinePolicy',
      'AWS::SNS::TopicPolicy',
      'AWS::SQS::QueueInlinePolicy',
      'AWS::SQS::QueuePolicy',
    ]);
  });
});

describe('lostChildActions (go-to-k/cdkd#4443)', () => {
  const rec = (resourceType: string, physicalId: string, properties: Record<string, unknown> = {}) => ({
    resourceType,
    physicalId,
    properties,
  });
  const act = (
    records: Record<string, ReturnType<typeof rec>>,
    templateResources: Record<string, { Type: string; Properties?: Record<string, unknown> }>,
    written: string[] = []
  ) =>
    lostChildActions({
      templateResources,
      records,
      recreatedUnderSameId: new Set(['Fn', 'Queue', 'Role']),
      written: new Set(written),
    });
  const forgotten = (actions: ReturnType<typeof act>): string[] =>
    actions.filter((a) => a.action === 'forget').map((a) => a.logicalId).sort();

  const templateResources = {
    Fn: { Type: 'AWS::Lambda::Function' },
    Queue: { Type: 'AWS::SQS::Queue' },
    Role: { Type: 'AWS::IAM::Role' },
    ByName: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Fn' } } },
    ByArn: {
      Type: 'AWS::Lambda::Permission',
      Properties: { FunctionName: { 'Fn::GetAtt': ['Fn', 'Arn'] } },
    },
    Policy: { Type: 'AWS::SQS::QueuePolicy', Properties: { Queues: [{ Ref: 'Queue' }] } },
  };
  const queueUrl = 'https://sqs.us-east-1.amazonaws.com/123/q';
  const records = {
    Fn: rec('AWS::Lambda::Function', 'my-fn'),
    Queue: rec('AWS::SQS::Queue', queueUrl),
    Role: rec('AWS::IAM::Role', 'role-a'),
    ByName: rec('AWS::Lambda::Permission', 'p1', { FunctionName: 'my-fn' }),
    ByArn: rec('AWS::Lambda::Permission', 'p2', {
      FunctionName: 'arn:aws:lambda:us-east-1:123:function:my-fn',
    }),
    Policy: rec('AWS::SQS::QueuePolicy', 'qp', { Queues: [queueUrl] }),
  };

  it('forgets every unwritten child whose record names the recreated parent, by id or function ARN', () => {
    expect(forgotten(act(records, templateResources))).toEqual(['ByArn', 'ByName', 'Policy']);
  });

  it('keeps every child this deploy wrote (restored, created or moved), and never the parent', () => {
    expect(act(records, templateResources, ['ByName', 'ByArn', 'Policy'])).toEqual([]);
  });

  it('keeps a child whose record names another resource, a shared tail, or a qualified ARN', () => {
    expect(
      act(
        {
          ...records,
          ByName: rec('AWS::Lambda::Permission', 'p1', { FunctionName: 'other-fn' }),
          ByArn: rec('AWS::Lambda::Permission', 'p2', {
            // An alias named like the recreated function, on another function.
            FunctionName: 'arn:aws:lambda:us-east-1:123:function:other:my-fn',
          }),
        },
        templateResources,
        ['Policy']
      )
    ).toEqual([]);
    expect(
      act(
        { ...records, ByName: rec('AWS::Lambda::Permission', 'p1', { FunctionName: 'x/my-fn' }) },
        templateResources,
        ['ByArn', 'Policy']
      )
    ).toEqual([]);
  });

  it('matches full and partial function ARNs, qualified or not, but not another function or a non-account prefix', () => {
    const one = (value: string) =>
      act(
        { ...records, ByName: rec('AWS::Lambda::Permission', 'p1', { FunctionName: value }) },
        templateResources,
        ['ByArn', 'Policy']
      );
    const forgot = [{ logicalId: 'ByName', parent: 'Fn', action: 'forget' }];
    expect(one('arn:aws:lambda:us-east-1:123456789012:function:my-fn:live')).toEqual(forgot);
    expect(one('123456789012:function:my-fn')).toEqual(forgot);
    expect(one('123456789012:function:my-fn:7')).toEqual(forgot);
    expect(one('arn:aws:lambda:us-east-1:123456789012:function:other:my-fn')).toEqual([]);
    expect(one('arn:aws:lambda:us-east-1:123456789012:function:my-fn:live:extra')).toEqual([]);
    expect(one('x:function:my-fn')).toEqual([]);
  });

  it('follows grandchildren: a permission on an alias of the recreated function is forgotten with the alias', () => {
    const aliasArn = 'arn:aws:lambda:us-east-1:123:function:my-fn:live';
    expect(
      act(
        {
          ...records,
          Alias: rec('AWS::Lambda::Alias', aliasArn, { FunctionName: 'my-fn', Name: 'live' }),
          AliasPerm: rec('AWS::Lambda::Permission', 'ap', { FunctionName: aliasArn }),
        },
        {
          ...templateResources,
          Alias: { Type: 'AWS::Lambda::Alias', Properties: { FunctionName: { Ref: 'Fn' } } },
          AliasPerm: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Alias' } } },
        },
        ['ByName', 'ByArn', 'Policy']
      )
        .map((a) => `${a.logicalId}:${a.action}`)
        .sort()
    ).toEqual(['Alias:forget', 'AliasPerm:forget']);
  });

  it('trims only entries naming a recreated resource of a PARENT type', () => {
    // A recreated function `role-b` says nothing of the role `role-b`.
    const policyTemplate = {
      ...templateResources,
      Fn2: { Type: 'AWS::Lambda::Function' },
      IamPolicy: { Type: 'AWS::IAM::Policy', Properties: { Roles: [{ Ref: 'Role' }, 'role-b'] } },
    };
    expect(
      lostChildActions({
        templateResources: policyTemplate,
        records: {
          ...records,
          Fn2: rec('AWS::Lambda::Function', 'role-b'),
          IamPolicy: rec('AWS::IAM::Policy', 'pol', { Roles: ['role-a', 'role-b'] }),
        },
        recreatedUnderSameId: new Set(['Fn', 'Queue', 'Role', 'Fn2']),
        written: new Set(['ByName', 'ByArn', 'Policy']),
      })
    ).toEqual([{ logicalId: 'IamPolicy', parent: 'Role', action: 'trim', trimmed: { Roles: ['role-b'] } }]);
  });

  it('keeps a child with no record, or recorded under another type', () => {
    const { ByName: _a, ...withoutByName } = records;
    expect(act(withoutByName, templateResources, ['ByArn', 'Policy'])).toEqual([]);
    expect(
      act(
        { ...records, ByName: rec('AWS::SNS::Topic', 'p1', { FunctionName: 'my-fn' }) },
        templateResources,
        ['ByArn', 'Policy']
      )
    ).toEqual([]);
  });

  it('trims a policy naming several holders to the surviving ones, and forgets it only when none survive', () => {
    const policyTemplate = {
      ...templateResources,
      IamPolicy: { Type: 'AWS::IAM::Policy', Properties: { Roles: [{ Ref: 'Role' }, 'ext-role'] } },
    };
    const written = ['ByName', 'ByArn', 'Policy'];
    expect(
      act(
        { ...records, IamPolicy: rec('AWS::IAM::Policy', 'pol', { Roles: ['role-a', 'ext-role'] }) },
        policyTemplate,
        written
      )
    ).toEqual([{ logicalId: 'IamPolicy', parent: 'Role', action: 'trim', trimmed: { Roles: ['ext-role'] } }]);
    // Only the recreated role, but the policy is also on a user: trim, not forget.
    expect(
      act(
        {
          ...records,
          IamPolicy: rec('AWS::IAM::Policy', 'pol', { Roles: ['role-a'], Users: ['u'] }),
        },
        policyTemplate,
        written
      )
    ).toEqual([{ logicalId: 'IamPolicy', parent: 'Role', action: 'trim', trimmed: { Roles: [] } }]);
    // On the recreated role alone: gone from AWS.
    expect(
      act(
        { ...records, IamPolicy: rec('AWS::IAM::Policy', 'pol', { Roles: ['role-a'] }) },
        policyTemplate,
        written
      )
    ).toEqual([{ logicalId: 'IamPolicy', parent: 'Role', action: 'forget' }]);
  });
});

describe('noChangeChildrenOfRecreatedParents (go-to-k/cdkd#4444)', () => {
  const templateResources = {
    Fn: { Type: 'AWS::Lambda::Function' },
    Perm: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Fn' } } },
    Updated: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Fn' } } },
    Gone: { Type: 'AWS::Lambda::Permission', Properties: { FunctionName: { Ref: 'Fn' } } },
    Param: { Type: 'AWS::SSM::Parameter', Properties: { Value: { Ref: 'Fn' } } },
  };
  const types: Record<string, string> = {
    Fn: 'AWS::Lambda::Function',
    Perm: 'AWS::Lambda::Permission',
    Updated: 'AWS::Lambda::Permission',
    Gone: 'AWS::Lambda::Permission',
    Param: 'AWS::SSM::Parameter',
  };
  const find = (recreated: string[], skip: string[] = []) =>
    noChangeChildrenOfRecreatedParents({
      changes: new Map([
        ['Fn', { changeType: 'UPDATE' }],
        ['Perm', { changeType: 'NO_CHANGE' }],
        ['Updated', { changeType: 'UPDATE' }],
        ['Gone', { changeType: 'NO_CHANGE' }],
        ['Param', { changeType: 'NO_CHANGE' }],
      ]),
      skip: new Set(skip),
      templateResources,
      recreatedUnderSameId: new Set(recreated),
      recordedTypeOf: (id) => (Object.hasOwn(types, id) ? types[id] : undefined),
    });

  it('names the NO_CHANGE children of a recreated parent, never a non-child, an UPDATE row or a skipped one', () => {
    expect(find(['Fn'], ['Gone'])).toEqual(['Perm']);
  });

  it('names nothing when no parent was recreated', () => {
    expect(find([])).toEqual([]);
  });
});

/** go-to-k/cdkd#4461: a child that survives its parent is attached to it again. */
describe('withRecreatedAttachmentsDropped', () => {
  const records: Record<string, { resourceType: string; physicalId: string }> = {
    Role: { resourceType: 'AWS::IAM::Role', physicalId: 'fixed-role' },
    User: { resourceType: 'AWS::IAM::User', physicalId: 'fixed-user' },
    Group: { resourceType: 'AWS::IAM::Group', physicalId: 'fixed-group' },
    Fn: { resourceType: 'AWS::Lambda::Function', physicalId: 'fixed-role' },
  };
  const drop = (
    resourceType: string,
    templateProperties: Record<string, unknown>,
    previous: Record<string, unknown>,
    recreated: string[] = ['Role', 'User', 'Group'],
    conditions?: Record<string, boolean>
  ): ReturnType<typeof withRecreatedAttachmentsDropped> =>
    withRecreatedAttachmentsDropped({
      resourceType,
      templateProperties,
      previous,
      recreatedUnderSameId: new Set(recreated),
      recordOf: (id) => (Object.hasOwn(records, id) ? records[id] : undefined),
      conditions,
    });

  it('classifies the IAM attachment types as reattach, and the inline policy on users and groups as reput', () => {
    const ask = (resourceType: string, props: Record<string, unknown>) =>
      childLostWithRecreatedParent({
        resourceType,
        templateProperties: props,
        recreatedUnderSameId: new Set(['Role', 'User', 'Group']),
        recordedTypeOf: (id) => records[id]?.resourceType,
      })?.mode;
    expect(ask('AWS::IAM::ManagedPolicy', { Roles: [{ Ref: 'Role' }] })).toBe('reattach');
    expect(ask('AWS::IAM::ManagedPolicy', { Users: [{ Ref: 'User' }] })).toBe('reattach');
    expect(ask('AWS::IAM::ManagedPolicy', { Groups: [{ Ref: 'Group' }] })).toBe('reattach');
    expect(ask('AWS::IAM::InstanceProfile', { Roles: [{ Ref: 'Role' }] })).toBe('reattach');
    expect(ask('AWS::IAM::User', { Groups: [{ Ref: 'Group' }] })).toBe('reattach');
    expect(ask('AWS::IAM::UserToGroupAddition', { GroupName: { Ref: 'Group' } })).toBe('reattach');
    expect(ask('AWS::IAM::UserToGroupAddition', { Users: [{ Ref: 'User' }] })).toBe('reattach');
    expect(ask('AWS::IAM::Policy', { Users: [{ Ref: 'User' }] })).toBe('reput');
    expect(ask('AWS::IAM::Policy', { Groups: [{ Ref: 'Group' }] })).toBe('reput');
  });

  it('drops only the re-created parents\' names from each attachment list', () => {
    expect(
      drop(
        'AWS::IAM::ManagedPolicy',
        { Roles: [{ Ref: 'Role' }, 'other-role'], Users: [{ Ref: 'User' }], Groups: ['g2'] },
        { Roles: ['fixed-role', 'other-role'], Users: ['fixed-user'], Groups: ['g2'], PolicyDocument: {} }
      )
    ).toEqual({
      previous: { Roles: ['other-role'], Users: [], Groups: ['g2'], PolicyDocument: {} },
      parents: ['Role', 'User'],
    });
    expect(
      drop('AWS::IAM::InstanceProfile', { Roles: [{ Ref: 'Role' }] }, { Roles: ['fixed-role'] })
    ).toEqual({ previous: { Roles: [] }, parents: ['Role'] });
    expect(
      drop('AWS::IAM::User', { Groups: [{ Ref: 'Group' }, 'kept'] }, { Groups: ['fixed-group', 'kept'] })
    ).toEqual({ previous: { Groups: ['kept'] }, parents: ['Group'] });
  });

  it('empties a UserToGroupAddition\'s recorded Users when its group was re-created', () => {
    expect(
      drop(
        'AWS::IAM::UserToGroupAddition',
        { GroupName: { Ref: 'Group' }, Users: ['u1', 'u2'] },
        { GroupName: 'fixed-group', Users: ['u1', 'u2'] }
      )
    ).toEqual({ previous: { GroupName: 'fixed-group', Users: [] }, parents: ['Group'] });
    expect(
      drop(
        'AWS::IAM::UserToGroupAddition',
        { GroupName: 'other-group', Users: [{ Ref: 'User' }, 'u2'] },
        { GroupName: 'other-group', Users: ['fixed-user', 'u2'] }
      )
    ).toEqual({ previous: { GroupName: 'other-group', Users: ['u2'] }, parents: ['User'] });
  });

  it('drops nothing for a parent not re-created, of another type, or for a reput / recreate child', () => {
    const props = { Roles: [{ Ref: 'Role' }] };
    const previous = { Roles: ['fixed-role'] };
    expect(drop('AWS::IAM::ManagedPolicy', props, previous, ['User'])).toBeUndefined();
    // A function that happens to share the role's name is not a role.
    expect(
      drop('AWS::IAM::ManagedPolicy', { Roles: [{ Ref: 'Fn' }] }, previous, ['Fn'])
    ).toBeUndefined();
    expect(drop('AWS::IAM::Policy', props, previous)).toBeUndefined();
    expect(drop('AWS::IAM::RolePolicy', { RoleName: { Ref: 'Role' } }, { RoleName: 'fixed-role' })).toBeUndefined();
    // Already absent from the record: nothing to add back.
    expect(drop('AWS::IAM::ManagedPolicy', props, { Roles: ['other'] })).toBeUndefined();
  });

  it('clears a UserToGroupAddition only while its RECORD names the re-created group, and only when it has members', () => {
    // Re-pointed from another group: its members are still in that one.
    expect(
      drop(
        'AWS::IAM::UserToGroupAddition',
        { GroupName: { Ref: 'Group' }, Users: ['u1'] },
        { GroupName: 'other-group', Users: ['u1'] }
      )
    ).toBeUndefined();
    expect(
      drop(
        'AWS::IAM::UserToGroupAddition',
        { GroupName: { Ref: 'Group' }, Users: [] },
        { GroupName: 'fixed-group', Users: [] }
      )
    ).toBeUndefined();
  });

  it('reads only the taken Fn::If arm', () => {
    const props = { Roles: [{ 'Fn::If': ['UseRole', 'other-role', { Ref: 'Role' }] }] };
    const previous = { Roles: ['fixed-role'] };
    expect(drop('AWS::IAM::ManagedPolicy', props, previous, undefined, { UseRole: true })).toBeUndefined();
    expect(drop('AWS::IAM::ManagedPolicy', props, previous, undefined, { UseRole: false })).toEqual({
      previous: { Roles: [] },
      parents: ['Role'],
    });
  });
});

/** go-to-k/cdkd#4461 on the failed-deploy path: an attached resource is trimmed, never forgotten. */
describe('lostChildActions for reattach children', () => {
  const rec = (resourceType: string, physicalId: string, properties: Record<string, unknown> = {}) => ({
    resourceType,
    physicalId,
    properties,
  });
  const principals = {
    Role: rec('AWS::IAM::Role', 'fixed-role'),
    Group: rec('AWS::IAM::Group', 'fixed-group'),
    User: rec('AWS::IAM::User', 'fixed-user'),
  };
  const principalTemplate = {
    Role: { Type: 'AWS::IAM::Role' },
    Group: { Type: 'AWS::IAM::Group' },
    User: { Type: 'AWS::IAM::User' },
  };
  const act = (
    child: ReturnType<typeof rec>,
    properties: Record<string, unknown>,
    recreated: string[] = ['Role', 'Group', 'User']
  ) =>
    lostChildActions({
      templateResources: { ...principalTemplate, Child: { Type: child.resourceType, Properties: properties } },
      records: { ...principals, Child: child },
      recreatedUnderSameId: new Set(recreated),
      written: new Set(),
    });

  it('trims a managed policy that named only the re-created role to [], keeping its record', () => {
    expect(
      act(rec('AWS::IAM::ManagedPolicy', 'arn:aws:iam::1:policy/p', { Roles: ['fixed-role'] }), {
        Roles: [{ Ref: 'Role' }],
      })
    ).toEqual([{ logicalId: 'Child', parent: 'Role', action: 'trim', trimmed: { Roles: [] } }]);
  });

  it('trims every list naming a re-created principal, each against its own type', () => {
    expect(
      act(
        rec('AWS::IAM::ManagedPolicy', 'arn:aws:iam::1:policy/p', {
          Roles: ['fixed-role', 'other'],
          Groups: ['fixed-group'],
          // A user that happens to share the role's name is not the role.
          Users: ['fixed-role'],
        }),
        { Roles: [{ Ref: 'Role' }, 'other'], Groups: [{ Ref: 'Group' }], Users: ['fixed-role'] }
      )
    ).toEqual([
      {
        logicalId: 'Child',
        parent: 'Role',
        action: 'trim',
        trimmed: { Roles: ['other'], Groups: [] },
      },
    ]);
  });

  it('empties a UserToGroupAddition whose recorded group was re-created, and trims a user list', () => {
    expect(
      act(rec('AWS::IAM::UserToGroupAddition', 'm', { GroupName: 'fixed-group', Users: ['u1'] }), {
        GroupName: { Ref: 'Group' },
        Users: ['u1'],
      })
    ).toEqual([{ logicalId: 'Child', parent: 'Group', action: 'trim', trimmed: { Users: [] } }]);
    expect(
      act(rec('AWS::IAM::User', 'member', { Groups: ['fixed-group', 'kept'] }), {
        Groups: [{ Ref: 'Group' }, 'kept'],
      })
    ).toEqual([{ logicalId: 'Child', parent: 'Group', action: 'trim', trimmed: { Groups: ['kept'] } }]);
  });

  it('forgets an inline policy whose every holder was re-created, across its lists', () => {
    expect(
      act(rec('AWS::IAM::Policy', 'pol', { Roles: ['fixed-role'], Users: ['fixed-user'] }), {
        Roles: [{ Ref: 'Role' }],
        Users: [{ Ref: 'User' }],
      })
    ).toEqual([{ logicalId: 'Child', parent: 'Role', action: 'forget' }]);
  });
});
