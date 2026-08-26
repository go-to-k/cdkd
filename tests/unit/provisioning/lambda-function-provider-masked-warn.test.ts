import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

/**
 * Issue #2178 — the RUNTIME twin of `scripts/check-provider-secret-mask.ts` for
 * `LambdaFunctionProvider`.
 *
 * `update()` echoes the whole `RuntimeManagementConfig` block into a debug line
 * after the `PutRuntimeManagementConfig` call. That block is RESOLVED template
 * content — `RuntimeVersionArn` is an ordinary string property, so a
 * `{{resolve:secretsmanager:...}}` there is already plaintext by the time the
 * provider runs — and the line goes to the provider's OWN logger, which no
 * deploy-engine masking sink ever sees.
 *
 * The critic proves the `maskDeep(...)` wrap is present. Only a run proves the
 * masker threaded from `UpdateContext` into this method is not the identity
 * function, which is what `not.toContain(SECRET_PLAINTEXT)` measures.
 */

const mockLambdaSend = vi.fn();
const mockEc2Send = vi.fn();
const { debugSpy } = vi.hoisted(() => ({ debugSpy: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: mockEc2Send },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: debugSpy,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: debugSpy,
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { LambdaFunctionProvider } from '../../../src/provisioning/providers/lambda-function-provider.js';
import {
  createSecretMasker,
  SECRET_MASK,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const TYPE = 'AWS::Lambda::Function';
const PHYSICAL_ID = 'issue2178-fn';

/** Distinctive, >= 8 chars, and a substring of nothing else in the line. */
const SECRET_PLAINTEXT = 'lambda2178-runtimearn-plaintext';

/**
 * A secret carrying a `"`, which `JSON.stringify` escapes out of existence —
 * the case the message-level sink structurally cannot reach, so only the
 * pre-stringify walk can.
 */
const ESCAPED_SECRET = 'a"b-lambda2178-escaped';

function maskerFor(...values: string[]): (text: string) => string {
  const bag: RecordedSecretValues = new Map(
    values.map((v) => [v, `{{resolve:secretsmanager:lambda/${v.length}:SecretString:v::}}`])
  );
  return createSecretMasker(bag);
}

const maskSecrets = (): ((text: string) => string) => maskerFor(SECRET_PLAINTEXT);

/**
 * The secret sits at a string LEAF inside the block, not as the value passed to
 * `maskDeep` itself — so the walk has to descend for the assertions to hold.
 */
function runtimeConfig(arn: string): Record<string, unknown> {
  return { UpdateRuntimeOn: 'Manual', RuntimeVersionArn: arn };
}

const PREVIOUS_RUNTIME_CONFIG = { UpdateRuntimeOn: 'Auto' };

function baseProps(runtimeManagementConfig: Record<string, unknown>): Record<string, unknown> {
  return {
    FunctionName: PHYSICAL_ID,
    Handler: 'index.handler',
    Runtime: 'nodejs20.x',
    Role: 'arn:aws:iam::123456789012:role/exec',
    RuntimeManagementConfig: runtimeManagementConfig,
  };
}

function previousProps(): Record<string, unknown> {
  return {
    FunctionName: PHYSICAL_ID,
    Handler: 'index.handler',
    Runtime: 'nodejs20.x',
    Role: 'arn:aws:iam::123456789012:role/exec',
    RuntimeManagementConfig: PREVIOUS_RUNTIME_CONFIG,
  };
}

function debugLines(): string {
  return debugSpy.mock.calls.map((c) => String(c[0])).join('\n---\n');
}

/**
 * Answer every Lambda command with a shape the update path can walk.
 *
 * A `mockImplementation` rather than a chain of `mockResolvedValueOnce`: a
 * `*Once` primer this path did not consume would leak into the next test in
 * the file (`vi.clearAllMocks()` does not drain the queue), which the repo's
 * `once-leak-detect` job fails on.
 */
function wireLambda(): void {
  mockLambdaSend.mockImplementation((command: { constructor: { name: string } }) => {
    const name = command.constructor.name;
    if (name === 'GetFunctionCommand') {
      return Promise.resolve({
        Configuration: {
          FunctionName: PHYSICAL_ID,
          FunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${PHYSICAL_ID}`,
          LastUpdateStatus: 'Successful',
          State: 'Active',
        },
        Tags: {},
      });
    }
    if (name === 'GetFunctionConfigurationCommand') {
      return Promise.resolve({
        FunctionName: PHYSICAL_ID,
        FunctionArn: `arn:aws:lambda:us-east-1:123456789012:function:${PHYSICAL_ID}`,
        LastUpdateStatus: 'Successful',
        State: 'Active',
      });
    }
    return Promise.resolve({});
  });
}

describe('LambdaFunctionProvider masks the RuntimeManagementConfig echo (issue #2178)', () => {
  let provider: LambdaFunctionProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLambdaSend.mockReset();
    mockEc2Send.mockReset();
    debugSpy.mockReset();
    wireLambda();
    provider = new LambdaFunctionProvider();
  });

  it('masks the resolved secret in the update() echo', async () => {
    await provider.update(
      'Fn',
      PHYSICAL_ID,
      TYPE,
      baseProps(runtimeConfig(SECRET_PLAINTEXT)),
      previousProps(),
      { maskSecrets: maskSecrets() }
    );

    const logged = debugLines();
    // Non-vacuity first: the echo fired and still renders the block, so the
    // two assertions below are about masking and not about a missing line.
    expect(logged).toContain('Updated RuntimeManagementConfig');
    expect(logged).toContain(JSON.stringify(runtimeConfig(SECRET_MASK)));
    expect(logged).not.toContain(SECRET_PLAINTEXT);
  });

  // The layer separation: once assembled, the line no longer CONTAINS this
  // secret (the `"` is escaped), so a message-level mask cannot find it and
  // only the pre-stringify walk can.
  it('masks a secret that JSON escaping would otherwise hide', async () => {
    await provider.update(
      'Fn',
      PHYSICAL_ID,
      TYPE,
      baseProps(runtimeConfig(ESCAPED_SECRET)),
      previousProps(),
      { maskSecrets: maskerFor(ESCAPED_SECRET) }
    );

    const logged = debugLines();
    expect(logged).toContain('Updated RuntimeManagementConfig');
    expect(logged).not.toContain(ESCAPED_SECRET);
    expect(logged).not.toContain(JSON.stringify(ESCAPED_SECRET).slice(1, -1));
    expect(logged).toContain(SECRET_MASK);
  });

  // THE CONTROL: absent context means unmasked, by contract — and without it a
  // line that simply dropped the block would satisfy everything above.
  it('leaves the plaintext INTACT when no context is supplied — the control', async () => {
    await provider.update(
      'Fn',
      PHYSICAL_ID,
      TYPE,
      baseProps(runtimeConfig(SECRET_PLAINTEXT)),
      previousProps()
    );

    const logged = debugLines();
    expect(logged).toContain('Updated RuntimeManagementConfig');
    expect(logged).toContain(JSON.stringify(runtimeConfig(SECRET_PLAINTEXT)));
    expect(logged).not.toContain(SECRET_MASK);
  });

  it('leaves the plaintext INTACT for a context that carries no masker', async () => {
    await provider.update(
      'Fn',
      PHYSICAL_ID,
      TYPE,
      baseProps(runtimeConfig(SECRET_PLAINTEXT)),
      previousProps(),
      { desiredFromAwsReadback: true }
    );

    expect(debugLines()).toContain(SECRET_PLAINTEXT);
  });

  it('does not mangle a non-secret value when a masker IS supplied', async () => {
    await provider.update(
      'Fn',
      PHYSICAL_ID,
      TYPE,
      baseProps(runtimeConfig('arn:aws:lambda:us-east-1::runtime:0123456789')),
      previousProps(),
      { maskSecrets: maskSecrets() }
    );

    const logged = debugLines();
    expect(logged).toContain('arn:aws:lambda:us-east-1::runtime:0123456789');
    expect(logged).not.toContain(SECRET_MASK);
  });
});
