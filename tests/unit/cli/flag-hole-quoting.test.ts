import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  normalizeStartApiAssumeRole,
  parseAssumeRoleToken,
  validateResourceTimeouts,
  type ResourceTimeoutOption,
} from '../../../src/cli/options.js';
import { parseOlderThan } from '../../../src/cli/commands/gc.js';
import {
  buildSigV4HeadersIfRequested,
  resolveAssumeRoleArn,
  resolveInboundAuthorization,
} from '../../../src/cli/commands/local-invoke-agentcore.js';
import { getLogger } from '../../../src/utils/logger.js';
import {
  PASTE_PAYLOADS,
  expectNoCommandBesideDisplay,
  spansThatRun,
  withPasteDir,
} from '../utils/paste-harness.js';

/**
 * Every `<placeholder>` beside a flag in these messages is a QUOTED hole
 * (go-to-k/cdkd#4295). Bare, `--resource-timeout <duration> alongside` reads
 * stdin from a file named `duration` and `>` truncates the next word when the
 * line is pasted; quoted, `'<duration>'` is one inert argument. Each case
 * drives the real message producer and pins the quoted spelling, which a
 * revert of the site turns red.
 */

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a throw');
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected a rejection');
}

const opt = (globalMs?: number, perTypeMs: Record<string, number> = {}): ResourceTimeoutOption => ({
  ...(globalMs !== undefined && { globalMs }),
  perTypeMs,
});

describe('--resource-timeout / --resource-warn-after remedies quote the duration hole', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('global warn above the default timeout', () => {
    const message = thrownMessage(() => validateResourceTimeouts({ resourceWarnAfter: opt(45 * 60_000) }));
    expect(message).toContain("Pass --resource-timeout '<duration>' alongside it");
  });

  it('per-type warn above the inherited timeout', () => {
    const message = thrownMessage(() =>
      validateResourceTimeouts({
        resourceWarnAfter: opt(undefined, { 'AWS::EC2::Instance': 45 * 60_000 }),
      })
    );
    expect(message).toContain("Pass --resource-timeout AWS::EC2::Instance='<duration>' alongside it");
  });

  it('global warn auto-lowered under a short global timeout', () => {
    validateResourceTimeouts({ resourceTimeout: opt(2 * 60_000) });
    expect(String(warnSpy.mock.calls[0]![0])).toContain(
      "Pass --resource-warn-after '<duration>' explicitly to override."
    );
  });

  it('per-type warn auto-lowered under a short per-type timeout', () => {
    validateResourceTimeouts({ resourceTimeout: opt(undefined, { 'AWS::EC2::Instance': 2 * 60_000 }) });
    expect(String(warnSpy.mock.calls.at(-1)![0])).toContain(
      "Pass --resource-warn-after AWS::EC2::Instance='<duration>' explicitly to override."
    );
  });
});

describe('the --assume-role refusals quote their holes', () => {
  it('an --assume-role value that is neither an ARN nor LogicalId=<arn>', () => {
    const message = thrownMessage(() => parseAssumeRoleToken('not-an-arn', undefined));
    expect(message).toContain("or LogicalId='<arn>'.");
  });

  it('a global ARN combined with --assume-role-auto', () => {
    const raw = parseAssumeRoleToken('arn:aws:iam::123456789012:role/MyRole', undefined);
    const message = thrownMessage(() => normalizeStartApiAssumeRole(raw, true));
    expect(message).toContain("(--assume-role '<LogicalId>'='<arn>')");
  });
});

describe('the cdkd gc --older-than refusal quotes its holes', () => {
  it('a malformed duration', () => {
    expect(thrownMessage(() => parseOlderThan('soon'))).toContain(
      "expected '<number>d' or '<number>h'"
    );
  });
});

describe('the cdkd local invoke-agentcore auth refusals quote their holes', () => {
  const runtime = (jwtAuthorizer?: unknown) =>
    ({
      logicalId: 'Runtime',
      jwtAuthorizer,
      stack: { region: undefined },
    }) as never;

  it('a JWT-authorized runtime with no --bearer-token', async () => {
    const message = await rejectedMessage(
      resolveInboundAuthorization(runtime({ discoveryUrl: 'https://example.com' }), { verifyAuth: true })
    );
    expect(message).toContain("Pass --bearer-token '<jwt>', or --no-verify-auth");
  });

  it('names no payload runtime logical id beside --bearer-token', async () => {
    for (const { value } of PASTE_PAYLOADS) {
      const message = await rejectedMessage(
        resolveInboundAuthorization(
          { logicalId: value, jwtAuthorizer: { discoveryUrl: 'https://example.com' }, stack: {} } as never,
          { verifyAuth: true }
        )
      );
      expect(message, value).toContain(
        "Runtime a logical id that is not a plain identifier requires an inbound JWT"
      );
      withPasteDir((dir) => {
        expectNoCommandBesideDisplay(message, value);
        expect(spansThatRun(message, dir), `${value}: ${message}`).toEqual([]);
      });
    }
  }, 120_000);

  it('--sigv4 with no resolvable region', async () => {
    const saved = { region: process.env['AWS_REGION'], def: process.env['AWS_DEFAULT_REGION'] };
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    try {
      const message = await rejectedMessage(
        buildSigV4HeadersIfRequested({ sigv4: true } as never, runtime(), undefined, 'localhost', 8080, {}, 's')
      );
      expect(message).toContain("Pass --region '<region>', set AWS_REGION");
    } finally {
      if (saved.region !== undefined) process.env['AWS_REGION'] = saved.region;
      if (saved.def !== undefined) process.env['AWS_DEFAULT_REGION'] = saved.def;
    }
  });
});

describe('the cdkd local invoke-agentcore bare --assume-role warning quotes its hole', () => {
  it('a runtime with no literal RoleArn and no state', () => {
    const warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
    try {
      expect(
        resolveAssumeRoleArn({ assumeRole: true } as never, { logicalId: 'Runtime' } as never, undefined)
      ).toBeUndefined();
      const line = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(line).toContain("Pass the ARN explicitly: --assume-role '<arn>'.");
    } finally {
      warn.mockRestore();
    }
  });
});

describe('help text that shows a command quotes its holes', () => {
  it('the --force-stateful-recreation help example', async () => {
    const { forceStatefulRecreationOption } = await import('../../../src/cli/options.js');
    expect(forceStatefulRecreationOption.description).toContain(
      "use: --recreate-via-cc-api '<id>' --force-stateful-recreation --yes."
    );
  });

  it('the cdkd local start-alb description', async () => {
    const { createLocalStartAlbCommand } = await import('../../../src/cli/commands/local-start-alb.js');
    expect(createLocalStartAlbCommand().description()).toContain(
      "use --bearer-token '<jwt>' to inject a default token"
    );
  });
});
