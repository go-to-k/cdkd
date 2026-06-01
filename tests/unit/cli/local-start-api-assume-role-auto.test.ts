import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createLocalStartApiCommand,
  resolveStartApiAssumeRoleArn,
} from '../../../src/cli/commands/local-start-api.js';
import { normalizeStartApiAssumeRole, type AssumeRoleOption } from '../../../src/cli/options.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackState } from '../../../src/types/state.js';
import type { TemplateResource } from '../../../src/types/resource.js';

const ROLE_A = 'arn:aws:iam::123456789012:role/RoleA';
const ROLE_B = 'arn:aws:iam::123456789012:role/RoleB';
const ROLE_GLOBAL = 'arn:aws:iam::123456789012:role/GlobalRole';

// Stub the action so cmd.parse([...]) does not invoke the real handler
// (which would try to synth + surface process.exit on Node 24 — see
// feedback_cmd_parse_action_stub.md). Tests assert on `parsed.opts()`
// which Commander populates BEFORE the action runs.
function freshCommand() {
  const cmd = createLocalStartApiCommand();
  cmd.action(() => {});
  return cmd;
}

function lambdaResource(role?: unknown): TemplateResource {
  return {
    Type: 'AWS::Lambda::Function',
    Properties: role === undefined ? {} : { Role: role },
  };
}

