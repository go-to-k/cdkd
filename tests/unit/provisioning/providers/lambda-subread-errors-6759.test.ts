/**
 * go-to-k/cdkd#6759: `LambdaFunctionProvider.readCurrentState` reads five
 * settings by their own calls. Each caught ANY failure and omitted its key,
 * so an AccessDenied or a throttle left the setting uncompared (or read as a
 * removal). Now only the not-found answers -- `ResourceNotFoundException`,
 * and for code signing `CodeSigningConfigNotFoundException` -- omit the key;
 * every other failure
 * rejects, which `cdkd drift` reports as `notCompared: readFailed`.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  CodeSigningConfigNotFoundException,
  InvalidParameterValueException,
  ResourceNotFoundException,
  TooManyRequestsException,
} from '@aws-sdk/client-lambda';

const mockSend = vi.fn();

vi.mock('../../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
    ec2: { send: vi.fn() },
  }),
}));

import { LambdaFunctionProvider } from '../../../../src/provisioning/providers/lambda-function-provider.js';

type Ctor = new (opts: { message: string; $metadata: object }) => Error;
const modeled = (C: Ctor): Error => new C({ message: 'x', $metadata: {} });
const denied = (): Error => Object.assign(new Error('not authorized'), { name: 'AccessDeniedException' });

interface Site {
  key: string;
  command: string;
  /** The answer that carries the setting. */
  answer: Record<string, unknown>;
  absentErrors: Array<[string, () => Error]>;
}

const absentCommon: Array<[string, () => Error]> = [
  ['ResourceNotFoundException', () => modeled(ResourceNotFoundException)],
];

const sites: Site[] = [
  {
    key: 'FunctionScalingConfig',
    command: 'GetFunctionScalingConfigCommand',
    answer: { RequestedFunctionScalingConfig: { MinExecutionEnvironments: 1 } },
    absentErrors: absentCommon,
  },
  {
    key: 'RecursiveLoop',
    command: 'GetFunctionRecursionConfigCommand',
    answer: { RecursiveLoop: 'Allow' },
    absentErrors: absentCommon,
  },
  {
    key: 'ReservedConcurrentExecutions',
    command: 'GetFunctionConcurrencyCommand',
    answer: { ReservedConcurrentExecutions: 5 },
    absentErrors: absentCommon,
  },
  {
    key: 'RuntimeManagementConfig',
    command: 'GetRuntimeManagementConfigCommand',
    answer: { UpdateRuntimeOn: 'FunctionUpdate' },
    absentErrors: absentCommon,
  },
  {
    key: 'CodeSigningConfigArn',
    command: 'GetFunctionCodeSigningConfigCommand',
    answer: { CodeSigningConfigArn: 'arn:aws:lambda:us-east-1:123456789012:code-signing-config:csc-1' },
    absentErrors: [
      ...absentCommon,
      ['CodeSigningConfigNotFoundException', () => modeled(CodeSigningConfigNotFoundException)],
    ],
  },
];

/**
 * A ZIP function attached to a capacity provider, so every one of the five
 * reads is reached. `failing` names the read that answers `error`.
 */
function stub(failing?: string, error?: Error): void {
  mockSend.mockImplementation(async (cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'GetFunctionCommand') {
      return {
        Configuration: {
          FunctionName: 'fn',
          Runtime: 'nodejs20.x',
          Handler: 'index.handler',
          Role: 'arn:aws:iam::123456789012:role/r',
          PackageType: 'Zip',
          CapacityProviderConfig: {
            LambdaManagedInstancesCapacityProviderConfig: {
              CapacityProviderArn: 'arn:aws:lambda:us-east-1:123456789012:capacity-provider:cp',
            },
          },
        },
      };
    }
    if (name === failing) throw error;
    return sites.find((s) => s.command === name)?.answer ?? {};
  });
}

const read = (provider: LambdaFunctionProvider) =>
  provider.readCurrentState('fn', 'Fn', 'AWS::Lambda::Function');

describe('Lambda setting sub-reads reach readFailed (go-to-k/cdkd#6759)', () => {
  let provider: LambdaFunctionProvider;
  beforeEach(() => {
    vi.clearAllMocks();
    provider = new LambdaFunctionProvider();
  });

  it('reads every setting when each call answers (the fixture reaches all five)', async () => {
    stub();
    const live = (await read(provider)) as Record<string, unknown>;
    for (const site of sites) expect(live).toHaveProperty(site.key);
    const sent = mockSend.mock.calls.map((c) => (c[0] as object).constructor.name);
    for (const site of sites) expect(sent).toContain(site.command);
  });

  describe.each(sites)('$key ($command)', (site) => {
    it.each([
      ['AccessDeniedException', denied],
      ['TooManyRequestsException', () => modeled(TooManyRequestsException)],
      // A refused request proves nothing about the setting.
      ['InvalidParameterValueException', () => modeled(InvalidParameterValueException)],
    ] as Array<[string, () => Error]>)('rejects when the read fails with %s', async (name, make) => {
      stub(site.command, make());
      await expect(read(provider)).rejects.toMatchObject({ name });
    });

    it.each(site.absentErrors)('omits the key, as before, on %s', async (_name, make) => {
      stub(site.command, make());
      const live = (await read(provider)) as Record<string, unknown>;
      expect(typeof live).toBe('object');
      expect(Object.hasOwn(live, site.key)).toBe(false);
      // Every other setting is still read.
      for (const other of sites) if (other !== site) expect(live).toHaveProperty(other.key);
    });
  });
});
