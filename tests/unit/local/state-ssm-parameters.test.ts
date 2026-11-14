import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// go-to-k/cdkd#6307: `--from-state` dropped every env var that `Ref`s an
// SSM-typed template parameter (`ssm.StringParameter.valueForStringParameter`)
// — state.json records no parameter values, and only cdk-local's
// `--from-cfn-stack` provider read SSM. cdkd's `--from-state` providers now
// read it too, in the stack's region, routed like a `{{resolve:ssm:...}}`
// lookup: the emulator under `--aws-emulator`, real AWS in mixed mode ONLY for
// a `"real-aws"` exception naming SSM, and as the CALLER, never a `--role-arn`.
//
// The state loader is doubled; the SSM client is the real SDK client with its
// `send` doubled, so each case reads the endpoint, region and credentials the
// request WOULD have gone out with.

vi.mock('../../../src/utils/logger.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/utils/logger.js')>();
  const leaf = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => leaf };
  return { ...actual, getLogger: () => leaf };
});

const loader = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: loader.load,
  buildCrossStackResolver: vi.fn(async () => undefined),
}));

import { SSMClient } from '@aws-sdk/client-ssm';
import { setActiveWorkloadAwsWiring, setAwsEmulatorServiceRouting } from 'cdk-local/internal';
import { createLocalStateProvider } from '../../../src/cli/commands/local-state-source.js';
import { mixedModeEmulatorOverride } from '../../../src/local/local-aws-wiring.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';
import { templateSsmParameters } from '../../../src/local/state-ssm-parameters.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setAwsEndpointOverrideSource,
  setPreAssumeEnvCredentials,
} from '../../../src/utils/aws-client-defaults.js';

const EMULATOR_URL = 'https://127.0.0.1:9381';
const EMULATOR_KEYS = { accessKeyId: 'EMULATORKEY000000000', secretAccessKey: 'emulator-secret' };
const REAL_KEYS = { accessKeyId: 'REALCALLERKEYID00000', secretAccessKey: 'real-secret' };
const OVERRIDE = { endpoint: EMULATOR_URL, credentials: EMULATOR_KEYS };

function mixed(envOverrides: Record<string, unknown>, realServices: string[]): void {
  setActiveWorkloadAwsWiring({
    mode: 'forward',
    mixed: { realServices, emulatorClientOverride: OVERRIDE },
    dispose: () => {},
  } as never);
  setAwsEmulatorServiceRouting({ realServices, override: OVERRIDE, envOverrides });
  setAwsEndpointOverrideSource(mixedModeEmulatorOverride);
}

/** What `valueForStringParameter(this, '/app/param')` synthesizes, plus CDK's `BootstrapVersion`. */
const TEMPLATE = {
  Parameters: {
    SsmParameterValueappparamParameter: {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/app/param',
    },
    BootstrapVersion: {
      Type: 'AWS::SSM::Parameter::Value<String>',
      Default: '/cdk-bootstrap/hnb659fds/version',
    },
  },
  Resources: {
    Fn: {
      Type: 'AWS::Lambda::Function',
      Properties: {
        Environment: { Variables: { PARAM_VALUE: { Ref: 'SsmParameterValueappparamParameter' } } },
      },
    },
  },
  Rules: { CheckBootstrapVersion: { Assertions: [{ Assert: { Ref: 'BootstrapVersion' } }] } },
};

interface Sent {
  names: string[];
  endpoint: string | undefined;
  region: string;
  keyId: string;
}
let sent: Sent[];
let ssmResponse: { Parameters: Array<{ Name: string; Value: string; Type?: string }> };

const ENV_KEYS = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'];
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  delete process.env['AWS_PROFILE'];
  delete process.env['AWS_SESSION_TOKEN'];
  process.env['AWS_ACCESS_KEY_ID'] = REAL_KEYS.accessKeyId;
  process.env['AWS_SECRET_ACCESS_KEY'] = REAL_KEYS.secretAccessKey;
  process.env['AWS_REGION'] = 'us-east-1';
  sent = [];
  ssmResponse = { Parameters: [{ Name: '/app/param', Value: 'value-6307', Type: 'String' }] };
  loader.load.mockReset();
  loader.load.mockResolvedValue({
    state: { version: 1, stackName: 'S', resources: {}, outputs: {}, lastModified: 0 },
    region: 'eu-west-1',
    stateBucket: 'b',
  });
  vi.spyOn(SSMClient.prototype, 'send').mockImplementation(async function (
    this: SSMClient,
    command: { input: { Names?: string[] } }
  ) {
    const ep = this.config.endpoint ? await this.config.endpoint() : undefined;
    const creds = await this.config.credentials();
    sent.push({
      names: command.input.Names ?? [],
      endpoint: ep ? `${ep.protocol}//${ep.hostname}${ep.port ? `:${ep.port}` : ''}` : undefined,
      region: await this.config.region(),
      keyId: creds.accessKeyId,
    });
    return ssmResponse;
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  setAwsEmulatorServiceRouting(undefined);
  setActiveWorkloadAwsWiring(undefined);
  setAwsEndpointOverrideSource(undefined);
  resetAwsClientDefaults();
});

