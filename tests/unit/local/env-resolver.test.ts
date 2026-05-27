import { describe, expect, it } from 'vite-plus/test';
import { resolveEnvVars, type EnvOverrideFile } from '../../../src/local/env-resolver.js';

const LOGICAL = 'MyHandler1234ABCD';
// The full L1 form CDK encodes into `Metadata['aws:cdk:path']`.
const L1_PATH = 'MyStack/MyHandler/Resource';
// The L2 construct path the user actually reads from CDK app code, and
// the same form `cdkd local invoke` accepts as a target.
const L2_PATH = 'MyStack/MyHandler';
const L1_NESTED_PATH = 'MyStack/Nested/MyHandler/Resource';
const L2_NESTED_PATH = 'MyStack/Nested/MyHandler';

describe('resolveEnvVars', () => {
  describe('template-only path (no overrides)', () => {
    it('returns empty result when the function has no Environment.Variables', () => {
      expect(resolveEnvVars('Handler', undefined, undefined)).toEqual({
        resolved: {},
        unresolved: [],
      });
    });

    it('keeps literal string / number / boolean values', () => {
      const result = resolveEnvVars('Handler', undefined, { A: 'a', B: 42, C: true });
      expect(result.resolved).toEqual({ A: 'a', B: '42', C: 'true' });
      expect(result.unresolved).toEqual([]);
    });

    it('drops intrinsic-valued entries and reports them as unresolved', () => {
      const result = resolveEnvVars('Handler', undefined, {
        LITERAL: 'ok',
        TABLE: { Ref: 'MyTable' },
        ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] },
      });
      expect(result.resolved).toEqual({ LITERAL: 'ok' });
      expect(result.unresolved.sort()).toEqual(['ARN', 'TABLE']);
    });
  });

  describe('--env-vars: Parameters (global) overlay', () => {
    it('applies global Parameters before function-specific overrides', () => {
      const result = resolveEnvVars(
        'MyHandler',
        undefined,
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
        undefined,
        { KEY: 'from-template' },
        { MyHandler: { KEY: null } }
      );
      expect(result.resolved).toEqual({});
    });
  });

  describe('--env-vars: function-specific entry — logical-ID key', () => {
    it('ignores override entries for other functions', () => {
      const result = resolveEnvVars(
        'MyHandler',
        undefined,
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
        undefined,
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

  describe('--env-vars: function-specific entry — display-path key', () => {
    it('matches the exact L1 metadata path', () => {
      const overrides: EnvOverrideFile = {
        [L1_PATH]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', FN_ONLY: 'f' });
    });

    it('matches the L2 construct path (prefix of the L1 metadata path)', () => {
      // This is the natural form the user reads from CDK app code and the
      // same shape `cdkd local invoke` accepts as a target.
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { LITERAL: 'fn-specific', FN_ONLY: 'f' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'fn-specific', FN_ONLY: 'f' });
    });

    it('matches a nested-stack L2 construct path', () => {
      const overrides: EnvOverrideFile = {
        [L2_NESTED_PATH]: { NESTED_ONLY: 'on' },
      };
      const result = resolveEnvVars(LOGICAL, L1_NESTED_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ NESTED_ONLY: 'on' });
    });

    it('matches a parent stack path (prefix applies to every function under it)', () => {
      // Key `MyStack` is a prefix of `MyStack/MyHandler/Resource` so the
      // override fires; this lets a user set a stack-wide override without
      // listing every function (same UX as `Parameters` scoped to one
      // stack).
      const overrides: EnvOverrideFile = {
        MyStack: { STACK_WIDE: 'yes' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ STACK_WIDE: 'yes' });
    });

    it('display-path key with null clears a templateEnv-supplied key', () => {
      const overrides: EnvOverrideFile = { [L2_PATH]: { LITERAL: null } };
      const result = resolveEnvVars(
        LOGICAL,
        L1_PATH,
        { LITERAL: 'template', KEEP: 'k' },
        overrides
      );
      expect(result.resolved).toEqual({ KEEP: 'k' });
    });

    it('does not partial-match within a path segment (no false positive on siblings)', () => {
      // displayPath `MyStack/MyHandlerBackup/Resource` shares a string
      // prefix with the key `MyStack/MyHandler`, but the prefix rule
      // requires a `/` boundary — so this MUST NOT match. Without the
      // `${key}/` slash boundary `MyHandler` would erroneously match
      // `MyHandlerBackup`.
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(
        LOGICAL,
        'MyStack/MyHandlerBackup/Resource',
        { LITERAL: 'template' },
        overrides
      );
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });

    it('does not match a different display path', () => {
      const overrides: EnvOverrideFile = {
        'OtherStack/OtherHandler': { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });

    it('skips the display-path lookup when displayPath is undefined', () => {
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { FN_ONLY: 'should-not-apply' },
      };
      const result = resolveEnvVars(LOGICAL, undefined, { LITERAL: 'template' }, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'template' });
    });
  });

  describe('--env-vars: conflict resolution between logical-ID and display-path keys', () => {
    it('applies later JSON insertion wins (display path after logical ID)', () => {
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { LITERAL: 'from-logical-id' },
        [L2_PATH]: { LITERAL: 'from-display-path' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'from-display-path' });
    });

    it('applies later JSON insertion wins (logical ID after display path)', () => {
      const overrides: EnvOverrideFile = {
        [L2_PATH]: { LITERAL: 'from-display-path' },
        [LOGICAL]: { LITERAL: 'from-logical-id' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ LITERAL: 'from-logical-id' });
    });

    it('merges non-conflicting keys from both forms', () => {
      const overrides: EnvOverrideFile = {
        [LOGICAL]: { FROM_LOGICAL: 'L' },
        [L2_PATH]: { FROM_PATH: 'P' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ FROM_LOGICAL: 'L', FROM_PATH: 'P' });
    });
  });

  describe('--env-vars: misc', () => {
    it('ignores non-object entries (loose-shape tolerance)', () => {
      const overrides = {
        Parameters: { GLOBAL: 'g' },
        [LOGICAL]: 'a-string-not-a-map',
      } as unknown as EnvOverrideFile;
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ GLOBAL: 'g' });
    });

    it('Parameters layer applies even when no function-specific key matches', () => {
      const overrides: EnvOverrideFile = {
        Parameters: { GLOBAL: 'g' },
        OtherFn99: { FN_ONLY: 'no-match' },
      };
      const result = resolveEnvVars(LOGICAL, L1_PATH, undefined, overrides);
      expect(result.resolved).toEqual({ GLOBAL: 'g' });
    });
  });
});
