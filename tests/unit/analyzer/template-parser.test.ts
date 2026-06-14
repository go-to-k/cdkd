import { describe, it, expect } from 'vite-plus/test';
import { TemplateParser } from '../../../src/analyzer/template-parser.js';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate, TemplateResource } from '../../../src/types/resource.js';

/**
 * Dependency extraction for the composite intrinsics CDK uses to construct
 * ARNs and similar derived values: `Fn::Join`, `Fn::Select`, `Fn::Split`.
 *
 * CDK emits these (especially `Fn::Join`) whenever the construct synthesizes
 * a value built from a sibling resource's `Ref` / `Fn::GetAtt`. The canonical
 * synth shape verified against a real CDK app on 2026-05-12 is:
 *
 *   DynamoDB `table.tableArn` used as an IAM Policy Resource:
 *     {Fn::Join: [':', ['arn', 'aws', 'dynamodb', {Ref:'AWS::Region'},
 *                       {Ref:'AWS::AccountId'},
 *                       {Fn::Join: ['/', ['table', {Ref:'MyTable794EDED1'}]]}]]}
 *
 *   `Fn::Select`+`Fn::Split` for extracting the table name from the ARN:
 *     {Fn::Select: [5, {Fn::Split: [':', {Fn::GetAtt: ['MyTable794EDED1','Arn']}]}]}
 *
 * The buried `Ref: 'MyTable...'` / `Fn::GetAtt` MUST produce a DAG edge from
 * the consumer to the table; otherwise deploy races and the consumer's CREATE
 * fires before the table exists. Same class of bug as #275 (`Fn::Sub` 1-arg
 * implicit Ref), this time for the array-argument intrinsics — see #286.
 */
