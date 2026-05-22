import { describe, expect, it } from 'vite-plus/test';
import { resolveExecutionRoleArnFromState } from '../../../src/cli/commands/local-invoke.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';

function makeRole(physicalId: string, arn: string): ResourceState {
  return {
    physicalId,
    resourceType: 'AWS::IAM::Role',
    properties: {},
    attributes: { Arn: arn },
    dependencies: [],
  };
}

function makeLambda(
  physicalId: string,
  role: unknown,
  observedRole?: unknown
): ResourceState {
  const r: ResourceState = {
    physicalId,
    resourceType: 'AWS::Lambda::Function',
    properties: { Role: role },
    attributes: {},
    dependencies: [],
  };
  if (observedRole !== undefined) {
    r.observedProperties = { Role: observedRole };
  }
  return r;
}

function stack(resources: Record<string, ResourceState>): StackState {
  return {
    version: 3,
    stackName: 'TestStack',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  };
}

describe('resolveExecutionRoleArnFromState (#442)', () => {
  const explicitArn = 'arn:aws:iam::123456789012:role/explicit-role';
  const siblingArn = 'arn:aws:iam::123456789012:role/MyStack-Handler-Role';

  it('returns undefined when the lambda has no state entry', () => {
    const state = stack({});
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('returns undefined when Role property is absent', () => {
    const state = stack({
      Handler: {
        physicalId: 'fn-x',
        resourceType: 'AWS::Lambda::Function',
        properties: {},
        attributes: {},
        dependencies: [],
      },
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('returns the verbatim ARN when Role is a literal string starting with arn:', () => {
    const state = stack({
      Handler: makeLambda('fn-x', explicitArn),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBe(explicitArn);
  });

  it('returns undefined when Role is a literal string that is not an ARN', () => {
    // Defensive: cdkd should never store a Role like this, but guard against it.
    const state = stack({
      Handler: makeLambda('fn-x', 'not-an-arn'),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('resolves Fn::GetAtt [<RoleId>, Arn] against the sibling Role.attributes.Arn', () => {
    const state = stack({
      HandlerRole: makeRole('MyStack-HandlerRole', siblingArn),
      Handler: makeLambda('fn-x', { 'Fn::GetAtt': ['HandlerRole', 'Arn'] }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBe(siblingArn);
  });

  it('resolves Fn::GetAtt with dot-form "<RoleId>.Arn" as well', () => {
    // pickReferencedLogicalId accepts both array form and dot-form
    const state = stack({
      HandlerRole: makeRole('MyStack-HandlerRole', siblingArn),
      Handler: makeLambda('fn-x', { 'Fn::GetAtt': 'HandlerRole.Arn' }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBe(siblingArn);
  });

  it('returns undefined when the Fn::GetAtt target Role resource is missing from state', () => {
    const state = stack({
      Handler: makeLambda('fn-x', { 'Fn::GetAtt': ['HandlerRole', 'Arn'] }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('returns undefined when the sibling Role has no Arn attribute captured', () => {
    const state = stack({
      HandlerRole: {
        physicalId: 'MyStack-HandlerRole',
        resourceType: 'AWS::IAM::Role',
        properties: {},
        attributes: {}, // missing Arn (e.g. ARN-only fromRoleArn import without deploy)
        dependencies: [],
      },
      Handler: makeLambda('fn-x', { 'Fn::GetAtt': ['HandlerRole', 'Arn'] }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('returns undefined for Fn::Sub shapes (out of v1 scope)', () => {
    const state = stack({
      Handler: makeLambda('fn-x', {
        'Fn::Sub': 'arn:aws:iam::${AWS::AccountId}:role/MyRole',
      }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('returns undefined for Fn::Join shapes (out of v1 scope)', () => {
    const state = stack({
      Handler: makeLambda('fn-x', {
        'Fn::Join': [':', ['arn', 'aws', 'iam', '', 'role/X']],
      }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBeUndefined();
  });

  it('falls back to observedProperties.Role when properties.Role is absent', () => {
    // Edge: cdkd state might capture Role under observedProperties (v3) only
    // when the user did not template the property explicitly (rare for Lambda
    // but defensive — the resolver checks both).
    const state = stack({
      HandlerRole: makeRole('MyStack-HandlerRole', siblingArn),
      Handler: {
        physicalId: 'fn-x',
        resourceType: 'AWS::Lambda::Function',
        properties: {},
        observedProperties: { Role: { 'Fn::GetAtt': ['HandlerRole', 'Arn'] } },
        attributes: {},
        dependencies: [],
      },
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBe(siblingArn);
  });

  it('properties.Role takes precedence over observedProperties.Role', () => {
    const observedOnlyArn = 'arn:aws:iam::123456789012:role/observed-only';
    const state = stack({
      Handler: makeLambda('fn-x', explicitArn, observedOnlyArn),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBe(explicitArn);
  });

  it('resolves Ref: <RoleId> by looking up sibling Role.attributes.Arn', () => {
    // CDK rarely emits a bare Ref for Lambda Role (Fn::GetAtt is the norm),
    // but the resolver's helper accepts Ref shapes too — verify the wiring.
    const state = stack({
      HandlerRole: makeRole('MyStack-HandlerRole', siblingArn),
      Handler: makeLambda('fn-x', { Ref: 'HandlerRole' }),
    });
    expect(resolveExecutionRoleArnFromState(state, 'Handler')).toBe(siblingArn);
  });
});
