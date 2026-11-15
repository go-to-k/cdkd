/**
 * go-to-k/cdkd#6357: a logical id of a CDK nested stack's resource reaches
 * that nested stack through the stack matcher, the run-task candidate picker,
 * the start-api target picker, the resolvers' not-found lists and the
 * `--from-cfn-stack` name / routed-stack count helpers.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

const stateSource = vi.hoisted(() => ({ createLocalStateProvider: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: stateSource.createLocalStateProvider,
}));

import { pickCandidateStack } from '../../../src/cli/commands/local-run-task/image-context.js';
import { loadStateForRoutedStacks, pickTargetStacks } from '../../../src/cli/commands/local-start-api.js';
import { withDeployedStackName } from '../../../src/cli/commands/local-state-source.js';
import { selectTargetStack } from '../../../src/cli/stack-matcher.js';
import { parseEcsTarget, resolveEcsTaskTarget } from '../../../src/local/ecs-task-resolver.js';
import { resolveLambdaTarget } from '../../../src/local/lambda-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

const origin = (parent: string, id: string) => ({
  parentStackName: parent,
  rootStackName: parent,
  logicalId: id,
  parameters: {},
});
const td = {
  Type: 'AWS::ECS::TaskDefinition',
  Properties: {
    Family: 'f',
    NetworkMode: 'bridge',
    ContainerDefinitions: [{ Name: 'a', Image: 'public.ecr.aws/nginx/nginx:alpine', PortMappings: [] }],
  },
};
const fn = {
  Type: 'AWS::Lambda::Function',
  Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler', Code: { ZipFile: 'x' } },
};
function mk(name: string, resources: Record<string, unknown>, nestedOf?: [string, string]): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: nestedOf ? nestedOf[0] : name,
    template: { Resources: resources },
    dependencyNames: [],
    ...(nestedOf ? { nestedStack: origin(nestedOf[0], nestedOf[1]) } : {}),
  } as unknown as StackInfo;
}
const parsedOf = (target: string) => parseEcsTarget(target);

describe('pickCandidateStack with nested stacks', () => {
  const app = mk('App', {});
  const child = mk('App~Inner', { ChildTD: td }, ['App', 'Inner']);
  it('picks the top-level stack for a bare id no stack owns', () => {
    expect(pickCandidateStack(parsedOf('TaskDef'), 'TaskDef', [app, child])).toBe(app);
  });
  it('picks the nested owner for App:<nested id>', () => {
    expect(pickCandidateStack(parsedOf('App:ChildTD'), 'App:ChildTD', [app, child])).toBe(child);
  });
  it('picks the nested owner for a bare nested id with one top-level stack', () => {
    expect(pickCandidateStack(parsedOf('ChildTD'), 'ChildTD', [app, child])).toBe(child);
  });
});

describe('selectTargetStack nested owner', () => {
  const parse = (id: string, stackPattern: string | null = 'App') => ({ stackPattern, pathOrId: id, isPath: false });
  const app = mk('App', { Both: fn, Top: fn });
  const a = mk('App~A', { Both: fn, OnlyA: fn, Dup: fn }, ['App', 'A']);
  const b = mk('App~B', { Dup: fn }, ['App', 'B']);
  const stacks = [app, a, b];
  const pick = (id: string, stackPattern: string | null = 'App') => {
    const s = selectTargetStack(parse(id, stackPattern), `App:${id}`, stacks);
    return s.kind === 'found' ? s.stack : undefined;
  };
  it('keeps the parent when it has the id (also in a nested stack)', () => {
    expect(pick('Both')).toBe(app);
  });
  it('keeps the parent when two nested stacks have the id', () => {
    expect(pick('Dup')).toBe(app);
  });
  it('picks the one nested stack that has the id', () => {
    expect(pick('OnlyA')).toBe(a);
  });
  it('leaves a StackLike without a template unchanged', () => {
    const bare = [
      { stackName: 'App', displayName: 'App' },
      { stackName: 'App~A', displayName: 'App/A', nestedStack: origin('App', 'A') },
    ];
    const s = selectTargetStack(parse('OnlyA'), 'App:OnlyA', bare as never);
    expect(s.kind === 'found' && s.stack).toBe(bare[0]);
  });
  it('does not apply to the path form', () => {
    const s = selectTargetStack({ stackPattern: 'App', pathOrId: 'OnlyA', isPath: true }, 'App/OnlyA', stacks);
    expect(s.kind === 'found' && s.stack).toBe(app);
  });
});

describe('pickTargetStacks targetFallback parent object', () => {
  it('yields the parent and its nested child', () => {
    const app = mk('App', {});
    const child = mk('App~Inner', {}, ['App', 'Inner']);
    expect(pickTargetStacks([app, child], undefined, undefined, app)).toEqual([app, child]);
  });
});

describe('resolvers list colliding nested logical ids by nested stack name', () => {
  // Own*: the parent's; Uniq*: one nested stack's; Same/TD: shared by two;
  // Mine*: the parent's id, copied in a nested stack.
  const app = mk('App', { OwnFn: fn, OwnTD: td, MineFn: fn, MineTD: td });
  const a = mk('App~A', { Same: fn, TD: td, UniqFn: fn, UniqTD: td, MineFn: fn, MineTD: td }, ['App', 'A']);
  const b = mk('App~B', { Same: fn, TD: td }, ['App', 'B']);
  // A bare ID as its own token, never as the tail of `<stack>:<id>`.
  const bare = (m: string, id: string): boolean => new RegExp(`(^|[^:\\w])${id}\\b`).test(m);
  const message = (f: () => unknown): string => {
    try {
      f();
    } catch (e) {
      return (e as Error).message;
    }
    return '';
  };
  it('lambda: logical-id miss lists nested resources, every shared copy as <nested>:<id>', () => {
    const m = message(() => resolveLambdaTarget('App:Nope', [app, a, b]));
    // Every copy two nested stacks share is qualified: a bare ID selects neither.
    expect(m).toContain('App~A:Same');
    expect(m).toContain('App~B:Same');
    expect(bare(m, 'Same')).toBe(false);
    // The parent's own ID and a unique nested ID stay bare (both select it).
    expect(bare(m, 'OwnFn')).toBe(true);
    expect(bare(m, 'UniqFn')).toBe(true);
    expect(m).not.toContain('App~A:UniqFn');
    // A nested copy of the parent's ID is qualified; the parent's stays bare.
    expect(bare(m, 'MineFn')).toBe(true);
    expect(m).toContain('App~A:MineFn');
  });
  it('ecs: logical-id miss lists nested resources, every shared copy as <nested>:<id>', () => {
    const m = message(() => resolveEcsTaskTarget('App:Nope', [app, a, b]));
    expect(m).toContain('App~A:TD');
    expect(m).toContain('App~B:TD');
    expect(bare(m, 'TD')).toBe(false);
    expect(bare(m, 'OwnTD')).toBe(true);
    expect(bare(m, 'UniqTD')).toBe(true);
    expect(m).not.toContain('App~A:UniqTD');
    expect(bare(m, 'MineTD')).toBe(true);
    expect(m).toContain('App~A:MineTD');
  });
});

describe('withDeployedStackName for nested names', () => {
  it('leaves stackName unset for a nested name under --from-cfn-stack', () => {
    expect(withDeployedStackName({}, { fromCfnStack: true }, 'App~Inner').stackName).toBeUndefined();
    expect(withDeployedStackName({}, { fromCfnStack: 'X' }, 'App~Inner').stackName).toBeUndefined();
  });
  it('keeps the record name for --from-state', () => {
    expect(withDeployedStackName({}, {}, 'App~Inner').stackName).toBe('App~Inner');
    expect(withDeployedStackName({}, { fromCfnStack: false }, 'App~Inner').stackName).toBe('App~Inner');
  });
  it('resolves a top-level name under --from-cfn-stack', () => {
    expect(withDeployedStackName({}, { fromCfnStack: 'X' }, 'App').stackName).toBe('X');
    expect(withDeployedStackName({}, { fromCfnStack: true }, 'App').stackName).toBe('App');
  });
});

describe('loadStateForRoutedStacks explicit --from-cfn-stack with nested stacks', () => {
  const route = (apiStackName: string) =>
    ({ lambdaLogicalId: 'Handler', apiStackName }) as unknown as DiscoveredRoute;
  const setup = () =>
    stateSource.createLocalStateProvider.mockImplementation(() => ({
      label: '--from-cfn-stack',
      load: vi.fn(async () => ({ region: 'us-east-1', resources: {}, outputs: {} })),
      dispose: vi.fn(),
    }));
  const handler = { Handler: fn };
  it('does not reject App and App~Inner', async () => {
    setup();
    await expect(
      loadStateForRoutedStacks(
        [mk('App', handler), mk('App~Inner', handler, ['App', 'Inner'])],
        [route('App'), route('App~Inner')],
        [],
        { fromCfnStack: 'X' } as never
      )
    ).resolves.toBeDefined();
  });
  it('still rejects two top-level stacks', async () => {
    setup();
    await expect(
      loadStateForRoutedStacks([mk('A', handler), mk('B', handler)], [route('A'), route('B')], [], {
        fromCfnStack: 'X',
      } as never)
    ).rejects.toThrow();
  });
});
