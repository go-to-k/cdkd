import { describe, it, expect } from 'vite-plus/test';
import {
  iamRolePathChanged,
  ReplacementRulesRegistry,
} from '../../../src/analyzer/replacement-rules.js';

/**
 * go-to-k/cdkd#4739: `AWS::IAM::Role.Path` is createOnly, so a change must
 * replace the role. It was listed as updateable, which sent the change to the
 * provider's in-place update, whose re-create collided on the live role's name.
 */
describe('ReplacementRulesRegistry - AWS::IAM::Role Path (#4739)', () => {
  const registry = new ReplacementRulesRegistry();
  const TYPE = 'AWS::IAM::Role';

  it('a Path change requires replacement', () => {
    expect(registry.requiresReplacement(TYPE, 'Path', '/a/', '/b/')).toBe(true);
    expect(registry.requiresReplacement(TYPE, 'Path', undefined, '/service/')).toBe(true);
    expect(registry.requiresReplacement(TYPE, 'Path', '/service/', undefined)).toBe(true);
  });

  it('the IAM default `/` and an absent or empty Path are the same path', () => {
    expect(registry.requiresReplacement(TYPE, 'Path', '/', undefined)).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'Path', undefined, '/')).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'Path', '', '/')).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'Path', '/', '')).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'Path', '/', null)).toBe(false);
    expect(registry.requiresReplacement(TYPE, 'Path', '/a/', '')).toBe(true);
    expect(registry.requiresReplacement(TYPE, 'Path', '/a/', '/a/')).toBe(false);
  });

  it('a non-string side that differs is a replacement', () => {
    expect(iamRolePathChanged({ Ref: 'P' }, '/a/')).toBe(true);
    expect(iamRolePathChanged({ Ref: 'P' }, { Ref: 'P' })).toBe(false);
    // Key order is not a difference.
    expect(iamRolePathChanged({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
  });

  it('stays classified, so the schema fallback does not decide it', () => {
    expect(registry.isClassified(TYPE, 'Path')).toBe(true);
  });

  it.each([
    'AssumeRolePolicyDocument',
    'Description',
    'ManagedPolicyArns',
    'MaxSessionDuration',
    'PermissionsBoundary',
    'Policies',
    'Tags',
  ])('%s stays an in-place update', (prop) => {
    expect(registry.requiresReplacement(TYPE, prop, 'old', 'new')).toBe(false);
  });
});
