import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  effectiveAssumeRoleArn,
  normalizeStartApiAssumeRole,
  parseAssumeRoleToken,
} from '../../../src/cli/options.js';
import { resolveExecutionRoleArnFromState } from '../../../src/cli/commands/local-invoke.js';
import { resolveStartApiAssumeRoleArn } from '../../../src/cli/commands/local-start-api.js';
import { resolveAssumeRoleArn } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { CdkdError } from '../../../src/utils/error-handler.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * Issue #2348: the points that RESOLVE a role ARN from argv, a template or a
 * state record ask `isIamRoleArn` instead of a start-anchored regex or
 * `startsWith('arn:')`. The send-site half is `tests/unit/utils/role-arn-shape.test.ts`.
 */

const ESC = String.fromCharCode(0x1b);
const GOOD = 'arn:aws:iam::123456789012:role/Good';
const FORGED = `arn:aws:iam::123456789012:role/x\n2026-01-01 INFO forged line`;
const ESCAPED = `arn:aws:iam::123456789012:role/x${ESC}[2K\revil`;

afterEach(() => {
  vi.restoreAllMocks();
});

function warnings(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => String(c[0]));
}

describe('parseAssumeRoleToken (`local start-api --assume-role`)', () => {
  it.each([
    ['a newline after a well-formed prefix', FORGED],
    ['an ESC sequence after a well-formed prefix', ESCAPED],
    ['an empty role name', 'arn:aws:iam::123456789012:role/'],
    ['a partition containing a space', 'arn:a b:iam::123456789012:role/R'],
    ['an over-long value', `arn:aws:iam::123456789012:role/${'a'.repeat(2048)}`],
  ])('rejects %s in the bare form', (_label, value) => {
    expect(() => parseAssumeRoleToken(value, undefined)).toThrow(/Invalid --assume-role value/);
  });

  it.each([
    ['a newline after a well-formed prefix', FORGED],
    ['an over-long value', `arn:aws:iam::123456789012:role/${'a'.repeat(2048)}`],
  ])('rejects %s in the LogicalId=<arn> form', (_label, value) => {
    expect(() => parseAssumeRoleToken(`Fn=${value}`, undefined)).toThrow(/right-hand side/);
  });

  it('reads a bare ARN whose role name contains `=` as the BARE form', () => {
    // IAM role names allow `=`; splitting on it first read `arn:...role/a` as a
    // logical id and refused the value.
    const withEq = 'arn:aws:iam::123456789012:role/a=b';
    expect(parseAssumeRoleToken(withEq, undefined).globalArn).toBe(withEq);
    expect(parseAssumeRoleToken(`  ${withEq}`, undefined).globalArn).toBe(withEq);
    // ...and the LogicalId=<arn> form keeps splitting on the FIRST `=`.
    expect(parseAssumeRoleToken(`Fn=${withEq}`, undefined).perLambda['Fn']).toBe(withEq);
  });

  it('trims the bare form, as the LogicalId=<arn> form always was', () => {
    expect(parseAssumeRoleToken(`  ${GOOD}  `, undefined).globalArn).toBe(GOOD);
    expect(parseAssumeRoleToken(`Fn= ${GOOD} `, undefined).perLambda['Fn']).toBe(GOOD);
  });

  it('keeps accepting IAM-legal path punctuation and short fixture accounts', () => {
    const path = 'arn:aws:iam::123456789012:role/team(a)/R';
    expect(parseAssumeRoleToken(path, undefined).globalArn).toBe(path);
    expect(parseAssumeRoleToken('arn:aws:iam::111:role/R', undefined).globalArn).toBe(
      'arn:aws:iam::111:role/R'
    );
  });
});