describe('TemplateParser.extractDependencies', () => {
  const parser = new TemplateParser();

  describe('Fn::Join', () => {
    it('detects a Ref buried inside the items array', () => {
      const resource: TemplateResource = {
        Type: 'AWS::IAM::Role',
        Properties: {
          Tag: { 'Fn::Join': ['-', ['prefix', { Ref: 'DependencyLogical' }]] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('DependencyLogical')).toBe(true);
    });

    it('detects a Fn::GetAtt buried inside the items array', () => {
      const resource: TemplateResource = {
        Type: 'AWS::IAM::Role',
        Properties: {
          Tag: {
            'Fn::Join': ['-', ['prefix', { 'Fn::GetAtt': ['MyBucket', 'Arn'] }]],
          },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('MyBucket')).toBe(true);
    });

    it('detects refs in the canonical DynamoDB tableArn shape (nested Fn::Join)', () => {
      // Exact shape verified via `cdk synth` on 2026-05-12: a DynamoDB
      // Table's tableArn used as an IAM Policy Resource synthesizes as a
      // nested Fn::Join chain with embedded Refs.
      const resource: TemplateResource = {
        Type: 'AWS::IAM::Role',
        Properties: {
          Policies: [
            {
              PolicyName: 'AccessPolicy',
              PolicyDocument: {
                Statement: [
                  {
                    Action: 'dynamodb:GetItem',
                    Effect: 'Allow',
                    Resource: {
                      'Fn::Join': [
                        ':',
                        [
                          'arn:aws:dynamodb',
                          { Ref: 'AWS::Region' },
                          { Ref: 'AWS::AccountId' },
                          {
                            'Fn::Join': [
                              '/',
                              ['table', { Ref: 'MyTable794EDED1' }],
                            ],
                          },
                        ],
                      ],
                    },
                  },
                ],
              },
            },
          ],
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('MyTable794EDED1')).toBe(true);
      // Pseudo parameters (AWS::Region / AWS::AccountId) must NOT show up.
      expect(deps.has('AWS::Region')).toBe(false);
      expect(deps.has('AWS::AccountId')).toBe(false);
    });

    it('ignores the delimiter (Fn::Join[0])', () => {
      // Defensive: if somebody puts a Ref-shaped object as the delimiter
      // (technically invalid CFn) we still ignore it — only the items
      // array contributes deps. The delimiter is always a literal string
      // in real synth output.
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: { 'Fn::Join': [':', ['static', { Ref: 'OnlyThisOne' }]] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('OnlyThisOne')).toBe(true);
      expect(deps.size).toBe(1);
    });
  });

  describe('Fn::Select', () => {
    it('detects a Fn::GetAtt in the canonical Fn::Select+Fn::Split+Fn::GetAtt shape', () => {
      // Exact shape verified via `cdk synth`: extracting the table name
      // from a DynamoDB ARN.
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: {
            'Fn::Select': [
              5,
              { 'Fn::Split': [':', { 'Fn::GetAtt': ['MyTable794EDED1', 'Arn'] }] },
            ],
          },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('MyTable794EDED1')).toBe(true);
    });

    it('detects a Ref in the array argument', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: { 'Fn::Select': [0, { Ref: 'MyList' }] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('MyList')).toBe(true);
    });
  });

  describe('Fn::Split', () => {
    it('detects a Ref in the source argument', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: { 'Fn::Split': [',', { Ref: 'CommaSeparated' }] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('CommaSeparated')).toBe(true);
    });

    it('detects a Fn::GetAtt in the source argument', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: { 'Fn::Split': [':', { 'Fn::GetAtt': ['MyResource', 'SomeAttr'] }] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('MyResource')).toBe(true);
    });
  });

  describe('pseudo-parameter filtering', () => {
    it('does NOT add a Ref to AWS::Region inside a Fn::Join', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: { 'Fn::Join': ['/', [{ Ref: 'AWS::Region' }, 'foo']] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('AWS::Region')).toBe(false);
      expect(deps.size).toBe(0);
    });

    it('does NOT add a Ref to AWS::AccountId inside a Fn::Select+Fn::Split', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: {
            'Fn::Select': [
              0,
              { 'Fn::Split': [':', { Ref: 'AWS::AccountId' }] },
            ],
          },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('AWS::AccountId')).toBe(false);
      expect(deps.size).toBe(0);
    });
  });

  describe('composition with Fn::Sub (#276)', () => {
    it('detects a Ref buried inside a Fn::Join nested in a Fn::Sub variable map', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          R: {
            'Fn::Sub': [
              'arn:${BucketName}/foo',
              {
                BucketName: {
                  'Fn::Join': ['-', [{ Ref: 'PartA' }, 'static']],
                },
              },
            ],
          },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('PartA')).toBe(true);
    });

    it('detects an implicit Fn::Sub 1-arg Ref AND a sibling buried Ref via Fn::Join', () => {
      // Mixed: the Fn::Sub 1-arg implicit Ref support from #276 must still
      // work alongside the new explicit Fn::Join descent.
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          A: { 'Fn::Sub': 'arn:${ImplicitDep}/foo' },
          B: { 'Fn::Join': ['-', ['static', { Ref: 'ExplicitDep' }]] },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('ImplicitDep')).toBe(true);
      expect(deps.has('ExplicitDep')).toBe(true);
    });
  });

  describe('Fn::Sub ${!Literal} escape', () => {
    // `${!X}` is a CloudFormation literal escape (renders as `${X}`), NOT a
    // reference, so it must not contribute a phantom DependsOn / Ref edge.
    it('does not extract a dependency for a bare ${!X} escape', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          A: { 'Fn::Sub': 'before-${!NotAVar}-after' },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('NotAVar')).toBe(false);
      expect(deps.has('!NotAVar')).toBe(false);
      expect(deps.size).toBe(0);
    });

    it('extracts the real ref but skips the escaped token in a mixed body', () => {
      const resource: TemplateResource = {
        Type: 'AWS::Test',
        Properties: {
          A: { 'Fn::Sub': 'pre-${RealDep}-${!Lit}-post' },
        },
      };
      const deps = parser.extractDependencies(resource);
      expect(deps.has('RealDep')).toBe(true);
      expect(deps.has('Lit')).toBe(false);
      expect(deps.has('!Lit')).toBe(false);
    });
  });

  describe('DAG integration', () => {
    it('DagBuilder produces a Bucket -> Role edge for a Fn::Join-buried Ref', () => {
      // End-to-end: the new explicit descent must propagate through
      // DagBuilder.extractDependencies into a real graph edge.
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {
              Tag: {
                'Fn::Join': ['-', ['prefix', { Ref: 'Bucket' }]],
              },
            },
          },
        },
      };
      const dagBuilder = new DagBuilder();
      const graph = dagBuilder.buildGraph(template);
      expect(graph.hasEdge('Bucket', 'Role')).toBe(true);
    });

    it('DagBuilder produces a Table -> Consumer edge for a Fn::Select+Split+GetAtt chain', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Table: {
            Type: 'AWS::DynamoDB::Table',
            Properties: {},
          },
          Consumer: {
            Type: 'AWS::Test',
            Properties: {
              R: {
                'Fn::Select': [
                  5,
                  { 'Fn::Split': [':', { 'Fn::GetAtt': ['Table', 'Arn'] }] },
                ],
              },
            },
          },
        },
      };
      const dagBuilder = new DagBuilder();
      const graph = dagBuilder.buildGraph(template);
      expect(graph.hasEdge('Table', 'Consumer')).toBe(true);
    });
  });
});

