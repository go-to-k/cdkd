import { describe, it, expect } from 'vite-plus/test';
import {
  inferCrossStackStackDeps,
  type CrossStackScanStack,
} from '../../../src/analyzer/cross-stack-deps.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

/**
 * Cross-stack ordering inference: derive consumer → producer edges from raw
 * `Fn::ImportValue` (literal export name) / `Fn::GetStackOutput` (StackName)
 * references that CDK's manifest dependency graph does not capture.
 */

function stack(stackName: string, template: Partial<CloudFormationTemplate>): CrossStackScanStack {
  return {
    stackName,
    template: { Resources: {}, ...template } as CloudFormationTemplate,
  };
}

describe('inferCrossStackStackDeps', () => {
  it('adds an edge for Fn::ImportValue matching another stack export name', () => {
    const producer = stack('Producer', {
      Resources: { Bucket: { Type: 'AWS::S3::Bucket' } },
      Outputs: { Out: { Value: 'x', Export: { Name: 'My-Export' } } },
    });
    const consumer = stack('Consumer', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: { Variables: { DEP: { 'Fn::ImportValue': 'My-Export' } } },
          },
        },
      },
    });

    const deps = inferCrossStackStackDeps([producer, consumer]);
    expect([...(deps.get('Consumer') ?? [])]).toEqual(['Producer']);
    expect([...(deps.get('Producer') ?? [])]).toEqual([]);
  });

  it('adds an edge for Fn::GetStackOutput targeting another stack by name', () => {
    const producer = stack('Producer', {
      Resources: { T: { Type: 'AWS::DynamoDB::Table' } },
    });
    const consumer = stack('Consumer', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: {
              Variables: {
                DEP: { 'Fn::GetStackOutput': { StackName: 'Producer', OutputName: 'TableName' } },
              },
            },
          },
        },
      },
    });

    const deps = inferCrossStackStackDeps([producer, consumer]);
    expect([...(deps.get('Consumer') ?? [])]).toEqual(['Producer']);
  });

  it('does NOT add an edge when the producer is not in the input set', () => {
    // Consumer imports an export no stack in the set produces (external /
    // pre-existing export) — must resolve from runtime state, no ordering edge.
    const consumer = stack('Consumer', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Tags: [{ Value: { 'Fn::ImportValue': 'External-Export' } }] },
        },
      },
    });

    const deps = inferCrossStackStackDeps([consumer]);
    expect([...(deps.get('Consumer') ?? [])]).toEqual([]);
  });

  it('does NOT add an edge for Fn::GetStackOutput naming a stack outside the set', () => {
    const consumer = stack('Consumer', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            Environment: {
              Variables: {
                DEP: { 'Fn::GetStackOutput': { StackName: 'OtherApp', OutputName: 'X' } },
              },
            },
          },
        },
      },
    });

    const deps = inferCrossStackStackDeps([consumer]);
    expect([...(deps.get('Consumer') ?? [])]).toEqual([]);
  });

  it('does NOT crash and adds no edge for a non-literal Fn::ImportValue arg', () => {
    const producer = stack('Producer', {
      Outputs: { Out: { Value: 'x', Export: { Name: 'My-Export' } } },
    });
    const consumer = stack('Consumer', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            // Nested intrinsic, not a literal export name — unresolvable here.
            Env: { 'Fn::ImportValue': { 'Fn::Sub': '${Foo}-Export' } },
          },
        },
      },
    });

    const deps = inferCrossStackStackDeps([producer, consumer]);
    expect([...(deps.get('Consumer') ?? [])]).toEqual([]);
  });

  it('does not add a self-edge when a stack imports its own export', () => {
    const s = stack('Solo', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Env: { V: { 'Fn::ImportValue': 'Solo-Export' } } },
        },
      },
      Outputs: { Out: { Value: 'x', Export: { Name: 'Solo-Export' } } },
    });

    const deps = inferCrossStackStackDeps([s]);
    expect([...(deps.get('Solo') ?? [])]).toEqual([]);
  });

  it('resolves a 3-stack chain A <- B <- C with correct per-stack edges', () => {
    // A produces ExportA; B imports ExportA and produces ExportB; C imports ExportB.
    const a = stack('A', {
      Outputs: { O: { Value: 'a', Export: { Name: 'ExportA' } } },
    });
    const b = stack('B', {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { V: { 'Fn::ImportValue': 'ExportA' } } },
      },
      Outputs: { O: { Value: 'b', Export: { Name: 'ExportB' } } },
    });
    const c = stack('C', {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { V: { 'Fn::ImportValue': 'ExportB' } } },
      },
    });

    const deps = inferCrossStackStackDeps([a, b, c]);
    expect([...(deps.get('A') ?? [])]).toEqual([]);
    expect([...(deps.get('B') ?? [])]).toEqual(['A']);
    expect([...(deps.get('C') ?? [])]).toEqual(['B']);
  });

  it('handles a stack with multiple distinct producers', () => {
    const p1 = stack('P1', { Outputs: { O: { Value: '1', Export: { Name: 'E1' } } } });
    const p2 = stack('P2', { Outputs: { O: { Value: '2', Export: { Name: 'E2' } } } });
    const consumer = stack('C', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            A: { 'Fn::ImportValue': 'E1' },
            B: { 'Fn::GetStackOutput': { StackName: 'P2', OutputName: 'X' } },
          },
        },
      },
    });

    const deps = inferCrossStackStackDeps([p1, p2, consumer]);
    expect([...(deps.get('C') ?? [])].sort()).toEqual(['P1', 'P2']);
  });

  it('returns an empty-set entry for every stack with no cross-stack refs', () => {
    const a = stack('A', { Resources: { R: { Type: 'AWS::S3::Bucket' } } });
    const b = stack('B', { Resources: { R: { Type: 'AWS::SQS::Queue' } } });
    const deps = inferCrossStackStackDeps([a, b]);
    expect(deps.get('A')?.size).toBe(0);
    expect(deps.get('B')?.size).toBe(0);
  });

  describe('opts.kinds filtering (issue #751 weak-vs-strong split)', () => {
    // Producer reachable via BOTH a strong ImportValue export AND a weak
    // GetStackOutput reference, plus a second producer reachable ONLY via a
    // weak GetStackOutput. The default (both kinds) sees both; the
    // strong-only set used for deploy-closure expansion must see only the
    // ImportValue producer.
    const strongProducer = stack('StrongProducer', {
      Outputs: { O: { Value: 'x', Export: { Name: 'Strong-Export' } } },
    });
    const weakProducer = stack('WeakProducer', {
      Resources: { T: { Type: 'AWS::DynamoDB::Table' } },
    });
    const consumer = stack('Consumer', {
      Resources: {
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: {
            STRONG: { 'Fn::ImportValue': 'Strong-Export' },
            WEAK: { 'Fn::GetStackOutput': { StackName: 'WeakProducer', OutputName: 'TableName' } },
          },
        },
      },
    });

    it('default (no opts) returns BOTH strong and weak producers', () => {
      const deps = inferCrossStackStackDeps([strongProducer, weakProducer, consumer]);
      expect([...(deps.get('Consumer') ?? [])].sort()).toEqual(['StrongProducer', 'WeakProducer']);
    });

    it("kinds: ['ImportValue'] returns ONLY the strong (ImportValue) producer", () => {
      const deps = inferCrossStackStackDeps([strongProducer, weakProducer, consumer], {
        kinds: ['ImportValue'],
      });
      // The weak GetStackOutput producer must be excluded — deploying the
      // consumer must not drag WeakProducer into the deploy closure.
      expect([...(deps.get('Consumer') ?? [])]).toEqual(['StrongProducer']);
    });

    it("kinds: ['GetStackOutput'] returns ONLY the weak (GetStackOutput) producer", () => {
      const deps = inferCrossStackStackDeps([strongProducer, weakProducer, consumer], {
        kinds: ['GetStackOutput'],
      });
      expect([...(deps.get('Consumer') ?? [])]).toEqual(['WeakProducer']);
    });
  });

  it('ignores Export.Name produced by the consumer itself when matching a sibling import', () => {
    // Two stacks each importing the OTHER's export — mutual edges (a cycle the
    // deploy DAG would later reject, but the inference itself must still report
    // both directions accurately, not silently drop one).
    const a = stack('A', {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { V: { 'Fn::ImportValue': 'ExportB' } } },
      },
      Outputs: { O: { Value: 'a', Export: { Name: 'ExportA' } } },
    });
    const b = stack('B', {
      Resources: {
        Fn: { Type: 'AWS::Lambda::Function', Properties: { V: { 'Fn::ImportValue': 'ExportA' } } },
      },
      Outputs: { O: { Value: 'b', Export: { Name: 'ExportB' } } },
    });

    const deps = inferCrossStackStackDeps([a, b]);
    expect([...(deps.get('A') ?? [])]).toEqual(['B']);
    expect([...(deps.get('B') ?? [])]).toEqual(['A']);
  });
});
