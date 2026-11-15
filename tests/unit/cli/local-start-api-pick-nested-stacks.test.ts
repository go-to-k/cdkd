import { describe, expect, it } from 'vite-plus/test';
import { pickTargetStacks } from '../../../src/cli/commands/local-start-api.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

function top(name: string): StackInfo {
  return { stackName: name, displayName: name, template: { Resources: {} } } as unknown as StackInfo;
}

function nested(parent: string, id: string, display: string): StackInfo {
  return {
    stackName: `${parent}~${id}`,
    displayName: display,
    template: { Resources: {} },
    nestedStack: { parentStackName: parent, rootStackName: parent, logicalId: id, parameters: {} },
  } as unknown as StackInfo;
}

describe('pickTargetStacks with CDK nested stacks', () => {
  const app = top('App');
  const child = nested('App', 'InnerNS', 'App/Inner');

  it('auto-picks the only top-level stack together with its nested stack', () => {
    expect(pickTargetStacks([app, child], undefined)).toEqual([app, child]);
  });

  it('--stack of the parent selects the parent and its nested stack', () => {
    expect(pickTargetStacks([app, child], 'App')).toEqual([app, child]);
  });

  it('--stack with a nested display path selects only the nested stack', () => {
    expect(pickTargetStacks([app, child], 'App/Inner')).toEqual([child]);
  });

  it('a targetFallback stack object yields that stack', () => {
    expect(pickTargetStacks([app, child], undefined, undefined, child)).toEqual([child]);
  });

  it('refuses a multi-stack app and lists only the top-level stacks', () => {
    const other = top('Other');
    let message = '';
    try {
      pickTargetStacks([app, other, child], undefined);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/Multi-stack app/);
    const available = message.split('Available stacks:')[1] ?? '';
    expect(available).toContain('App');
    expect(available).toContain('Other');
    expect(available).not.toContain('~');
    expect(available).not.toContain('InnerNS');
  });
});
