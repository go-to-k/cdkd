/**
 * go-to-k/cdkd#6458: `cdkd local start-alb --from-state` resolves an
 * `authenticate-cognito` action's intrinsic config from cdkd's S3 state
 * (cdk-local 0.168.8, go-to-k/cdk-local#1005). The engine reads the state
 * through the provider cdkd registers in `cdkdExtraStateProviders`, and the
 * client id must reach the guard as the bare client id: cdkd records an
 * `AWS::Cognito::UserPoolClient` as `<poolId>|<clientId>`, and that compound
 * id would become the guard's audience and match no token. The S3 provider's
 * `withCfnRefPhysicalIds` maps it to the `Ref` value.
 *
 * The real engine boot runs with a fake `docker` (via `CDK_DOCKER`) that
 * answers `version` and fails everything else. The boot therefore gets past
 * the guard resolution, which needs no container, and stops at the shared
 * network. The state the engine loaded for the guard is captured from the
 * provider it called, and the plan's own `UserPoolClientId` intrinsic is
 * substituted against it with cdk-local's substitution engine, the one the
 * guard resolver uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAlbFrontDoor } from 'cdk-local/internal';
import type { StackState } from '../../../src/types/state.js';

const mocks = vi.hoisted(() => ({ loadStateForStackMock: vi.fn() }));

vi.mock('../../../src/cli/commands/local-state-loader.js', () => ({
  loadStateForStack: mocks.loadStateForStackMock,
  buildCrossStackResolver: vi.fn(),
}));

import { albStrategy, runEcsServiceEmulator } from '../../../src/cli/commands/ecs-service-emulator.js';
import { cdkdExtraStateProviders } from '../../../src/cli/commands/local-state-source.js';
import { S3LocalStateProvider } from '../../../src/local/s3-local-state-provider.js';
import { substituteAgainstState } from '../../../src/local/state-resolver.js';
import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

const REGION = 'us-east-1';
const POOL_ID = 'us-east-1_AbC123xyz';
const CLIENT_ID = 'client1234567890';

const stack = {
  stackName: 'AlbStack',
  displayName: 'AlbStack',
  artifactId: 'AlbStack',
  region: REGION,
  dependencyNames: [],
  template: {
    Resources: {
      WebLB: {
        Type: 'AWS::ElasticLoadBalancingV2::LoadBalancer',
        Properties: { Type: 'application' },
      },
      Pool: { Type: 'AWS::Cognito::UserPool', Properties: {} },
      Client: {
        Type: 'AWS::Cognito::UserPoolClient',
        Properties: { UserPoolId: { Ref: 'Pool' } },
      },
      Domain: {
        Type: 'AWS::Cognito::UserPoolDomain',
        Properties: { Domain: 'probe-6458', UserPoolId: { Ref: 'Pool' } },
      },
      WebListener: {
        Type: 'AWS::ElasticLoadBalancingV2::Listener',
        Properties: {
          LoadBalancerArn: { Ref: 'WebLB' },
          Port: 80,
          Protocol: 'HTTP',
          // The shape `ListenerAction.authenticateCognito({ userPool, userPoolClient, ... })` emits.
          DefaultActions: [
            {
              Type: 'authenticate-cognito',
              Order: 1,
              AuthenticateCognitoConfig: {
                UserPoolArn: { 'Fn::GetAtt': ['Pool', 'Arn'] },
                UserPoolClientId: { Ref: 'Client' },
                UserPoolDomain: { Ref: 'Domain' },
              },
            },
            {
              Type: 'fixed-response',
              Order: 2,
              FixedResponseConfig: { StatusCode: '200', MessageBody: 'secret' },
            },
          ],
        },
      },
    },
  },
} as unknown as StackInfo;

const recorded: StackState = {
  version: 9,
  stackName: 'AlbStack',
  region: REGION,
  resources: {
    Pool: { physicalId: POOL_ID, resourceType: 'AWS::Cognito::UserPool', properties: {} },
    Client: {
      physicalId: `${POOL_ID}|${CLIENT_ID}`,
      resourceType: 'AWS::Cognito::UserPoolClient',
      properties: {},
    },
    Domain: {
      physicalId: 'probe-6458',
      resourceType: 'AWS::Cognito::UserPoolDomain',
      properties: {},
    },
  },
  outputs: {},
  lastModified: 1,
};

let dockerDir: string;
let dockerBefore: string | undefined;
let logged: string[];

beforeEach(() => {
  dockerDir = mkdtempSync(join(tmpdir(), 'cdkd-6458-docker-'));
  const script = join(dockerDir, 'docker');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  version) echo 27.0.0 ;;',
      '  *) echo "fake docker refuses: $*" 1>&2; exit 1 ;;',
      'esac',
      '',
    ].join('\n')
  );
  chmodSync(script, 0o755);
  dockerBefore = process.env['CDK_DOCKER'];
  process.env['CDK_DOCKER'] = script;
  logged = [];
  const capture = (...args: unknown[]): void => {
    logged.push(args.map(String).join(' '));
  };
  vi.spyOn(console, 'log').mockImplementation(capture);
  vi.spyOn(console, 'warn').mockImplementation(capture);
  vi.spyOn(console, 'error').mockImplementation(capture);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as never);
  mocks.loadStateForStackMock.mockReset();
  mocks.loadStateForStackMock.mockImplementation(async () => ({
    state: structuredClone(recorded),
    region: REGION,
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  if (dockerBefore === undefined) delete process.env['CDK_DOCKER'];
  else process.env['CDK_DOCKER'] = dockerBefore;
  rmSync(dockerDir, { recursive: true, force: true });
});

async function bootUnderFromState(): Promise<{
  error: unknown;
  loads: Array<StackState['resources']>;
}> {
  const loads: Array<StackState['resources']> = [];
  const realLoad = S3LocalStateProvider.prototype.load;
  vi.spyOn(S3LocalStateProvider.prototype, 'load').mockImplementation(async function (
    this: S3LocalStateProvider,
    ...args: Parameters<typeof realLoad>
  ) {
    const record = await realLoad.apply(this, args);
    if (record) loads.push(record.resources as StackState['resources']);
    return record;
  });
  const options = {
    output: 'cdk.out',
    verbose: false,
    cluster: 'cdkd6458',
    containerHost: '127.0.0.1',
    pull: false,
    maxTasks: 3,
    restartPolicy: 'on-failure',
    app: 'node app.js',
    fromState: true,
    stateBucket: 'probe-bucket',
    statePrefix: 'cdkd',
  } as never;
  const synthesizer = { synthesize: async () => ({ stacks: [stack] }) };
  const error = await runEcsServiceEmulator(
    ['AlbStack:WebLB'],
    options,
    albStrategy(options),
    cdkdExtraStateProviders,
    synthesizer as never
  ).then(
    () => undefined,
    (err: unknown) => err
  );
  return { error, loads };
}

describe('cdkd local start-alb --from-state resolves an authenticate-cognito guard (#6458)', () => {
  it("hands the guard resolver the client's bare id from cdkd's compound record", async () => {
    const { error, loads } = await bootUnderFromState();

    // The boot went past the guard resolution and stopped at the first
    // docker call that needs a daemon, not earlier.
    expect(String(error)).toMatch(/fake docker refuses/);
    // cdkd's S3 provider was the one the engine asked, for the ALB's stack.
    expect(mocks.loadStateForStackMock).toHaveBeenCalled();
    expect(mocks.loadStateForStackMock.mock.calls[0]?.[0]).toBe('AlbStack');
    expect(loads).toHaveLength(1);
    const resources = loads[0]!;
    expect(resources['Client']?.physicalId).toBe(CLIENT_ID);

    // The plan's own audience intrinsic, substituted against what the engine
    // received, is the bare client id the token's `aud` carries.
    const plan = resolveAlbFrontDoor(stack, 'WebLB');
    const pending = plan.listeners[0]?.defaultAuthGuard?.pending;
    expect(pending?.audience).toEqual({ Ref: 'Client' });
    expect(substituteAgainstState(pending?.audience, { resources })).toEqual({
      kind: 'literal',
      value: CLIENT_ID,
    });

    // Resolved, so no placeholder-guard warning was printed.
    expect(logged.join('\n')).not.toMatch(/could not resolve|could not be resolved/);
  });

  it('warns about the placeholder guard when the record has no row for the pool', async () => {
    // The counterpart that proves the capture above sees the engine's
    // warnings: the same boot, with nothing in the record to resolve.
    mocks.loadStateForStackMock.mockReset();
    mocks.loadStateForStackMock.mockImplementation(async () => ({
      state: { ...structuredClone(recorded), resources: {} },
      region: REGION,
    }));
    const { error } = await bootUnderFromState();
    expect(String(error)).toMatch(/fake docker refuses/);
    expect(logged.join('\n')).toMatch(/UserPoolArn is an intrinsic .* could not resolve/);
  });
});
