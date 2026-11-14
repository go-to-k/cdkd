import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { setActiveWorkloadAwsWiring, setAwsEmulatorServiceRouting } from 'cdk-local/internal';
import {
  maybeSuggestAssumeRole,
  resolveBareAssumeRoleFromState,
} from '../../../src/cli/commands/local-invoke.js';
import { resolveStartApiAssumeRoleArn } from '../../../src/cli/commands/local-start-api.js';
import { resolveAssumeRoleArn } from '../../../src/cli/commands/local-invoke-agentcore.js';
import { getLogger } from '../../../src/utils/logger.js';
import type { StackState } from '../../../src/types/state.js';

/**
 * go-to-k/cdkd#6252: in AWS Emulator mixed mode the Lambda-side role flags
 * (`local invoke --assume-role`, `local start-api --assume-role-auto`,
 * `local invoke-agentcore --assume-role`) assume the role in REAL AWS, so a
 * bare flag must not read the role from a state record whose IAM resources
 * are the emulator's (account 000000000000) — the same rule `local run-task`
 * follows (`mixed-mode-emulator-iam`, #6189).
 */

const EMULATOR_URL = 'https://127.0.0.1:9297';
const EMULATOR_ARN = 'arn:aws:iam::000000000000:role/Stack-FnServiceRole-emu';

function mixedWiring(realServices: string[]): Parameters<typeof setActiveWorkloadAwsWiring>[0] {
  // The routing cdk-local consults per service; activation installs it beside the wiring.
  setAwsEmulatorServiceRouting({
    realServices,
    override: { endpoint: EMULATOR_URL },
    envOverrides: undefined,
  } as unknown as Parameters<typeof setAwsEmulatorServiceRouting>[0]);
  return {
    mode: 'forward',
    env: { AWS_ENDPOINT_URL: 'https://127.0.0.1:47297' },
    scrubEnvKeys: [],
    mounts: [],
    loopbackPorts: [9297, 47297],
    probeHealth: true,
    mixed: {
      realServices,
      emulatorEndpoint: { url: EMULATOR_URL, hostname: '127.0.0.1', port: 9297, loopback: true },
      resignPort: 47297,
      resignEndpoint: 'https://127.0.0.1:47297',
      emulatorCredentials: { accessKeyId: 'emulator-key', secretAccessKey: 'emulator-secret' },
      region: 'us-east-1',
      resignConfigHostPath: '/tmp/cdkd-unit-resign/resign.json',
      emulatorClientOverride: {
        endpoint: EMULATOR_URL,
        credentials: { accessKeyId: 'emulator-key', secretAccessKey: 'emulator-secret' },
      },
    },
    dispose: () => {},
  } as unknown as Parameters<typeof setActiveWorkloadAwsWiring>[0];
}

const STATE = {
  resources: {
    Fn: {
      physicalId: 'fn',
      resourceType: 'AWS::Lambda::Function',
      properties: { Role: { 'Fn::GetAtt': ['FnServiceRole', 'Arn'] } },
      attributes: {},
      dependencies: [],
    },
    FnServiceRole: {
      physicalId: 'Stack-FnServiceRole-emu',
      resourceType: 'AWS::IAM::Role',
      properties: {},
      attributes: { Arn: EMULATOR_ARN },
      dependencies: [],
    },
    Runtime: {
      physicalId: 'rt',
      resourceType: 'AWS::BedrockAgentCore::Runtime',
      properties: { RoleArn: EMULATOR_ARN },
      attributes: {},
      dependencies: [],
    },
  },
} as unknown as StackState;

let warn: ReturnType<typeof vi.spyOn>;
let info: ReturnType<typeof vi.spyOn>;
const text = (spy: ReturnType<typeof vi.spyOn>): string =>
  (spy.mock.calls as unknown[][]).map((c) => String(c[0])).join('\n');

beforeEach(() => {
  warn = vi.spyOn(getLogger(), 'warn').mockImplementation(() => undefined);
  info = vi.spyOn(getLogger(), 'info').mockImplementation(() => undefined);
  vi.spyOn(getLogger(), 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
  setActiveWorkloadAwsWiring(undefined);
  setAwsEmulatorServiceRouting(undefined);
  vi.restoreAllMocks();
});

const startApi = () =>
  resolveStartApiAssumeRoleArn({
    logicalId: 'Fn',
    assumeRole: { perLambda: {}, bareAutoResolve: true },
    lambdaResource: { Type: 'AWS::Lambda::Function', Properties: {} },
    stateBundle: { state: STATE } as never,
  });
const agentCore = () =>
  resolveAssumeRoleArn(
    { assumeRole: true } as never,
    { logicalId: 'Runtime', roleArn: undefined } as never,
    STATE as never
  );

describe('IAM on the emulator side: the record is not used, and the warning says why', () => {
  beforeEach(() => {
    setActiveWorkloadAwsWiring(mixedWiring(['DYNAMODB']));
  });

  it.each([
    ['local invoke --assume-role', () => resolveBareAssumeRoleFromState(STATE, 'Fn')],
    ['local start-api --assume-role-auto', startApi],
    ['local invoke-agentcore --assume-role', agentCore],
  ])('%s', (_name, resolve) => {
    expect(resolve()).toBeUndefined();
    const w = text(warn);
    expect(w).toContain('AWS Emulator mixed mode');
    expect(w).toContain('AWS_ENDPOINT_URL_IAM');
    expect(w).not.toContain(EMULATOR_ARN);
  });

  it('local invoke prints no "Re-run with --assume-role" hint', () => {
    expect(maybeSuggestAssumeRole({ fromState: true }, STATE, 'Fn')).toBe(false);
    expect(text(info)).not.toContain('Re-run with --assume-role');
  });
});

describe('IAM excepted under Parameters: the record names the role', () => {
  beforeEach(() => {
    setActiveWorkloadAwsWiring(mixedWiring(['DYNAMODB', 'IAM']));
  });

  it.each([
    ['local invoke --assume-role', () => resolveBareAssumeRoleFromState(STATE, 'Fn')],
    ['local start-api --assume-role-auto', startApi],
    ['local invoke-agentcore --assume-role', agentCore],
  ])('%s', (_name, resolve) => {
    expect(resolve()).toBe(EMULATOR_ARN);
    expect(text(warn)).not.toContain('mixed mode');
  });

  it('local invoke still hints', () => {
    expect(maybeSuggestAssumeRole({ fromState: true }, STATE, 'Fn')).toBe(true);
    expect(text(info)).toContain('Re-run with --assume-role');
  });
});
