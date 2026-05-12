import { describe, expect, it } from 'vite-plus/test';
import { resolveEnvVars } from '../../../src/local/env-resolver.js';

describe('resolveEnvVars', () => {
  it('returns empty result when the function has no Environment.Variables', () => {
    expect(resolveEnvVars('Handler', undefined)).toEqual({ resolved: {}, unresolved: [] });
  });

  it('keeps literal string / number / boolean values', () => {
    const result = resolveEnvVars('Handler', { A: 'a', B: 42, C: true });
    expect(result.resolved).toEqual({ A: 'a', B: '42', C: 'true' });
    expect(result.unresolved).toEqual([]);
  });

  it('drops intrinsic-valued entries and reports them as unresolved', () => {
    const result = resolveEnvVars('Handler', {
      LITERAL: 'ok',
      TABLE: { Ref: 'MyTable' },
      ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] },
    });
    expect(result.resolved).toEqual({ LITERAL: 'ok' });
    expect(result.unresolved.sort()).toEqual(['ARN', 'TABLE']);
  });

  it('applies global Parameters before function-specific overrides', () => {
    const result = resolveEnvVars(
      'MyHandler',
      { LITERAL: 'from-template' },
      {
        Parameters: { GLOBAL_ONLY: 'from-global', LITERAL: 'overridden-by-global' },
        MyHandler: { LITERAL: 'overridden-by-fn', FN_ONLY: 'from-fn' },
      }
    );
    expect(result.resolved).toEqual({
      LITERAL: 'overridden-by-fn',
      GLOBAL_ONLY: 'from-global',
      FN_ONLY: 'from-fn',
    });
  });

  it('clears a key when override value is null (SAM compatibility)', () => {
    const result = resolveEnvVars(
      'MyHandler',
      { KEY: 'from-template' },
      { MyHandler: { KEY: null } }
    );
    expect(result.resolved).toEqual({});
  });

  it('ignores override entries for other functions', () => {
    const result = resolveEnvVars(
      'MyHandler',
      { KEY: 'a' },
      { OtherHandler: { KEY: 'should-not-apply' } }
    );
    expect(result.resolved).toEqual({ KEY: 'a' });
  });

  it('substitutes the template intrinsic with an override when provided', () => {
    // Common workflow: template has Ref-valued env, user supplies a literal
    // via --env-vars to make it concrete for local invoke.
    const result = resolveEnvVars(
      'MyHandler',
      { TABLE_NAME: { Ref: 'MyTable' } },
      { MyHandler: { TABLE_NAME: 'literal-table' } }
    );
    expect(result.resolved).toEqual({ TABLE_NAME: 'literal-table' });
    // Note: it's still reported as unresolved at the template level so the
    // caller can decide whether to emit a warning. The override's success
    // is observable via `resolved`.
    expect(result.unresolved).toEqual(['TABLE_NAME']);
  });
});
