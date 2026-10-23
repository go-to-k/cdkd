import { describe, it, expect } from 'vite-plus/test';
import {
  inferCrossStackDepsByStack,
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

// go-to-k/cdkd#5176: two CDK Stages (one per region) share physical stack
// names, so a consumer name maps to several stacks and a producer is found by
// what it EXPORTS, not by its name.
describe('cross-stack inference over stacks sharing a name (#5176)', () => {
  const at = (
    stage: string,
    stackName: string,
    region: string,
    template: Partial<CloudFormationTemplate>
  ) => ({ ...stack(stackName, template), region, stagePath: stage });
  const exporting = (name: string) => ({
    Outputs: { O: { Value: 'v', Export: { Name: name } } },
  });
  const importing = (name: string) => ({
    Resources: { P: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::ImportValue': name } } } },
  });

  it('keeps every same-named consumer\'s producers (by name: their union)', () => {
    // Only UsEast's consumer imports raw; UsWest's has no reference.
    const eastProducer = at('UsEast', 'Producer', 'us-east-1', exporting('East:X'));
    const eastConsumer = at('UsEast', 'Consumer', 'us-east-1', importing('East:X'));
    const westConsumer = at('UsWest', 'Consumer', 'us-west-2', {});
    const stacks = [eastProducer, eastConsumer, westConsumer];

    const byStack = inferCrossStackDepsByStack(stacks);
    expect([...byStack.get(eastConsumer)!]).toEqual([eastProducer]);
    expect([...byStack.get(westConsumer)!]).toEqual([]);
    // Declared last, UsWest's empty set used to overwrite UsEast's.
    expect([...inferCrossStackStackDeps(stacks).get('Consumer')!]).toEqual(['Producer']);
  });

  it('binds an import to the stack that EXPORTS it, not a same-named stack in the Stage', () => {
    const eastProducer = at('UsEast', 'Producer', 'us-east-1', exporting('X'));
    const westProducer = at('UsWest', 'Producer', 'us-west-2', {});
    const westConsumer = at('UsWest', 'Consumer', 'us-west-2', importing('X'));
    const byStack = inferCrossStackDepsByStack([eastProducer, westProducer, westConsumer]);
    expect([...byStack.get(westConsumer)!]).toEqual([eastProducer]);
  });

  it("prefers the consumer's region among several exporters of one name", () => {
    const eastProducer = at('UsEast', 'Producer', 'us-east-1', exporting('X'));
    const westProducer = at('UsWest', 'Producer', 'us-west-2', exporting('X'));
    const westConsumer = at('UsWest', 'Consumer', 'us-west-2', importing('X'));
    const byStack = inferCrossStackDepsByStack([eastProducer, westProducer, westConsumer]);
    expect([...byStack.get(westConsumer)!]).toEqual([westProducer]);
  });

  it("honours Fn::GetStackOutput's Region, else the consumer's region", () => {
    const eastProducer = at('UsEast', 'Producer', 'us-east-1', {});
    const westProducer = at('UsWest', 'Producer', 'us-west-2', {});
    const read = (args: Record<string, string>) => ({
      Resources: {
        P: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::GetStackOutput': args } } },
      },
    });
    const crossRegion = at('UsWest', 'Consumer', 'us-west-2', read({ StackName: 'Producer', OutputName: 'O', Region: 'us-east-1' }));
    const local = at('UsWest', 'Reader', 'us-west-2', read({ StackName: 'Producer', OutputName: 'O' }));
    const byStack = inferCrossStackDepsByStack([eastProducer, westProducer, crossRegion, local]);
    expect([...byStack.get(crossRegion)!]).toEqual([eastProducer]);
    expect([...byStack.get(local)!]).toEqual([westProducer]);
  });

  const reading = (args: Record<string, string>) => ({
    Resources: {
      P: { Type: 'AWS::SSM::Parameter', Properties: { Value: { 'Fn::GetStackOutput': args } } },
    },
  });

  it('a literal Region also matches an env-agnostic producer of the name', () => {
    const agnostic = { ...stack('Producer', {}), stagePath: 'Any' };
    const consumer = at('UsWest', 'Consumer', 'us-west-2', reading({ StackName: 'Producer', OutputName: 'O', Region: 'us-east-1' }));
    expect([...inferCrossStackDepsByStack([agnostic, consumer]).get(consumer)!]).toEqual([agnostic]);
  });

  it("without a Region, prefers the consumer's region even outside its Stage", () => {
    const eastProducer = at('UsEast', 'Producer', 'us-east-1', {});
    const westProducer = at('UsWest', 'Producer', 'us-west-2', {});
    const consumer = at('Other', 'Consumer', 'us-west-2', reading({ StackName: 'Producer', OutputName: 'O' }));
    const byStack = inferCrossStackDepsByStack([eastProducer, westProducer, consumer]);
    expect([...byStack.get(consumer)!]).toEqual([westProducer]);
  });

  it("among same-region producers of the name, takes the consumer's own Stage", () => {
    const a = at('A', 'Producer', 'us-east-1', {});
    const b = at('B', 'Producer', 'us-east-1', {});
    const consumer = at('B', 'Consumer', 'us-east-1', reading({ StackName: 'Producer', OutputName: 'O' }));
    expect([...inferCrossStackDepsByStack([a, b, consumer]).get(consumer)!]).toEqual([b]);
  });

  it('never makes a name its own producer when same-named stacks import from each other', () => {
    const east = at('UsEast', 'Api', 'us-east-1', exporting('X'));
    const west = at('UsWest', 'Api', 'us-west-2', importing('X'));
    expect([...inferCrossStackStackDeps([east, west]).get('Api')!]).toEqual([]);
  });
});