function stateWith(resources: Record<string, unknown>): StackState {
  return {
    version: 3,
    stackName: 'S',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

describe('resolveExecutionRoleArnFromState', () => {
  it('ignores and warns on a literal Role that only STARTS with arn:', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const state = stateWith({
      Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: ESCAPED }, attributes: {} },
    });
    expect(resolveExecutionRoleArnFromState(state, 'Fn')).toBeUndefined();
    const lines = warnings(warn);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('not a well-formed IAM role ARN');
    expect(lines[0]).not.toContain(ESC);
  });

  it('ignores and warns on a sibling role whose cached Arn is malformed', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const state = stateWith({
      Fn: {
        resourceType: 'AWS::Lambda::Function',
        properties: { Role: { 'Fn::GetAtt': ['R', 'Arn'] } },
        attributes: {},
      },
      R: { resourceType: 'AWS::IAM::Role', properties: {}, attributes: { Arn: FORGED } },
    });
    expect(resolveExecutionRoleArnFromState(state, 'Fn')).toBeUndefined();
    expect(warnings(warn).join('\n')).toContain('cached Arn attribute');
    expect(warnings(warn).join('\n')).not.toContain('\n2026-01-01');
  });

  it('still returns a well-formed literal and cached Arn, without warning (negative control)', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const literal = stateWith({
      Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: GOOD }, attributes: {} },
    });
    const viaSibling = stateWith({
      Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: { Ref: 'R' } }, attributes: {} },
      R: { resourceType: 'AWS::IAM::Role', properties: {}, attributes: { Arn: GOOD } },
    });
    expect(resolveExecutionRoleArnFromState(literal, 'Fn')).toBe(GOOD);
    expect(resolveExecutionRoleArnFromState(viaSibling, 'Fn')).toBe(GOOD);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn on a non-ARN string it never treated as a candidate', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const state = stateWith({
      Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: 'MyRole' }, attributes: {} },
    });
    expect(resolveExecutionRoleArnFromState(state, 'Fn')).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('resolveStartApiAssumeRoleArn (bare auto-resolve) is FAIL-CLOSED on a malformed ARN', () => {
  const auto = { perLambda: {}, bareAutoResolve: true };
  const lambda = (role?: unknown) =>
    ({ Type: 'AWS::Lambda::Function', Properties: role === undefined ? {} : { Role: role } }) as never;
  const bundleWith = (role: unknown) =>
    ({
      state: stateWith({
        Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: role }, attributes: {} },
      }),
    }) as never;

  it('refuses at startup on a malformed template Role literal, naming the logical id', () => {
    expect(() =>
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: auto,
        lambdaResource: lambda(FORGED),
        // A GOOD state value must not rescue it: the template literal EXISTS.
        stateBundle: bundleWith(GOOD),
      })
    ).toThrow(/^--assume-role-auto: the template Role for 'Fn' is not a well-formed IAM role ARN: .*Refusing to start/);
  });

  it('refuses at startup on a malformed state role ARN', () => {
    let caught: unknown;
    try {
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: auto,
        lambdaResource: lambda(),
        stateBundle: bundleWith(ESCAPED),
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toMatch(/^--assume-role-auto: Deployed state for 'Fn'/);
    expect((caught as Error).message).not.toContain(ESC);
  });

  it('keeps the TRUE-miss fallback: warns and returns undefined', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: auto,
        lambdaResource: lambda({ 'Fn::GetAtt': ['Missing', 'Arn'] }),
        stateBundle: undefined,
      })
    ).toBeUndefined();
    expect(warnings(warn).join('\n')).toContain('could not auto-resolve');
  });

  it('renders the logical id in the miss warning through displayIdent', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    resolveStartApiAssumeRoleArn({
      logicalId: `Fn${ESC}[2K`,
      assumeRole: auto,
      lambdaResource: lambda(),
      stateBundle: undefined,
    });
    const line = warnings(warn).join('\n');
    expect(line).toContain('could not auto-resolve');
    expect(line).not.toContain(ESC);
  });

  it('still returns a well-formed template literal or state ARN (negative control)', () => {
    vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: auto,
        lambdaResource: lambda(GOOD),
        stateBundle: undefined,
      })
    ).toBe(GOOD);
    expect(
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: auto,
        lambdaResource: lambda(),
        stateBundle: bundleWith(GOOD),
      })
    ).toBe(GOOD);
  });
});

