import { describe, it, expect } from 'vitest';
import {
  matchStacks,
  stackMatchesPattern,
  describeStack,
} from '../../../src/cli/stack-matcher.js';

const stacks = [
  { stackName: 'TopStack', displayName: 'TopStack' },
  { stackName: 'MyStage-Api', displayName: 'MyStage/Api' },
  { stackName: 'MyStage-Db', displayName: 'MyStage/Db' },
  { stackName: 'OtherStage-Api', displayName: 'OtherStage/Api' },
];

describe('stackMatchesPattern', () => {
  it('matches by physical stackName when pattern has no slash', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-Api')).toBe(true);
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/Api')).toBe(true);
  });

  it('routes slash-bearing patterns to displayName only', () => {
    // pattern has '/', so MyStage-Api stack only matches via displayName
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/Api')).toBe(true);
    // Same pattern won't match a stack whose displayName lacks the slash form
    expect(stackMatchesPattern(stacks[0]!, 'MyStage/Api')).toBe(false);
  });

  it('treats hyphen patterns as physical names, not display paths', () => {
    // 'MyStage-Api' must NOT match a displayName 'MyStage/Api' on its own —
    // the routing rule keeps these strictly separate.
    const stageOnly = { stackName: 'phys-name', displayName: 'MyStage/Api' };
    expect(stackMatchesPattern(stageOnly, 'MyStage-Api')).toBe(false);
  });

  it('supports wildcards on physical names', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage-*')).toBe(true);
    expect(stackMatchesPattern(stacks[2]!, 'MyStage-*')).toBe(true);
    expect(stackMatchesPattern(stacks[3]!, 'MyStage-*')).toBe(false);
  });

  it('supports wildcards on display paths (Stage-scoped selection)', () => {
    expect(stackMatchesPattern(stacks[1]!, 'MyStage/*')).toBe(true);
    expect(stackMatchesPattern(stacks[2]!, 'MyStage/*')).toBe(true);
    expect(stackMatchesPattern(stacks[3]!, 'MyStage/*')).toBe(false);
    expect(stackMatchesPattern(stacks[0]!, 'MyStage/*')).toBe(false);
  });

  it('falls back to stackName when displayName is missing', () => {
    const s = { stackName: 'OnlyPhysical' };
    expect(stackMatchesPattern(s, 'OnlyPhysical')).toBe(true);
    // Slash-bearing pattern still routes to displayName, which falls back
    // to stackName. A literal slash in stackName is impossible in CFN, so
    // any '/' pattern simply won't match.
    expect(stackMatchesPattern(s, 'OnlyPhysical/X')).toBe(false);
  });
});

describe('describeStack', () => {
  it('returns stackName alone when displayName matches', () => {
    expect(describeStack({ stackName: 'MyStack', displayName: 'MyStack' })).toBe('MyStack');
  });

  it('returns stackName alone when displayName is missing', () => {
    expect(describeStack({ stackName: 'MyStack' })).toBe('MyStack');
  });

  it('appends displayName when it differs from stackName', () => {
    expect(describeStack({ stackName: 'MyStage-Api', displayName: 'MyStage/Api' })).toBe(
      'MyStage-Api (MyStage/Api)'
    );
  });
});

describe('matchStacks', () => {
  it('returns empty when no patterns are given', () => {
    expect(matchStacks(stacks, [])).toEqual([]);
  });

  it('selects all stacks under a Stage using a display-path wildcard', () => {
    const result = matchStacks(stacks, ['MyStage/*']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api', 'MyStage-Db']);
  });

  it('selects exact physical name even when a Stage stack shares the prefix', () => {
    const result = matchStacks(stacks, ['MyStage-Api']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api']);
  });

  it('deduplicates when multiple patterns match the same stack', () => {
    const result = matchStacks(stacks, ['MyStage-Api', 'MyStage/Api']);
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api']);
  });

  it('mixes patterns and accumulates the union', () => {
    const result = matchStacks(stacks, ['TopStack', 'MyStage/*']);
    expect(result.map((s) => s.stackName).sort()).toEqual([
      'MyStage-Api',
      'MyStage-Db',
      'TopStack',
    ]);
  });

  it('preserves the input order of stacks', () => {
    const result = matchStacks(stacks, ['*Api*']);
    // Wildcard patterns without slash route to stackName.
    expect(result.map((s) => s.stackName)).toEqual(['MyStage-Api', 'OtherStage-Api']);
  });
});
