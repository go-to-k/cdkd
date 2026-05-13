import { describe, expect, it } from 'vite-plus/test';
import {
  createLocalStartApiCommand,
  envHasIntrinsicValue,
} from '../../../src/cli/commands/local-start-api.js';
import {
  substituteEnvVarsFromState,
  type SubstitutionContext,
} from '../../../src/local/state-resolver.js';
import type { ResourceState } from '../../../src/types/state.js';

function res(physicalId: string, attributes: Record<string, unknown> = {}): ResourceState {
  return {
    physicalId,
    resourceType: 'AWS::Test::Type',
    properties: {},
    attributes,
    dependencies: [],
  };
}

// Stub the action so cmd.parse([...]) does not invoke the real handler
// (which would try to synth and would surface process.exit on Node 24 —
// see feedback_cmd_parse_action_stub.md). Tests assert on
// `parsed.opts()` which Commander populates BEFORE the action runs.
function freshCommand() {
  const cmd = createLocalStartApiCommand();
  cmd.action(() => {});
  return cmd;
}

describe('createLocalStartApiCommand --from-state flag plumbing', () => {
  it('declares the --from-state / --stack-region / --state-bucket / --state-prefix options', () => {
    const cmd = freshCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--from-state');
    expect(longs).toContain('--stack-region');
    expect(longs).toContain('--state-bucket');
    expect(longs).toContain('--state-prefix');
  });

  it('--from-state defaults to false', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(['node', 'cdkd'], { from: 'user' });
    expect(parsed.opts().fromState).toBe(false);
  });

  it('parses bare --from-state as fromState=true', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(['node', 'cdkd', '--from-state'], { from: 'user' });
    expect(parsed.opts().fromState).toBe(true);
  });

  it('parses --stack-region <region> as stackRegion=<region>', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(
      ['node', 'cdkd', '--from-state', '--stack-region', 'us-west-2'],
      { from: 'user' }
    );
    expect(parsed.opts().stackRegion).toBe('us-west-2');
  });

  it('parses --state-bucket <bucket> as stateBucket=<bucket>', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(
      ['node', 'cdkd', '--from-state', '--state-bucket', 'my-state-bucket'],
      { from: 'user' }
    );
    expect(parsed.opts().stateBucket).toBe('my-state-bucket');
  });

  it('defaults --state-prefix to "cdkd"', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(['node', 'cdkd'], { from: 'user' });
    expect(parsed.opts().statePrefix).toBe('cdkd');
  });

  it('parses --state-prefix <prefix> as statePrefix=<prefix>', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(
      ['node', 'cdkd', '--from-state', '--state-prefix', 'custom-prefix'],
      { from: 'user' }
    );
    expect(parsed.opts().statePrefix).toBe('custom-prefix');
  });
});

describe('envHasIntrinsicValue (start-api gating helper)', () => {
  it('returns false for undefined env', () => {
    expect(envHasIntrinsicValue(undefined)).toBe(false);
  });

  it('returns false for fully-literal env map', () => {
    expect(envHasIntrinsicValue({ A: 'a', B: 42, C: true })).toBe(false);
  });

  it('returns true when any value is a CFn intrinsic object', () => {
    expect(envHasIntrinsicValue({ A: 'a', REGION: { Ref: 'AWS::Region' } })).toBe(true);
    expect(envHasIntrinsicValue({ ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] } })).toBe(true);
    expect(
      envHasIntrinsicValue({ X: { 'Fn::Join': [':', ['a', { Ref: 'AWS::Region' }]] } })
    ).toBe(true);
  });

  it('ignores null entries (they pass through as not-intrinsic)', () => {
    expect(envHasIntrinsicValue({ A: 'a', B: null as unknown as undefined })).toBe(false);
  });
});

describe('cdkd local start-api --from-state: shared substituteEnvVarsFromState wiring', () => {
  // These tests reuse the shared substituter the start-api CLI invokes
  // per Lambda. They mirror the canonical test cases in
  // `local-invoke-from-state-pseudo.test.ts` so a regression in the
  // shared module is caught by both CLI test suites independently.

  it('resolves Ref against state.resources', () => {
    const ctx: SubstitutionContext = {
      resources: { MyTable: res('deployed-table-name') },
    };
    const { env, audit } = substituteEnvVarsFromState({ TABLE: { Ref: 'MyTable' } }, ctx);
    expect(env).toEqual({ TABLE: 'deployed-table-name' });
    expect(audit.resolvedKeys).toEqual(['TABLE']);
    expect(audit.unresolved).toEqual([]);
  });

  it('resolves Fn::GetAtt against state attributes', () => {
    const ctx: SubstitutionContext = {
      resources: { MyTable: res('t1', { Arn: 'arn:aws:dynamodb:us-east-1:123:table/t1' }) },
    };
    const { env } = substituteEnvVarsFromState(
      { TABLE_ARN: { 'Fn::GetAtt': ['MyTable', 'Arn'] } },
      ctx
    );
    expect(env).toEqual({ TABLE_ARN: 'arn:aws:dynamodb:us-east-1:123:table/t1' });
  });

  it('resolves Fn::Sub with both state-Ref + AWS pseudo parameters', () => {
    const ctx: SubstitutionContext = {
      resources: { MyTable: res('t1') },
      pseudoParameters: { region: 'us-east-1', accountId: '123456789012' },
    };
    const { env } = substituteEnvVarsFromState(
      {
        TABLE_URL: {
          'Fn::Sub': 'https://dynamodb.${AWS::Region}.amazonaws.com/tables/${MyTable}',
        },
      },
      ctx
    );
    expect(env).toEqual({
      TABLE_URL: 'https://dynamodb.us-east-1.amazonaws.com/tables/t1',
    });
  });

  it('drops unresolvable intrinsics (state missing for referenced logical id) with reason', () => {
    const ctx: SubstitutionContext = { resources: {} };
    const { env, audit } = substituteEnvVarsFromState(
      { MISSING: { Ref: 'NotDeployed' } },
      ctx
    );
    expect(env).toEqual({});
    expect(audit.unresolved).toHaveLength(1);
    expect(audit.unresolved[0]!.key).toBe('MISSING');
    expect(audit.unresolved[0]!.reason).toMatch(/no record in cdkd state/);
  });

  it('drops AWS::* placeholders when no pseudoParameters bag is supplied', () => {
    // Simulates the "STS hop failed" branch — state loaded but the
    // pseudo-parameter bag is undefined. Per-key fall through to
    // warn-and-drop in the CLI layer.
    const ctx: SubstitutionContext = { resources: { MyTable: res('t1') } };
    const { env, audit } = substituteEnvVarsFromState(
      {
        TABLE: { Ref: 'MyTable' },
        REGION: { 'Fn::Sub': '${AWS::Region}' },
      },
      ctx
    );
    expect(env).toEqual({ TABLE: 't1' });
    expect(audit.resolvedKeys).toEqual(['TABLE']);
    expect(audit.unresolved.map((u) => u.key)).toEqual(['REGION']);
  });

  it('preserves literal env entries unchanged (fast path)', () => {
    const ctx: SubstitutionContext = { resources: {} };
    const { env, audit } = substituteEnvVarsFromState(
      { LITERAL: 'hello', NUM: 42, BOOL: true },
      ctx
    );
    expect(env).toEqual({ LITERAL: 'hello', NUM: 42, BOOL: true });
    expect(audit.resolvedKeys).toEqual([]);
    expect(audit.unresolved).toEqual([]);
  });
});
