import { describe, it, expect, vi } from 'vite-plus/test';

vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { getLogger: () => ({ ...child, child: () => child }) };
});

import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

// go-to-k/cdkd#6437 PR 3: under `--update-policy` (`updatePolicyReferences`),
// an `AWS::Lambda::Alias` depends on what its
// `UpdatePolicy.CodeDeployLambdaAliasUpdate` refers to; without it the graph
// is unchanged.

function template(type = 'AWS::Lambda::Alias', policyKey = 'CodeDeployLambdaAliasUpdate'): CloudFormationTemplate {
  return {
    Resources: {
      Fn: { Type: 'AWS::Lambda::Function', Properties: {} },
      App: { Type: 'AWS::CodeDeploy::Application', Properties: {} },
      Group: { Type: 'AWS::CodeDeploy::DeploymentGroup', Properties: { ApplicationName: { Ref: 'App' } } },
      Hook: { Type: 'AWS::Lambda::Function', Properties: {} },
      Alias: {
        Type: type,
        Properties: { FunctionName: { Ref: 'Fn' }, FunctionVersion: '1', Name: 'live' },
        UpdatePolicy: {
          [policyKey]: {
            ApplicationName: { Ref: 'App' },
            DeploymentGroupName: { Ref: 'Group' },
            BeforeAllowTrafficHook: { Ref: 'Hook' },
          },
        },
      },
    },
  };
}

const deps = (builder: DagBuilder, t: CloudFormationTemplate): string[] =>
  [...builder.getDirectDependencies(builder.buildGraph(t), 'Alias')].sort();

describe('DagBuilder updatePolicyReferences (go-to-k/cdkd#6437)', () => {
  it('adds the policy targets under the option', () => {
    expect(deps(new DagBuilder({ updatePolicyReferences: true }), template())).toEqual([
      'App',
      'Fn',
      'Group',
      'Hook',
    ]);
  });

  it('leaves the graph unchanged without it', () => {
    expect(deps(new DagBuilder(), template())).toEqual(['Fn']);
  });

  it.each([
    ['another type', template('AWS::Lambda::Version')],
    ['another policy key', template('AWS::Lambda::Alias', 'AutoScalingRollingUpdate')],
  ])('ignores %s', (_label, t) => {
    expect(deps(new DagBuilder({ updatePolicyReferences: true }), t)).toEqual(['Fn']);
  });
});
