import { describe, expect, it } from 'vite-plus/test';
import { selectTargetStack } from '../../../src/cli/stack-matcher.js';

const app = { stackName: 'App', displayName: 'App' };
const child = {
  stackName: 'App~InnerNS',
  displayName: 'App/Inner',
  nestedStack: { parentStackName: 'App' },
};
const other = { stackName: 'Other', displayName: 'Other' };
const parsed = { stackPattern: null, pathOrId: 'Fn', isPath: false };

describe('selectTargetStack nested-stack counting', () => {
  it('a prefix-less target counts top-level stacks only', () => {
    expect(selectTargetStack(parsed, 'Fn', [app, child])).toEqual({ kind: 'found', stack: app });
  });

  it('two top-level stacks still need a prefix', () => {
    expect(selectTargetStack(parsed, 'Fn', [app, other, child])).toEqual({ kind: 'no-prefix' });
  });
});