/**
 * Resource-level `Condition:` filtering (issue #840).
 *
 * CFn keeps condition-gated resources in `Resources` at synth time (CDK emits
 * them with a `Condition:` key regardless of the condition's value); the deploy
 * engine excludes them when the condition is false. `filterResourcesByCondition`
 * is the prune step cdkd runs after evaluating the `Conditions` section so the
 * rest of the pipeline (diff included) sees the CFn-effective resource set.
 */
describe('TemplateParser.filterResourcesByCondition', () => {
  const parser = new TemplateParser();

  const baseTemplate = (): CloudFormationTemplate => ({
    Conditions: { IsPremium: { 'Fn::Equals': [{ Ref: 'Tier' }, 'premium'] } },
    Resources: {
      AlwaysParam: { Type: 'AWS::SSM::Parameter', Properties: { Value: 'always' } },
      PremiumOnlyParam: {
        Type: 'AWS::SSM::Parameter',
        Condition: 'IsPremium',
        Properties: { Value: 'premium-only' },
      },
    },
    Outputs: { Out: { Value: { Ref: 'AlwaysParam' } } },
  });

  it('removes a resource whose Condition evaluated false', () => {
    const result = parser.filterResourcesByCondition(baseTemplate(), { IsPremium: false });
    expect(Object.keys(result.Resources)).toEqual(['AlwaysParam']);
    expect(result.Resources.PremiumOnlyParam).toBeUndefined();
  });

  it('keeps a resource whose Condition evaluated true', () => {
    const result = parser.filterResourcesByCondition(baseTemplate(), { IsPremium: true });
    expect(Object.keys(result.Resources).sort()).toEqual(['AlwaysParam', 'PremiumOnlyParam']);
  });

  it('keeps resources with no Condition key regardless of the conditions map', () => {
    const result = parser.filterResourcesByCondition(baseTemplate(), { IsPremium: false });
    expect(result.Resources.AlwaysParam).toBeDefined();
  });

  it('keeps a resource whose Condition names an unknown / unevaluated condition', () => {
    // Defensive: an absent map entry is not `=== false`, so the resource is
    // kept rather than silently dropped (matches the deploy engine treating a
    // missing condition as "assume present" rather than "exclude").
    const result = parser.filterResourcesByCondition(baseTemplate(), {});
    expect(result.Resources.PremiumOnlyParam).toBeDefined();
  });

  it('preserves Conditions / Outputs and does not mutate the input template', () => {
    const input = baseTemplate();
    const result = parser.filterResourcesByCondition(input, { IsPremium: false });
    // Non-Resources sections carried over via spread.
    expect(result.Conditions).toBe(input.Conditions);
    expect(result.Outputs).toBe(input.Outputs);
    // Input untouched (callers reuse the raw template for outputs/labels).
    expect(Object.keys(input.Resources).sort()).toEqual(['AlwaysParam', 'PremiumOnlyParam']);
  });
});
