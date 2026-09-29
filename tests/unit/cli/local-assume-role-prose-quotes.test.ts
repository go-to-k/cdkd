import { afterEach, describe, expect, it, vi } from 'vite-plus/test';

import {
  classifyExecutionRoleArnFromState,
  resolveBareAssumeRoleFromState,
} from '../../../src/cli/commands/local-invoke.js';
import { resolveStartApiAssumeRoleArn } from '../../../src/cli/commands/local-start-api.js';
import { resolveAssumeRoleArn } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { getLogger } from '../../../src/utils/logger.js';
import { UNSHOWABLE_VALUE } from '../../../src/utils/pasteable-command.js';
import type { StackState } from '../../../src/types/state.js';
import {
  CLAUSE_BREAK_PAYLOAD,
  PASTE_PAYLOADS,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/** Every family, the opt-in clause break included (go-to-k/cdkd#3950). */
const PAYLOADS = [...PASTE_PAYLOADS, CLAUSE_BREAK_PAYLOAD];

/**
 * go-to-k/cdkd#3950: the `--assume-role` messages of `cdkd local invoke`,
 * `local invoke-agentcore` and `local start-api` name a template-supplied
 * logical id. They used to print it as `'${displayIdent(id)}'`, and a `'` in
 * the id closed that hand-written quote. Now a plain id keeps its quotes
 * byte-identically and any other is DESCRIBED: these sentences name
 * `cdkd state` or an `--assume-role` flag, so a JSON-quoted `$( )` in them
 * would still run when pasted. Every message is fed WHOLE to the paste
 * harness, and every one must be inert.
 */

const GOOD = 'arn:aws:iam::123456789012:role/Good';
/** Starts with `arn:` (so it is a candidate) and fails `isIamRoleArn`, yet is a plain identifier. */
const MALFORMED = 'arn:aws:iam::123456789012:role/';
const DESCRIBED = 'a logical id that is not a plain identifier';

afterEach(() => {
  vi.restoreAllMocks();
});

function stateWith(resources: Record<string, unknown>): StackState {
  return {
    version: 10,
    stackName: 'S',
    region: 'us-east-1',
    resources,
    outputs: {},
    lastModified: 0,
  } as unknown as StackState;
}

const lambda = (role?: unknown) =>
  ({ Type: 'AWS::Lambda::Function', Properties: role === undefined ? {} : { Role: role } }) as never;

const auto = { perLambda: {}, bareAutoResolve: true };

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a throw');
}

/** Every message a site prints for `logicalId`, labelled by site. */
function messagesFor(logicalId: string): Array<{ site: string; message: string }> {
  const out: Array<{ site: string; message: string }> = [];
  const logged = (level: 'warn' | 'info', run: () => unknown): string => {
    vi.restoreAllMocks();
    const spy = vi.spyOn(getLogger(), level).mockImplementation(() => {});
    run();
    const lines = spy.mock.calls.map((c) => String(c[0]));
    expect(lines, `${level} for ${logicalId}`).toHaveLength(1);
    return lines[0]!;
  };

  out.push({
    site: 'local invoke: state miss',
    message: logged('warn', () => resolveBareAssumeRoleFromState(stateWith({}), logicalId)),
  });

  const literal = classifyExecutionRoleArnFromState(
    stateWith({ [logicalId]: { resourceType: 'AWS::Lambda::Function', properties: { Role: MALFORMED } } }),
    logicalId
  );
  expect(literal.kind).toBe('malformed');
  out.push({
    site: 'local invoke: malformed state Role',
    message: literal.kind === 'malformed' ? literal.description : '',
  });

  const cached = classifyExecutionRoleArnFromState(
    stateWith({
      TheFunction: {
        resourceType: 'AWS::Lambda::Function',
        properties: { Role: { 'Fn::GetAtt': [logicalId, 'Arn'] } },
      },
      [logicalId]: { resourceType: 'AWS::IAM::Role', attributes: { Arn: MALFORMED } },
    }),
    'TheFunction'
  );
  expect(cached.kind).toBe('malformed');
  out.push({
    site: 'local invoke: malformed cached Arn',
    message: cached.kind === 'malformed' ? cached.description : '',
  });

  out.push({
    site: 'local invoke-agentcore: malformed template RoleArn',
    // A GOOD state value, so the one warning is the template one.
    message: logged('warn', () =>
      resolveAssumeRoleArn(
        { assumeRole: true } as never,
        { logicalId, roleArn: MALFORMED } as never,
        {
          resources: {
            [logicalId]: {
              resourceType: 'AWS::BedrockAgentCore::Runtime',
              properties: { RoleArn: GOOD },
              attributes: {},
            },
          },
        } as never
      )
    ),
  });

  out.push({
    site: 'local start-api: malformed template Role',
    message: thrown(() =>
      resolveStartApiAssumeRoleArn({
        logicalId,
        assumeRole: auto,
        lambdaResource: lambda(MALFORMED),
        stateBundle: undefined,
      })
    ),
  });

  out.push({
    site: 'local start-api: resolved from state',
    message: logged('info', () =>
      resolveStartApiAssumeRoleArn({
        logicalId,
        assumeRole: auto,
        lambdaResource: lambda(),
        stateBundle: {
          state: stateWith({
            [logicalId]: { resourceType: 'AWS::Lambda::Function', properties: { Role: GOOD } },
          }),
        } as never,
      })
    ),
  });

  out.push({
    site: 'local start-api: miss',
    message: logged('warn', () =>
      resolveStartApiAssumeRoleArn({
        logicalId,
        assumeRole: auto,
        lambdaResource: lambda(),
        stateBundle: undefined,
      })
    ),
  });
  return out;
}