describe('resolveAssumeRoleArn (`local invoke-agentcore`)', () => {
  const resolved = (roleArn?: string) => ({ logicalId: 'Runtime', roleArn }) as never;

  it('refuses a malformed explicit --assume-role with a CdkdError instead of falling back', () => {
    let caught: unknown;
    try {
      resolveAssumeRoleArn({ assumeRole: FORGED } as never, resolved(), undefined);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CdkdError);
    expect((caught as CdkdError).code).toBe('LOCAL_INVOKE_AGENTCORE_ASSUME_ROLE_INVALID');
    expect((caught as Error).message).not.toContain('\n');
  });

  it('trims and returns a well-formed explicit ARN', () => {
    expect(resolveAssumeRoleArn({ assumeRole: ` ${GOOD} ` } as never, resolved(), undefined)).toBe(
      GOOD
    );
  });

  it('skips a malformed template RoleArn with a warning, then consults state', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    vi.spyOn(getLogger(), 'debug').mockImplementation(() => {});
    const loaded = {
      resources: {
        Runtime: {
          resourceType: 'AWS::BedrockAgentCore::Runtime',
          properties: { RoleArn: GOOD },
          attributes: {},
        },
      },
    } as never;
    expect(resolveAssumeRoleArn({ assumeRole: true } as never, resolved(ESCAPED), loaded)).toBe(
      GOOD
    );
    expect(warnings(warn).join('\n')).toContain('the template RoleArn');
  });
});

describe('a prototype-named logical id reads the global ARN, not an inherited member', () => {
  it.each(['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty'])(
    '%s',
    (logicalId) => {
      const opt = parseAssumeRoleToken(GOOD, undefined);
      expect(effectiveAssumeRoleArn(logicalId, opt)).toBe(GOOD);
      const auto = normalizeStartApiAssumeRole(undefined, true);
      expect(effectiveAssumeRoleArn(logicalId, auto)).toBeUndefined();
    }
  );

  // The two halves are independent, so each gets its own case: the lookup
  // reads OWN keys even of a plain-object map a caller built itself...
  it('reads own keys only, even from a plain {} map', () => {
    expect(effectiveAssumeRoleArn('constructor', { perLambda: {}, globalArn: GOOD })).toBe(GOOD);
  });

  // ...and the parser's own maps carry no prototype to inherit from at all.
  it('builds null-prototype per-Lambda maps', () => {
    expect(Object.getPrototypeOf(parseAssumeRoleToken(GOOD, undefined).perLambda)).toBeNull();
    expect(Object.getPrototypeOf(normalizeStartApiAssumeRole(undefined, true)!.perLambda)).toBeNull();
  });

  it('still honours a per-Lambda entry of that name', () => {
    const opt = parseAssumeRoleToken(`constructor=${GOOD}`, undefined);
    expect(effectiveAssumeRoleArn('constructor', opt)).toBe(GOOD);
    expect(effectiveAssumeRoleArn('toString', opt)).toBeUndefined();
  });
});

describe('resolveAssumeRoleArn warns once per run, however often it is asked', () => {
  it('memoizes on the run\'s resolved object', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
    const options = { assumeRole: true } as never;
    const resolved = { logicalId: 'Runtime', roleArn: ESCAPED } as never;
    for (let i = 0; i < 3; i++) {
      expect(resolveAssumeRoleArn(options, resolved, undefined)).toBeUndefined();
    }
    // Two lines (the malformed literal, then the fallback), not six.
    expect(warn).toHaveBeenCalledTimes(2);
    // A different run (a fresh resolved object) warns again.
    resolveAssumeRoleArn(options, { logicalId: 'Runtime', roleArn: ESCAPED } as never, undefined);
    expect(warn).toHaveBeenCalledTimes(4);
  });
});