const fromState = (workload?: object) =>
  createLocalStateProvider(
    { fromState: true, statePrefix: 'cdkd' },
    'S',
    'us-east-1',
    workload ? { workload } : {}
  )!;

describe('--from-state resolves SSM-typed template parameters (#6307)', () => {
  it('reads the referenced parameter in the loaded record region; BootstrapVersion (Rules only) is not read', async () => {
    const provider = fromState();
    await provider.load('S', 'us-east-1');
    const out = await provider.resolveTemplateSsmParameters!(TEMPLATE as never);
    expect(out).toEqual({ values: { SsmParameterValueappparamParameter: 'value-6307' }, secureStringLogicalIds: [] });
    expect(sent).toEqual([
      { names: ['/app/param'], endpoint: undefined, region: 'eu-west-1', keyId: REAL_KEYS.accessKeyId },
    ]);
  });

  it('a template whose only SSM parameter is BootstrapVersion makes no SSM call', async () => {
    const provider = new S3LocalStateProvider({ statePrefix: 'cdkd' });
    const out = await provider.resolveTemplateSsmParameters({
      Parameters: { BootstrapVersion: TEMPLATE.Parameters.BootstrapVersion },
      Rules: TEMPLATE.Rules,
    } as never);
    expect(out).toEqual({ values: {}, secureStringLogicalIds: [] });
    expect(sent).toEqual([]);
  });

  it('a SecureString value is marked, so the substitution keeps it off the argv', async () => {
    ssmResponse = { Parameters: [{ Name: '/app/param', Value: 's3cret', Type: 'SecureString' }] };
    const ctx = await templateSsmParameters(fromState(), TEMPLATE as never);
    expect(ctx.parameters).toEqual({ SsmParameterValueappparamParameter: 's3cret' });
    expect([...(ctx.sensitiveParameters ?? [])]).toEqual(['SsmParameterValueappparamParameter']);
  });

  it('runs as the CALLER, never a published --role-arn role', async () => {
    // As `applyRoleArnIfSet` leaves it: the caller's triple snapshotted, the role published.
    setPreAssumeEnvCredentials({ ...REAL_KEYS });
    setAssumedRoleCredentials({
      accessKeyId: 'ASSUMEDROLEKEY000000',
      secretAccessKey: 'role-secret',
      sessionToken: 'tok',
    } as never);
    await fromState().resolveTemplateSsmParameters!(TEMPLATE as never);
    expect(sent.map((s) => s.keyId)).toEqual([REAL_KEYS.accessKeyId]);
  });

  describe('routing', () => {
    it('--aws-emulator alone: the emulator', async () => {
      setAwsEndpointOverrideSource(() => OVERRIDE);
      await fromState().resolveTemplateSsmParameters!(TEMPLATE as never);
      expect(sent.map((s) => [s.endpoint, s.keyId])).toEqual([[EMULATOR_URL, EMULATOR_KEYS.accessKeyId]]);
    });

    it('mixed mode, an exception for ANOTHER service: the emulator — even though the merge takes this method from its real side', async () => {
      mixed({ Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' } }, ['DYNAMODB']);
      const provider = fromState({ logicalId: 'Fn', cdkPath: 'S/Fn/Resource' });
      await provider.load('S', 'us-east-1');
      await provider.resolveTemplateSsmParameters!(TEMPLATE as never);
      expect(sent.map((s) => [s.endpoint, s.keyId])).toEqual([[EMULATOR_URL, EMULATOR_KEYS.accessKeyId]]);
    });

    it('mixed mode, SSM excepted under Parameters: real AWS, as the caller', async () => {
      mixed({ Parameters: { AWS_ENDPOINT_URL_SSM: 'real-aws' } }, ['SSM']);
      await fromState({ logicalId: 'Fn', cdkPath: 'S/Fn/Resource' }).resolveTemplateSsmParameters!(
        TEMPLATE as never
      );
      expect(sent.map((s) => [s.endpoint, s.keyId])).toEqual([[undefined, REAL_KEYS.accessKeyId]]);
    });

    it("mixed mode, SSM excepted in ONE workload's own section: real AWS for it, the emulator for another", async () => {
      const env = {
        Parameters: { AWS_ENDPOINT_URL_DYNAMODB: 'real-aws' },
        'S/FnA': { AWS_ENDPOINT_URL_SSM: 'real-aws' },
      };
      mixed(env, ['DYNAMODB', 'SSM']);
      await fromState({ logicalId: 'FnA', cdkPath: 'S/FnA/Resource' }).resolveTemplateSsmParameters!(
        TEMPLATE as never
      );
      await fromState({ logicalId: 'FnB', cdkPath: 'S/FnB/Resource' }).resolveTemplateSsmParameters!(
        TEMPLATE as never
      );
      expect(sent.map((s) => s.endpoint)).toEqual([undefined, EMULATOR_URL]);
    });
  });
});