describe('the --assume-role messages never put a logical id inside cdkd quotes (go-to-k/cdkd#3950)', () => {
  it('keeps a plain logical id quoted, byte-identical to before', () => {
    const messages = messagesFor('Fn');
    expect(messages).toHaveLength(7);
    for (const { site, message } of messages) {
      expect(message, site).toContain("'Fn'");
      expect(message, site).not.toContain(DESCRIBED);
    }
    // The pasteable example names a plain id.
    const miss = messages.find((m) => m.site === 'local start-api: miss')!.message;
    expect(miss).toContain('--assume-role Fn=<arn>');
  });

  it('describes every non-plain payload, names none of it, and no pasted span runs', () => {
    const rendered: Array<{ value: string; site: string; message: string }> = [];
    for (const { value } of PAYLOADS) {
      for (const m of messagesFor(value)) rendered.push({ value, ...m });
    }
    expect(rendered).toHaveLength(PAYLOADS.length * 7);
    withPasteDir((dir) => {
      for (const { value, site, message } of rendered) {
        const label = `${site}: ${value}`;
        expect(message, label).toContain(DESCRIBED);
        // The value is not shown in any spelling: not raw, not JSON-quoted.
        expect(message, label).not.toContain(value);
        expect(message, label).not.toContain(JSON.stringify(value));
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
    // The start-api examples drop the id rather than print a hole.
    const miss = rendered.find((r) => r.site === 'local start-api: miss')!.message;
    expect(miss).toContain("--assume-role, naming this Lambda's logical id");
    expect(miss).not.toContain('=<arn>');
    const refusal = rendered.find((r) => r.site === 'local start-api: malformed template Role')!;
    expect(refusal.message).toContain("pin one explicitly with --assume-role, naming this Lambda's logical id.");
  }, 120_000);
});

/**
 * The ARN in the same messages. It is shown, since the operator needs it, and
 * these sentences name `--assume-role`, so a JSON-quoted `$( )` in it would run
 * when pasted; `shellBoundedDisplay` shell-quotes the JSON render instead.
 * Both a MALFORMED candidate (`arn:` plus the payload) and one `isIamRoleArn`
 * accepts (the payload after `role/`, spaces spelled `${IFS}`) are driven,
 * each through every message that prints it.
 */
describe('the --assume-role messages shell-bound a non-plain role ARN (go-to-k/cdkd#3950)', () => {
  function arnMessagesFor(value: string): Array<{ site: string; message: string }> {
    const malformed = `arn:${value}`;
    // `isIamRoleArn` refuses a space, so the accepted form spells each space
    // `${IFS}`, which still splits words when a pasted span runs.
    const accepted = `arn:aws:iam::123456789012:role/${value.replace(/ /g, '${IFS}')}`;
    const out: Array<{ site: string; message: string }> = [];
    const logged = (level: 'warn' | 'info' | 'debug', run: () => unknown): string => {
      vi.restoreAllMocks();
      const spy = vi.spyOn(getLogger(), level).mockImplementation(() => {});
      run();
      const lines = spy.mock.calls.map((c) => String(c[0]));
      expect(lines, `${level} for ${value}`).toHaveLength(1);
      return lines[0]!;
    };
    const fnWithRole = (role: unknown) =>
      stateWith({ Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: role } } });

    out.push({
      site: 'local invoke: resolved from state',
      message: logged('info', () => resolveBareAssumeRoleFromState(fnWithRole(accepted), 'Fn')),
    });
    const literal = classifyExecutionRoleArnFromState(fnWithRole(malformed), 'Fn');
    out.push({
      site: 'local invoke: malformed state Role',
      message: literal.kind === 'malformed' ? literal.description : `unexpected ${literal.kind}`,
    });
    const cached = classifyExecutionRoleArnFromState(
      stateWith({
        Fn: { resourceType: 'AWS::Lambda::Function', properties: { Role: { Ref: 'R' } } },
        R: { resourceType: 'AWS::IAM::Role', attributes: { Arn: malformed } },
      }),
      'Fn'
    );
    out.push({
      site: 'local invoke: malformed cached Arn',
      message: cached.kind === 'malformed' ? cached.description : `unexpected ${cached.kind}`,
    });
    const runtimeState = (roleArn: string) =>
      ({
        resources: {
          Runtime: { resourceType: 'AWS::BedrockAgentCore::Runtime', properties: { RoleArn: roleArn } },
        },
      }) as never;
    out.push({
      site: 'local invoke-agentcore: malformed template RoleArn',
      message: logged('warn', () =>
        resolveAssumeRoleArn(
          { assumeRole: true } as never,
          { logicalId: 'Runtime', roleArn: malformed } as never,
          runtimeState(GOOD)
        )
      ),
    });
    out.push({
      site: 'local invoke-agentcore: resolved from state',
      message: logged('debug', () =>
        resolveAssumeRoleArn(
          { assumeRole: true } as never,
          { logicalId: 'Runtime', roleArn: undefined } as never,
          runtimeState(accepted)
        )
      ),
    });
    out.push({
      site: 'local start-api: malformed template Role',
      message: thrown(() =>
        resolveStartApiAssumeRoleArn({
          logicalId: 'Fn',
          assumeRole: auto,
          lambdaResource: lambda(malformed),
          stateBundle: undefined,
        })
      ),
    });
    out.push({
      site: 'local start-api: malformed state Role',
      message: thrown(() =>
        resolveStartApiAssumeRoleArn({
          logicalId: 'Fn',
          assumeRole: auto,
          lambdaResource: lambda(),
          stateBundle: { state: fnWithRole(malformed) } as never,
        })
      ),
    });
    out.push({
      site: 'local start-api: resolved from state',
      message: logged('info', () =>
        resolveStartApiAssumeRoleArn({
          logicalId: 'Fn',
          assumeRole: auto,
          lambdaResource: lambda(),
          stateBundle: { state: fnWithRole(accepted) } as never,
        })
      ),
    });
    return out;
  }

  it('prints a plain ARN bare, and pins the plain refusal tail', () => {
    const refusal = thrown(() =>
      resolveStartApiAssumeRoleArn({
        logicalId: 'Fn',
        assumeRole: auto,
        lambdaResource: lambda(MALFORMED),
        stateBundle: undefined,
      })
    );
    expect(refusal).toContain(`is not a well-formed IAM role ARN: ${MALFORMED}. Refusing to start`);
    expect(refusal).toMatch(/or pin one explicitly with --assume-role Fn=<arn>\.$/);
  });

  it('shell-quotes every non-plain ARN, and no pasted span runs', () => {
    const rendered: Array<{ value: string; site: string; message: string }> = [];
    for (const { value } of PAYLOADS) {
      for (const m of arnMessagesFor(value)) rendered.push({ value, ...m });
    }
    expect(rendered).toHaveLength(PAYLOADS.length * 8);
    // The five sites printing the MALFORMED candidate keep its break.
    expect(
      rendered.filter((r) => r.message.includes(UNSHOWABLE_VALUE)).map((r) => r.site)
    ).toHaveLength(5);
    withPasteDir((dir) => {
      for (const { value, site, message } of rendered) {
        const label = `${site}: ${value}`;
        expect(message, label).not.toContain('unexpected');
        // The JSON render is present only inside single quotes, unless it
        // holds a clause break, which is described instead. (The accepted
        // form spells spaces `${IFS}`, so its render has no break.)
        if (message.includes(UNSHOWABLE_VALUE)) {
          expect(value, label).toBe(CLAUSE_BREAK_PAYLOAD.value);
          expect(message, label).not.toContain('touch OWNED');
        } else {
          expect(message, label).toMatch(/'"arn:/);
        }
        expect(spansThatRun(message, dir), label).toEqual([]);
      }
    });
  }, 120_000);
});