// Build a minimal StackStateBundle-shaped object. The resolver only
// touches `stateBundle.state`, so a `{ state }` cast is sufficient.
function bundle(state: Partial<StackState>): { state: StackState } {
  return { state: state as StackState };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('normalizeStartApiAssumeRole', () => {
  it('both unset returns undefined', () => {
    expect(normalizeStartApiAssumeRole(undefined, false)).toBeUndefined();
  });

  it('auto-only returns { perLambda: {}, bareAutoResolve: true }', () => {
    expect(normalizeStartApiAssumeRole(undefined, true)).toEqual({
      perLambda: {},
      bareAutoResolve: true,
    });
  });

  it('per-Lambda map + auto keeps the map and sets bareAutoResolve', () => {
    const raw: AssumeRoleOption = { perLambda: { Fn1: ROLE_A } };
    const out = normalizeStartApiAssumeRole(raw, true);
    expect(out).toEqual({ perLambda: { Fn1: ROLE_A }, bareAutoResolve: true });
  });

  it('global ARN + auto THROWS naming both forms', () => {
    const raw: AssumeRoleOption = { perLambda: {}, globalArn: ROLE_GLOBAL };
    expect(() => normalizeStartApiAssumeRole(raw, true)).toThrow(/--assume-role-auto/);
    expect(() => normalizeStartApiAssumeRole(raw, true)).toThrow(
      new RegExp(ROLE_GLOBAL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  it('plain global ARN (no auto) is returned unchanged', () => {
    const raw: AssumeRoleOption = { perLambda: {}, globalArn: ROLE_GLOBAL };
    const out = normalizeStartApiAssumeRole(raw, false);
    expect(out).toEqual({ perLambda: {}, globalArn: ROLE_GLOBAL });
    expect(out?.bareAutoResolve).toBeUndefined();
  });
});

describe('resolveStartApiAssumeRoleArn', () => {
  it('returns undefined when assumeRole is undefined', () => {
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn1',
        assumeRole: undefined,
        lambdaResource: lambdaResource(),
        stateBundle: undefined,
      })
    ).toBeUndefined();
  });

  it('per-Lambda override wins over global default and auto-resolve', () => {
    const assumeRole: AssumeRoleOption = {
      perLambda: { Fn1: ROLE_A },
      globalArn: ROLE_GLOBAL,
      bareAutoResolve: true,
    };
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn1',
        assumeRole,
        lambdaResource: lambdaResource('arn:aws:iam::123456789012:role/Ignored'),
        stateBundle: undefined,
      })
    ).toBe(ROLE_A);
  });

  it('global default wins over auto-resolve for an unnamed Lambda', () => {
    const assumeRole: AssumeRoleOption = {
      perLambda: { Other: ROLE_B },
      globalArn: ROLE_GLOBAL,
    };
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn1',
        assumeRole,
        lambdaResource: lambdaResource(),
        stateBundle: undefined,
      })
    ).toBe(ROLE_GLOBAL);
  });

  it('bareAutoResolve uses the template literal-ARN Properties.Role directly', () => {
    const assumeRole: AssumeRoleOption = { perLambda: {}, bareAutoResolve: true };
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn1',
        assumeRole,
        lambdaResource: lambdaResource(ROLE_A),
        stateBundle: undefined,
      })
    ).toBe(ROLE_A);
  });

  it('bareAutoResolve falls back to state lookup via resolveExecutionRoleArnFromState', () => {
    const infoSpy = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    const assumeRole: AssumeRoleOption = { perLambda: {}, bareAutoResolve: true };
    const state = bundle({
      resources: {
        // The Lambda references a sibling Role logical id; the Role's
        // Arn attribute is what resolveExecutionRoleArnFromState returns.
        Fn1: {
          physicalId: 'fn1',
          resourceType: 'AWS::Lambda::Function',
          properties: { Role: { 'Fn::GetAtt': ['MyRole', 'Arn'] } },
          attributes: {},
          dependencies: [],
        },
        MyRole: {
          physicalId: 'role',
          resourceType: 'AWS::IAM::Role',
          properties: {},
          attributes: { Arn: ROLE_A },
          dependencies: [],
        },
      },
    });
    const out = resolveStartApiAssumeRoleArn({
      logicalId: 'Fn1',
      assumeRole,
      // Template Role is an intrinsic (not a literal ARN) so the state
      // lookup path is exercised.
      lambdaResource: lambdaResource({ 'Fn::GetAtt': ['MyRole', 'Arn'] }),
      stateBundle: state,
    });
    expect(out).toBe(ROLE_A);
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('auto-resolved execution role'));
  });

  it('bareAutoResolve miss warns and returns undefined', () => {
    const warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const assumeRole: AssumeRoleOption = { perLambda: {}, bareAutoResolve: true };
    const out = resolveStartApiAssumeRoleArn({
      logicalId: 'Fn1',
      assumeRole,
      lambdaResource: lambdaResource({ 'Fn::GetAtt': ['MissingRole', 'Arn'] }),
      stateBundle: bundle({ resources: {} }),
    });
    expect(out).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('could not auto-resolve'));
  });

  it('bareAutoResolve=false returns undefined even when state could resolve', () => {
    const assumeRole: AssumeRoleOption = { perLambda: {} };
    const out = resolveStartApiAssumeRoleArn({
      logicalId: 'Fn1',
      assumeRole,
      lambdaResource: lambdaResource(ROLE_A),
      stateBundle: bundle({
        resources: {
          Fn1: {
            physicalId: 'fn1',
            resourceType: 'AWS::Lambda::Function',
            properties: { Role: ROLE_A },
            attributes: {},
            dependencies: [],
          },
        },
      }),
    });
    expect(out).toBeUndefined();
  });
});

describe('createLocalStartApiCommand --assume-role-auto flag plumbing', () => {
  it('declares the --assume-role-auto option', () => {
    const cmd = freshCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain('--assume-role-auto');
  });

  it('--assume-role-auto defaults to false', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(['node', 'cdkd'], { from: 'user' });
    expect(parsed.opts().assumeRoleAuto).toBe(false);
  });

  it('parses bare --assume-role-auto as assumeRoleAuto=true', () => {
    const cmd = freshCommand();
    const parsed = cmd.parse(['node', 'cdkd', '--assume-role-auto'], { from: 'user' });
    expect(parsed.opts().assumeRoleAuto).toBe(true);
  });
});
