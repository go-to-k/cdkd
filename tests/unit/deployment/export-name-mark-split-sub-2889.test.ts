import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  IntrinsicFunctionResolver,
  type ResolverContext,
  resetAccountInfoCache,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import { exportNameSecretExposure } from '../../../src/deployment/outputs-export-alias.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';

vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  }),
}));

const mockSecretsManagerSend = vi.fn();

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    sts: { send: vi.fn().mockResolvedValue({ Account: '123456789012' }) },
    ec2: { send: vi.fn().mockResolvedValue({ AvailabilityZones: [] }) },
    secretsManager: { send: mockSecretsManagerSend },
    ssm: { send: vi.fn() },
  }),
}));

/**
 * Issue [#2889](https://github.com/go-to-k/cdkd/issues/2889), through the REAL
 * resolver: an `Export.Name` written as `Fn::Sub` over literals, one of which
 * is a nonspacing mark (U+09BC), resolves with the mark INTACT, and the
 * export-name refusal the deploy engine runs on that result refuses it. The
 * engine test for this refusal mocks the resolver, and the integ arm
 * (secrets-dynamic-ref Phase 1b6) is the only other place this shape runs --
 * so the claim that `resolveSub` keeps the mark is pinned here.
 *
 * `Fn::Sub` is the shape that reaches the refusal in practice: CDK's
 * `CfnOutput` rejects a LITERAL export name carrying such a character at
 * synth and skips that check for a token.
 */
describe('Fn::Sub Export.Name carrying a nonspacing mark (issue #2889)', () => {
  const SECRET_EXPR = '{{resolve:secretsmanager:prod/app:SecretString:password}}';
  const HEAD = 'hunter2';
  const TAIL = 'secret-pass';
  const PLAINTEXT = `${HEAD}${TAIL}`;
  const MARK = String.fromCharCode(0x09bc);
  const template: CloudFormationTemplate = { Resources: {} };

  function context(recorded: Map<string, string>): ResolverContext {
    return { template, resources: {}, recordedSecretValues: recorded };
  }

  beforeEach(() => {
    resetAccountInfoCache();
    mockSecretsManagerSend.mockReset();
    mockSecretsManagerSend.mockResolvedValue({
      SecretString: JSON.stringify({ password: PLAINTEXT }),
    });
  });

  it('resolves with the mark intact, and the export-name refusal refuses the alias', async () => {
    const resolver = new IntrinsicFunctionResolver();

    // The outputs pass: an output VALUE resolving the secret records it.
    const recordedThisPass = new Map<string, string>();
    expect(await resolver.resolve(SECRET_EXPR, context(recordedThisPass))).toBe(PLAINTEXT);
    expect(recordedThisPass.get(PLAINTEXT)).toBe(SECRET_EXPR);

    // The name pass, with its OWN map as the engine does: nothing secret is
    // substituted into it, so only containment can refuse it.
    const nameSecrets = new Map<string, string>();
    const name = await resolver.resolve(
      { 'Fn::Sub': ['x-${Head}${Mark}${Tail}', { Head: HEAD, Mark: MARK, Tail: TAIL }] },
      context(nameSecrets)
    );
    expect(name).toBe(`x-${HEAD}${MARK}${TAIL}`);
    expect(nameSecrets.size).toBe(0);
    expect(String(name)).not.toContain(PLAINTEXT);

    // The engine's call (deploy-engine.ts, the export-alias refusal): an
    // exposure means the alias is refused, not published.
    expect(exportNameSecretExposure(String(name), nameSecrets, recordedThisPass)).toEqual(
      new Map([[PLAINTEXT, SECRET_EXPR]])
    );
  });
});
