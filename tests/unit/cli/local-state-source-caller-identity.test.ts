import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';

import {
  CfnLocalStateProvider,
  createLocalStateProvider,
  type LocalStateSourceOptions,
} from '../../../src/cli/commands/local-state-source.js';
import { isIamRoleArn } from '../../../src/utils/role-arn.js';

/**
 * Issue go-to-k/cdkd#3240: `createLocalStateProvider` is only the factory shim
 * (mutual exclusion plus cdkd's `--from-state` factory). The identity
 * `--from-cfn-stack` reads as is cdk-local's to choose -- the caller, once the
 * `--role-arn` assume is recorded with it -- so cdkd must NOT shadow the
 * provider's getters.
 */

function cfnOptions(overrides: Partial<LocalStateSourceOptions> = {}): LocalStateSourceOptions {
  return {
    fromState: false,
    statePrefix: 'cdkd',
    fromCfnStack: 'DeployedStack',
    region: 'us-east-1',
    ...overrides,
  };
}

describe('createLocalStateProvider', () => {
  it('returns cdk-local\'s own --from-cfn-stack provider, with no cdkd-shadowed getter', () => {
    const provider = createLocalStateProvider(cfnOptions(), 'Stack', 'us-east-1');
    expect(provider).toBeInstanceOf(CfnLocalStateProvider);
    for (const getter of ['getClient', 'getLambdaClient', 'getSsmClient', 'getAgentCoreControlClient']) {
      expect(Object.hasOwn(provider!, getter)).toBe(false);
    }
    provider!.dispose?.();
  });

  it('builds the --from-state provider, not the CFn one', () => {
    const provider = createLocalStateProvider(
      cfnOptions({ fromCfnStack: undefined, fromState: true, stateBucket: 'b' }),
      'Stack',
      'us-east-1'
    );
    expect(provider).toBeDefined();
    expect(provider).not.toBeInstanceOf(CfnLocalStateProvider);
  });

  it('returns undefined when neither state flag is set', () => {
    expect(
      createLocalStateProvider(cfnOptions({ fromCfnStack: undefined }), 'Stack', 'us-east-1')
    ).toBeUndefined();
  });

  it('refuses both state flags together', () => {
    expect(() =>
      createLocalStateProvider(cfnOptions({ fromState: true, stateBucket: 'b' }), 'Stack', 'us-east-1')
    ).toThrow();
  });
});

describe('cdkd and the installed cdk-local agree on which --role-arn is well-formed', () => {
  it("cdkd's isIamRoleArn accepts exactly what cdk-local's applyRoleArnIfSet would assume", () => {
    // cdkd's own check and the engine's must not diverge: a cdk-local release
    // that LOOSENS its check would assume an ARN cdkd refuses (or the reverse).
    // Read the engine's own pattern and length cap out of the installed bundle
    // and compare behaviour.
    const dist = dirname(fileURLToPath(import.meta.resolve('cdk-local')));
    const bundle = readdirSync(dist)
      .filter((f) => f.endsWith('.js'))
      .map((f) => readFileSync(join(dist, f), 'utf8'))
      .find((src) => src.includes('const IAM_ROLE_ARN_PATTERN = '));
    expect(bundle).toBeDefined();
    const pattern = /const IAM_ROLE_ARN_PATTERN = \/(.+)\/;\n/.exec(bundle!)?.[1];
    const maxLength = Number(/const IAM_ROLE_ARN_MAX_LENGTH = (\d+);/.exec(bundle!)?.[1]);
    expect(pattern).toBeDefined();
    expect(maxLength).toBeGreaterThan(0);
    const engine = new RegExp(pattern!);
    const engineAccepts = (v: string): boolean => v.length <= maxLength && engine.test(v);
    const corpus = [
      'arn:aws:iam::222222222222:role/deploy',
      'arn:aws-cn:iam::222222222222:role/path/deploy',
      'arn:aws-us-gov:iam::222222222222:role/a+b=c,d.e@f-g',
      'arn:aws:iam::222222222222:role/',
      'arn:aws:iam::222222222222:user/deploy',
      'arn:aws:iam::abc:role/deploy',
      // Characters in the engine's `[!-~]` but outside IAM's documented
      // `[\\w+=,.@/-]`, and a non-12-digit account: the engine assumes both,
      // so cdkd must not call them malformed.
      'arn:aws:iam::222222222222:role/p!a(t)h/de#ploy',
      'arn:aws:iam::1234:role/deploy',
      'arn:aws:iam::222222222222:role/de ploy',
      'arn:aws:sts::222222222222:assumed-role/deploy/s',
      'not-an-arn',
      '',
      `arn:aws:iam::222222222222:role/${'r'.repeat(2048)}`,
      `arn:aws:iam::222222222222:role/${'r'.repeat(2048 - 'arn:aws:iam::222222222222:role/'.length)}`,
    ];
    for (const value of corpus) {
      expect([value.slice(0, 60), isIamRoleArn(value)]).toEqual([
        value.slice(0, 60),
        engineAccepts(value),
      ]);
    }
  });
});
