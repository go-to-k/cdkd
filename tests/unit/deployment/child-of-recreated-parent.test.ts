import { describe, it, expect } from 'vite-plus/test';
import {
  childLostWithRecreatedParent,
  childStoredInParentTypes,
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
      'AWS::IAM::Policy',
      'AWS::IAM::RolePolicy',
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
