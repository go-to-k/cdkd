/**
 * go-to-k/cdkd#5181: `--from-state` over two served stacks that reuse a
 * Lambda logical id loads BOTH stacks' state, so each container's env is
 * substituted from its own stack. Before the change the walk stopped at the
 * first stack declaring the id.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

const stateSource = vi.hoisted(() => ({ createLocalStateProvider: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-source.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createLocalStateProvider: stateSource.createLocalStateProvider,
}));

import { loadStateForRoutedStacks } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';
import type { DiscoveredRoute } from '../../../src/local/route-discovery.js';

function stack(stackName: string): StackInfo {
  return {
    stackName,
    displayName: stackName,
    region: 'us-east-1',
    template: {
      Resources: {
        Handler: {
          Type: 'AWS::Lambda::Function',
          Properties: { Runtime: 'nodejs20.x', Handler: 'index.handler' },
        },
      },
    },
  } as unknown as StackInfo;
}

describe('loadStateForRoutedStacks over stacks reusing a Lambda id (#5181)', () => {
  it("loads each routed stack's own state", async () => {
    const loaded: string[] = [];
    stateSource.createLocalStateProvider.mockImplementation(() => ({
      label: '--from-state',
      load: vi.fn(async (name: string) => {
        loaded.push(name);
        return { region: 'us-east-1', resources: {}, outputs: {} };
      }),
      dispose: vi.fn(),
    }));
    const route = (apiStackName: string) =>
      ({ lambdaLogicalId: 'Handler', apiStackName }) as unknown as DiscoveredRoute;
    const bundles = await loadStateForRoutedStacks(
      [stack('SvcA'), stack('SvcB')],
      [route('SvcA'), route('SvcB')],
      [],
      { fromState: true } as never
    );
    expect(loaded.sort()).toEqual(['SvcA', 'SvcB']);
    expect([...bundles.keys()].sort()).toEqual(['SvcA', 'SvcB']);
  });
});
