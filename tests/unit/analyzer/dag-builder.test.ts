import { describe, it, expect, beforeEach } from 'vitest';
import { DagBuilder } from '../../../src/analyzer/dag-builder.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import { DependencyError } from '../../../src/utils/error-handler.js';

describe('DagBuilder', () => {
  let dagBuilder: DagBuilder;

  beforeEach(() => {
    dagBuilder = new DagBuilder();
  });

  describe('buildGraph', () => {
    it('should build a graph with independent resources', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);

      expect(graph.nodeCount()).toBe(2);
      expect(graph.edgeCount()).toBe(0);
      expect(graph.hasNode('BucketA')).toBe(true);
      expect(graph.hasNode('BucketB')).toBe(true);
    });

    it('should build a graph with Ref dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {
              AssumeRolePolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Principal: {
                      Service: 'lambda.amazonaws.com',
                    },
                    Action: 'sts:AssumeRole',
                  },
                ],
              },
              Policies: [
                {
                  PolicyName: 'BucketAccess',
                  PolicyDocument: {
                    Statement: [
                      {
                        Effect: 'Allow',
                        Action: 's3:GetObject',
                        Resource: {
                          'Fn::Sub': [
                            'arn:aws:s3:::${BucketName}/*',
                            {
                              BucketName: { Ref: 'Bucket' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                },
              ],
            },
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);

      expect(graph.nodeCount()).toBe(2);
      expect(graph.edgeCount()).toBe(1);
      expect(graph.hasEdge('Bucket', 'Role')).toBe(true);
    });

    it('should build a graph with Fn::GetAtt dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Policy: {
            Type: 'AWS::IAM::Policy',
            Properties: {
              PolicyName: 'BucketArnPolicy',
              PolicyDocument: {
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: 's3:GetObject',
                    Resource: {
                      'Fn::GetAtt': ['Bucket', 'Arn'],
                    },
                  },
                ],
              },
            },
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);

      expect(graph.nodeCount()).toBe(2);
      expect(graph.edgeCount()).toBe(1);
      expect(graph.hasEdge('Bucket', 'Policy')).toBe(true);
    });

    it('should build a graph with DependsOn dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            DependsOn: 'BucketA',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);

      expect(graph.nodeCount()).toBe(2);
      expect(graph.edgeCount()).toBe(1);
      expect(graph.hasEdge('BucketA', 'BucketB')).toBe(true);
    });

    it('should build a graph with multiple DependsOn dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketC: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            DependsOn: ['BucketA', 'BucketB'],
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);

      expect(graph.nodeCount()).toBe(3);
      expect(graph.edgeCount()).toBe(2);
      expect(graph.hasEdge('BucketA', 'BucketC')).toBe(true);
      expect(graph.hasEdge('BucketB', 'BucketC')).toBe(true);
    });

    it('should detect circular dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          ResourceA: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { Ref: 'ResourceB' },
            },
          },
          ResourceB: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { Ref: 'ResourceA' },
            },
          },
        },
      };

      try {
        dagBuilder.buildGraph(template);
        expect.fail('Should have thrown DependencyError');
      } catch (error) {
        expect(error).toBeInstanceOf(DependencyError);
        expect((error as Error).message).toMatch(/Circular dependency detected/);
      }
    });

    it('should warn about missing dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {
              BucketName: { Ref: 'NonExistentResource' },
            },
          },
        },
      };

      // Should not throw, but build graph with available resources
      const graph = dagBuilder.buildGraph(template);
      expect(graph.nodeCount()).toBe(1);
      expect(graph.edgeCount()).toBe(0);
    });
  });

  describe('getExecutionLevels', () => {
    it('should return single level for independent resources', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const levels = dagBuilder.getExecutionLevels(graph);

      expect(levels.length).toBe(1);
      expect(levels[0]).toHaveLength(2);
      expect(levels[0]).toContain('BucketA');
      expect(levels[0]).toContain('BucketB');
    });

    it('should return multiple levels for dependent resources', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'Bucket',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const levels = dagBuilder.getExecutionLevels(graph);

      expect(levels.length).toBe(2);
      expect(levels[0]).toEqual(['Bucket']);
      expect(levels[1]).toEqual(['Role']);
    });

    it('should return correct levels for complex dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          RoleA: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'BucketA',
          },
          RoleB: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'BucketB',
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {},
            DependsOn: ['RoleA', 'RoleB'],
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const levels = dagBuilder.getExecutionLevels(graph);

      expect(levels.length).toBe(3);
      expect(levels[0]).toHaveLength(2);
      expect(levels[0]).toContain('BucketA');
      expect(levels[0]).toContain('BucketB');
      expect(levels[1]).toHaveLength(2);
      expect(levels[1]).toContain('RoleA');
      expect(levels[1]).toContain('RoleB');
      expect(levels[2]).toEqual(['Function']);
    });
  });

  describe('getAllDependencies', () => {
    it('should return empty set for resource with no dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const deps = dagBuilder.getAllDependencies(graph, 'Bucket');

      expect(deps.size).toBe(0);
    });

    it('should return direct dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'Bucket',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const deps = dagBuilder.getAllDependencies(graph, 'Role');

      expect(deps.size).toBe(1);
      expect(deps.has('Bucket')).toBe(true);
    });

    it('should return transitive dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            DependsOn: 'BucketA',
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'BucketB',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const deps = dagBuilder.getAllDependencies(graph, 'Role');

      expect(deps.size).toBe(2);
      expect(deps.has('BucketA')).toBe(true);
      expect(deps.has('BucketB')).toBe(true);
    });
  });

  describe('getAllDependents', () => {
    it('should return empty set for resource with no dependents', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const dependents = dagBuilder.getAllDependents(graph, 'Bucket');

      expect(dependents.size).toBe(0);
    });

    it('should return direct dependents', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'Bucket',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const dependents = dagBuilder.getAllDependents(graph, 'Bucket');

      expect(dependents.size).toBe(1);
      expect(dependents.has('Role')).toBe(true);
    });

    it('should return transitive dependents', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'Bucket',
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {},
            DependsOn: 'Role',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const dependents = dagBuilder.getAllDependents(graph, 'Bucket');

      expect(dependents.size).toBe(2);
      expect(dependents.has('Role')).toBe(true);
      expect(dependents.has('Function')).toBe(true);
    });
  });

  describe('dependsOn', () => {
    it('should return false for independent resources', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const result = dagBuilder.dependsOn(graph, 'BucketA', 'BucketB');

      expect(result).toBe(false);
    });

    it('should return true for direct dependency', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'Bucket',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const result = dagBuilder.dependsOn(graph, 'Role', 'Bucket');

      expect(result).toBe(true);
    });

    it('should return true for transitive dependency', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            DependsOn: 'BucketA',
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'BucketB',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const result = dagBuilder.dependsOn(graph, 'Role', 'BucketA');

      expect(result).toBe(true);
    });
  });

  describe('getDirectDependencies', () => {
    it('should return empty array for resource with no dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const deps = dagBuilder.getDirectDependencies(graph, 'Bucket');

      expect(deps).toEqual([]);
    });

    it('should return only direct dependencies', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          BucketA: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          BucketB: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
            DependsOn: 'BucketA',
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'BucketB',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const deps = dagBuilder.getDirectDependencies(graph, 'Role');

      expect(deps).toHaveLength(1);
      expect(deps).toContain('BucketB');
      expect(deps).not.toContain('BucketA');
    });
  });

  describe('getDirectDependents', () => {
    it('should return empty array for resource with no dependents', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const dependents = dagBuilder.getDirectDependents(graph, 'Bucket');

      expect(dependents).toEqual([]);
    });

    it('should return only direct dependents', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Bucket: {
            Type: 'AWS::S3::Bucket',
            Properties: {},
          },
          Role: {
            Type: 'AWS::IAM::Role',
            Properties: {},
            DependsOn: 'Bucket',
          },
          Function: {
            Type: 'AWS::Lambda::Function',
            Properties: {},
            DependsOn: 'Role',
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      const dependents = dagBuilder.getDirectDependents(graph, 'Bucket');

      expect(dependents).toHaveLength(1);
      expect(dependents).toContain('Role');
      expect(dependents).not.toContain('Function');
    });
  });

  describe('custom resource implicit policy dependencies', () => {
    // A Custom Resource only Ref's its ServiceToken Lambda, so without this
    // implicit edge the Lambda's inline AWS::IAM::Policy can be in the same
    // execution level as the Custom Resource — letting the handler invoke
    // before the policy attachment API returns (AccessDenied race).
    const buildCustomResourceTemplate = (
      overrides: Partial<CloudFormationTemplate['Resources']> = {}
    ): CloudFormationTemplate => ({
      Resources: {
        SeederRole: {
          Type: 'AWS::IAM::Role',
          Properties: {},
        },
        SeederRoleDefaultPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            Roles: [{ Ref: 'SeederRole' }],
            PolicyDocument: {},
          },
        },
        SeederFunction: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Role: { 'Fn::GetAtt': ['SeederRole', 'Arn'] },
          },
        },
        SeederCustomResource: {
          Type: 'Custom::Seeder',
          Properties: {
            ServiceToken: { 'Fn::GetAtt': ['SeederFunction', 'Arn'] },
          },
        },
        ...overrides,
      },
    });

    it('adds an implicit edge from Lambda role policy to Custom Resource', () => {
      const template = buildCustomResourceTemplate();
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SeederCustomResource');
      expect(deps).toContain('SeederRoleDefaultPolicy');
      expect(deps).toContain('SeederFunction');
    });

    it('places Custom Resource in a later execution level than role policy', () => {
      const template = buildCustomResourceTemplate();
      const graph = dagBuilder.buildGraph(template);
      const levels = dagBuilder.getExecutionLevels(graph);

      const levelOf = (id: string): number => levels.findIndex((lvl) => lvl.includes(id));
      expect(levelOf('SeederRoleDefaultPolicy')).toBeGreaterThanOrEqual(0);
      expect(levelOf('SeederCustomResource')).toBeGreaterThan(levelOf('SeederRoleDefaultPolicy'));
    });

    it('supports AWS::CloudFormation::CustomResource type', () => {
      const template = buildCustomResourceTemplate({
        SeederCustomResource: {
          Type: 'AWS::CloudFormation::CustomResource',
          Properties: {
            ServiceToken: { 'Fn::GetAtt': ['SeederFunction', 'Arn'] },
          },
        },
      });
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SeederCustomResource');
      expect(deps).toContain('SeederRoleDefaultPolicy');
    });

    it('supports AWS::IAM::ManagedPolicy attached via Roles', () => {
      const template = buildCustomResourceTemplate({
        SeederRoleDefaultPolicy: {
          Type: 'AWS::IAM::ManagedPolicy',
          Properties: {
            Roles: [{ Ref: 'SeederRole' }],
            PolicyDocument: {},
          },
        },
      });
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SeederCustomResource');
      expect(deps).toContain('SeederRoleDefaultPolicy');
    });

    it('supports AWS::IAM::RolePolicy attached via RoleName', () => {
      const template = buildCustomResourceTemplate({
        SeederRoleDefaultPolicy: {
          Type: 'AWS::IAM::RolePolicy',
          Properties: {
            RoleName: { Ref: 'SeederRole' },
            PolicyDocument: {},
          },
        },
      });
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SeederCustomResource');
      expect(deps).toContain('SeederRoleDefaultPolicy');
    });

    it('does not add edges from policies attached to unrelated roles', () => {
      const template = buildCustomResourceTemplate({
        OtherRole: {
          Type: 'AWS::IAM::Role',
          Properties: {},
        },
        OtherPolicy: {
          Type: 'AWS::IAM::Policy',
          Properties: {
            Roles: [{ Ref: 'OtherRole' }],
            PolicyDocument: {},
          },
        },
      });
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SeederCustomResource');
      expect(deps).not.toContain('OtherPolicy');
    });

    it('skips when ServiceToken is not a Lambda (SNS-backed custom resource)', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Topic: {
            Type: 'AWS::SNS::Topic',
            Properties: {},
          },
          SomeRole: {
            Type: 'AWS::IAM::Role',
            Properties: {},
          },
          SomePolicy: {
            Type: 'AWS::IAM::Policy',
            Properties: {
              Roles: [{ Ref: 'SomeRole' }],
              PolicyDocument: {},
            },
          },
          SnsBackedCustomResource: {
            Type: 'Custom::Sns',
            Properties: {
              ServiceToken: { Ref: 'Topic' },
            },
          },
        },
      };
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SnsBackedCustomResource');
      expect(deps).not.toContain('SomePolicy');
    });

    it('is idempotent when policy already has an explicit edge', () => {
      const template = buildCustomResourceTemplate({
        SeederCustomResource: {
          Type: 'Custom::Seeder',
          Properties: {
            ServiceToken: { 'Fn::GetAtt': ['SeederFunction', 'Arn'] },
          },
          DependsOn: 'SeederRoleDefaultPolicy',
        },
      });
      const graph = dagBuilder.buildGraph(template);

      const deps = dagBuilder.getDirectDependencies(graph, 'SeederCustomResource');
      // Explicit DependsOn + implicit edge must not produce duplicates
      expect(deps.filter((d) => d === 'SeederRoleDefaultPolicy')).toHaveLength(1);
    });
  });

  describe('addLambdaVpcEdges', () => {
    it('adds Subnet -> Lambda and SecurityGroup -> Lambda edges from VpcConfig', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          SubnetA: { Type: 'AWS::EC2::Subnet', Properties: {} },
          SgA: { Type: 'AWS::EC2::SecurityGroup', Properties: {} },
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              VpcConfig: {
                SubnetIds: [{ Ref: 'SubnetA' }],
                SecurityGroupIds: [{ Ref: 'SgA' }],
              },
            },
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);

      expect(graph.hasEdge('SubnetA', 'Fn')).toBe(true);
      expect(graph.hasEdge('SgA', 'Fn')).toBe(true);

      // Lambda must come after Subnet/SG in execution order, which means
      // for the reversed deletion traversal Lambda is removed BEFORE
      // Subnet/SG — exactly what we need to wait for ENI detach.
      const lambdaDeps = dagBuilder.getDirectDependencies(graph, 'Fn');
      expect(lambdaDeps).toContain('SubnetA');
      expect(lambdaDeps).toContain('SgA');
    });

    it('does not duplicate edges already added by Ref extraction', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          SubnetA: { Type: 'AWS::EC2::Subnet', Properties: {} },
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: {
              VpcConfig: { SubnetIds: [{ Ref: 'SubnetA' }] },
            },
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      // Only one edge from SubnetA to Fn (Ref extraction + implicit pass
      // converge on the same edge, no double-count).
      const subnetSuccessors = graph.successors('SubnetA') ?? [];
      expect(subnetSuccessors.filter((id) => id === 'Fn')).toHaveLength(1);
    });

    it('is a no-op for Lambda without VpcConfig', () => {
      const template: CloudFormationTemplate = {
        Resources: {
          Role: { Type: 'AWS::IAM::Role', Properties: {} },
          Fn: {
            Type: 'AWS::Lambda::Function',
            Properties: { Role: { 'Fn::GetAtt': ['Role', 'Arn'] } },
          },
        },
      };

      const graph = dagBuilder.buildGraph(template);
      // Only the Role -> Fn edge from Fn::GetAtt; no VPC-related edges.
      expect(graph.edgeCount()).toBe(1);
      expect(graph.hasEdge('Role', 'Fn')).toBe(true);
    });
  });
});
