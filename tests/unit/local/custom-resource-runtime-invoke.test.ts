import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { CdkdError } from '../../../src/utils/error-handler.js';

import type { StackInfo } from '../../../src/synthesis/assembly-reader.js';

/**
 * go-to-k/cdkd#6206: `invokeCustomResourceFunctionLocally` end to end with
 * Docker, the RIE and the image plan stubbed — every branch that declines
 * (and so leaves the event to the emulator), what the container is started
 * with, the answer it is turned into, and the teardown.
 */

const log = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/utils/logger.js', () => {
  const leaf = { ...log, error: vi.fn(), getLevel: () => 'info', child: () => leaf };
  return { getLogger: () => leaf };
});

const wiring = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('cdk-local/internal', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getActiveWorkloadAwsWiring: () => wiring.value,
}));

const dr = vi.hoisted(() => ({
  ensureDockerAvailable: vi.fn(),
  imageInLocalCache: vi.fn(),
  pullImage: vi.fn(),
  runDetached: vi.fn(),
  startNamespacePortForwarder: vi.fn(),
  removeContainer: vi.fn(),
  removeContainersSync: vi.fn(),
  killAndDrainContainerLogs: vi.fn(),
  followContainerLogs: vi.fn(),
  pickFreePort: vi.fn(),
  dockerBridgeGateway: vi.fn(),
}));
vi.mock('../../../src/local/docker-runner.js', () => dr);
vi.mock('../../../src/local/docker-version.js', () => ({
  resolveHostGatewayExtraHosts: () => Promise.resolve([]),
}));

const rie = vi.hoisted(() => ({ waitForRieReady: vi.fn(), invokeRie: vi.fn() }));
vi.mock('../../../src/local/rie-client.js', () => rie);

const plan = vi.hoisted(() => ({ resolveZipImagePlan: vi.fn() }));
vi.mock('../../../src/cli/commands/local-invoke/image-plan.js', () => plan);

const assembly = vi.hoisted(() => ({ stacks: [] as unknown[] }));
vi.mock('../../../src/synthesis/synthesized-stacks.js', () => ({
  synthesizedStacks: () => assembly.stacks,
}));

const {
  invokeCustomResourceFunctionLocally,
  lambdaClientForRegion,
  resetLocalCustomResourceRuntimeForTest,
} =
  await import('../../../src/local/custom-resource-runtime.js');
const { setLocalCustomResourceRuntimeEnabled, withCustomResourceStack } =
  await import('../../../src/local/custom-resource-runtime-gate.js');

const TOKEN = 'arn:aws:lambda:eu-west-1:000000000000:function:Handler-abc';
const RESPONSE_URL =
  'https://127.0.0.1:9297/cdkd-state/custom-resource-responses/r1.json?X-Amz-Signature=old';
const DEPLOYED = {
  FunctionName: 'Handler-abc',
  Handler: 'index.handler',
  Runtime: 'nodejs22.x',
  Timeout: 77,
  MemorySize: 333,
  Environment: { Variables: { SECRET_TOKEN: 's3cr3t', BUCKET: 'b' } },
};
const request = { RequestType: 'Create', LogicalResourceId: 'Cr', ResponseURL: RESPONSE_URL };

function appStack(name = 'App'): StackInfo {
  return {
    stackName: name,
    displayName: name,
    artifactId: name,
    template: {
      Resources: {
        Cr: { Type: 'Custom::Thing', Properties: { ServiceToken: { 'Fn::GetAtt': ['Fn', 'Arn'] } } },
        Fn: {
          Type: 'AWS::Lambda::Function',
          Properties: { Code: { ZipFile: 'x' }, Handler: 'index.handler', Runtime: 'nodejs22.x' },
        },
      },
    },
  } as unknown as StackInfo;
}

let lambdaSend: ReturnType<typeof vi.fn>;
let clients: { lambda: never; s3: S3Client };
let layersTmpDir: string;
let logSinks: { stdout(c: Buffer): void } | undefined;

beforeEach(() => {
  resetLocalCustomResourceRuntimeForTest();
  for (const f of [...Object.values(dr), ...Object.values(rie), ...Object.values(log)]) f.mockReset();
  wiring.value = {
    mode: 'emulator',
    emulatorEndpoint: { url: 'https://127.0.0.1:9297', loopback: true },
  };
  assembly.stacks = [appStack()];
  dr.ensureDockerAvailable.mockResolvedValue(undefined);
  dr.imageInLocalCache.mockResolvedValue(true);
  dr.pickFreePort.mockResolvedValue(45678);
  dr.runDetached.mockResolvedValue('ctr-1');
  dr.startNamespacePortForwarder.mockResolvedValue('fwd-1');
  dr.removeContainer.mockResolvedValue(undefined);
  dr.killAndDrainContainerLogs.mockResolvedValue(undefined);
  dr.followContainerLogs.mockImplementation((_id: string, sinks: { stdout(c: Buffer): void }) => {
    logSinks = sinks;
    return { stop: vi.fn(), drain: vi.fn() };
  });
  rie.waitForRieReady.mockResolvedValue(undefined);
  rie.invokeRie.mockImplementation(() => {
    logSinks?.stdout(Buffer.from('handler log line\n'));
    return Promise.resolve({ payload: null, raw: 'null' });
  });
  layersTmpDir = mkdtempSync(join(tmpdir(), 'cdkd-cr-runtime-test-'));
  plan.resolveZipImagePlan.mockResolvedValue({
    image: 'public.ecr.aws/lambda/nodejs:22',
    mounts: [],
    extraMounts: [],
    cmd: ['index.handler'],
    layersTmpDir,
  });
  lambdaSend = vi.fn().mockResolvedValue(DEPLOYED);
  clients = {
    lambda: { send: lambdaSend } as never,
    s3: new S3Client({
      region: 'eu-west-1',
      credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    }),
  };
});

const invoke = () => invokeCustomResourceFunctionLocally(clients, TOKEN, request);

describe('declines, so the event goes to the emulator', () => {
  it('without Docker: undefined and ONE warning across events', async () => {
    dr.ensureDockerAvailable.mockRejectedValue(new Error('no daemon'));
    expect(await invoke()).toBeUndefined();
    expect(await invoke()).toBeUndefined();
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(String(log.warn.mock.calls[0]![0])).toContain('Docker is not available');
    expect(dr.runDetached).not.toHaveBeenCalled();
  });

  it('when GetFunctionConfiguration fails: undefined, nothing started', async () => {
    lambdaSend.mockRejectedValue(new Error('ResourceNotFoundException'));
    expect(await invoke()).toBeUndefined();
    expect(dr.runDetached).not.toHaveBeenCalled();
  });

  it.each(['destroy', 'state destroy'])(
    'under %s with no assembly: undefined and a warning naming destroy from the app',
    async (command) => {
      setLocalCustomResourceRuntimeEnabled(true, command);
      assembly.stacks = [];
      expect(await invoke()).toBeUndefined();
      expect(String(log.warn.mock.calls[0]![0])).toMatch(
        /did not synthesize the CDK app.*cdkd destroy --aws-emulator/
      );
    }
  );

  it('under rollback with no assembly: never suggests a destroy (it would delete the stack)', async () => {
    setLocalCustomResourceRuntimeEnabled(true, 'rollback');
    assembly.stacks = [];
    expect(await invoke()).toBeUndefined();
    const warning = String(log.warn.mock.calls[0]![0]);
    expect(warning).toContain('did not synthesize the CDK app');
    expect(warning).not.toContain('destroy');
    expect(warning).toContain('--no-local-custom-resources');
  });

  it('when the function is not in the assembly: undefined and a warning', async () => {
    lambdaSend.mockResolvedValue({ ...DEPLOYED, Runtime: 'python3.13' });
    expect(await invoke()).toBeUndefined();
    expect(String(log.warn.mock.calls[0]![0])).toContain('not found in the local cloud assembly');
    expect(dr.runDetached).not.toHaveBeenCalled();
  });

  it('when the runtime image is not cached and cannot be pulled: undefined and one warning', async () => {
    dr.imageInLocalCache.mockResolvedValue(false);
    dr.pullImage.mockRejectedValue(new Error('no space left on device'));
    expect(await invoke()).toBeUndefined();
    expect(await invoke()).toBeUndefined();
    expect(dr.pullImage).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(dr.runDetached).not.toHaveBeenCalled();
  });
});

describe('the runtime image', () => {
  it('is not pulled when it is in the local cache, and the plan never pulls', async () => {
    await invoke();
    expect(dr.pullImage).not.toHaveBeenCalled();
    expect(plan.resolveZipImagePlan.mock.calls[0]![1]).toEqual({ pull: false });
  });

  it('is pulled once per process when missing', async () => {
    dr.imageInLocalCache.mockResolvedValue(false);
    dr.pullImage.mockResolvedValue(undefined);
    await invoke();
    await invoke();
    expect(dr.pullImage).toHaveBeenCalledTimes(1);
    expect(dr.runDetached).toHaveBeenCalledTimes(2);
  });
});

describe('the container', () => {
  it("gets the deployed function's env, timeout, memory and the ARN's region", async () => {
    await invoke();
    const opts = dr.runDetached.mock.calls[0]![0] as {
      env: Record<string, string>;
      sensitiveEnvKeys: Set<string>;
    };
    expect(opts.env).toMatchObject({
      SECRET_TOKEN: 's3cr3t',
      BUCKET: 'b',
      AWS_LAMBDA_FUNCTION_NAME: 'Handler-abc',
      AWS_LAMBDA_FUNCTION_TIMEOUT: '77',
      AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '333',
      AWS_REGION: 'eu-west-1',
      AWS_DEFAULT_REGION: 'eu-west-1',
    });
    // The function's variables (secrets among them) stay off the argv.
    expect([...opts.sensitiveEnvKeys].sort()).toEqual(['BUCKET', 'SECRET_TOKEN']);
  });

  it('gets the ResponseURL re-signed for 443, with the 443 forwarder to the emulator port', async () => {
    await invoke();
    expect(dr.startNamespacePortForwarder.mock.calls[0]!.slice(0, 3)).toEqual(['ctr-1', 443, 9297]);
    const sent = rie.invokeRie.mock.calls[0]![2] as { ResponseURL: string; RequestType: string };
    const url = new URL(sent.ResponseURL);
    expect(url.origin).toBe('https://127.0.0.1');
    expect(url.pathname).toBe('/cdkd-state/custom-resource-responses/r1.json');
    expect(url.searchParams.get('X-Amz-Signature')).not.toBe('old');
    expect(sent.RequestType).toBe('Create');
  });

  it('keeps the URL and starts no forwarder for an emulator on another host', async () => {
    wiring.value = {
      mode: 'emulator',
      emulatorEndpoint: { url: 'https://emu.lan:9297', loopback: false },
    };
    const remoteUrl = 'https://emu.lan:9297/cdkd-state/r1.json?X-Amz-Signature=old';
    await invokeCustomResourceFunctionLocally(clients, TOKEN, { ...request, ResponseURL: remoteUrl });
    expect(dr.startNamespacePortForwarder).not.toHaveBeenCalled();
    expect((rie.invokeRie.mock.calls[0]![2] as { ResponseURL: string }).ResponseURL).toBe(remoteUrl);
  });
});

describe('the answer', () => {
  it('maps a runtime error to FunctionError and carries the log tail as base64 LogResult', async () => {
    const raw = JSON.stringify({ errorType: 'Error', errorMessage: 'boom' });
    rie.invokeRie.mockImplementation(() => {
      logSinks?.stdout(Buffer.from('it failed here\n'));
      return Promise.resolve({ payload: JSON.parse(raw), raw });
    });
    const out = await invoke();
    expect(out?.FunctionError).toBe('Unhandled');
    expect(Buffer.from(out!.Payload!).toString()).toBe(raw);
    expect(Buffer.from(out!.LogResult!, 'base64').toString()).toBe('it failed here\n');
  });

  it('has no FunctionError for a handler that returned', async () => {
    const out = await invoke();
    expect(out?.FunctionError).toBeUndefined();
    expect(out?.StatusCode).toBe(200);
  });
});

describe('teardown', () => {
  it('removes the forwarder, the container and the plan tmpdirs when the invoke throws', async () => {
    rie.invokeRie.mockRejectedValue(new Error('RIE invoke timed out'));
    await expect(invoke()).rejects.toThrow('RIE invoke timed out');
    expect(dr.removeContainer).toHaveBeenCalledWith('fwd-1');
    expect(dr.removeContainer).toHaveBeenCalledWith('ctr-1');
    expect(existsSync(layersTmpDir)).toBe(false);
  });

  it('removes what an in-flight event started when the process exits', async () => {
    let release: () => void = () => undefined;
    rie.invokeRie.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ payload: null, raw: 'null' });
        })
    );
    const pending = invoke();
    await vi.waitFor(() => expect(rie.invokeRie).toHaveBeenCalled());
    process.emit('exit', 130);
    // By the names given up front: the container's, and its 443 sidecar's.
    const container = (dr.runDetached.mock.calls[0]![0] as { name: string }).name;
    expect(container).toMatch(/^cdkd-cr-[0-9a-f]{12}$/);
    expect(dr.startNamespacePortForwarder.mock.calls[0]![4]).toBe(`${container}-443`);
    expect(dr.removeContainersSync).toHaveBeenCalledWith([`${container}-443`, container]);
    expect(existsSync(layersTmpDir)).toBe(false);
    release();
    await pending;
  });

  it('removes a container that is still starting when the process exits', async () => {
    let started: (id: string) => void = () => undefined;
    dr.runDetached.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          started = resolve;
        })
    );
    const pending = invoke();
    await vi.waitFor(() => expect(dr.runDetached).toHaveBeenCalled());
    process.emit('exit', 130);
    const container = (dr.runDetached.mock.calls[0]![0] as { name: string }).name;
    expect(dr.removeContainersSync).toHaveBeenCalledWith([container]);
    started('ctr-1');
    await pending;
  });

  it('removes the container by its name when docker run created it but failed to start it', async () => {
    dr.runDetached.mockRejectedValue(new Error('docker run failed: cannot start container'));
    await expect(invoke()).rejects.toThrow('cannot start container');
    const container = (dr.runDetached.mock.calls[0]![0] as { name: string }).name;
    expect(dr.removeContainer).toHaveBeenCalledWith(container);
    expect(existsSync(layersTmpDir)).toBe(false);
  });

  it('drops its exit cleanup once the event finished', async () => {
    await invoke();
    process.emit('exit', 0);
    expect(dr.removeContainersSync).not.toHaveBeenCalled();
  });
});

describe('the cr.Provider second hop (go-to-k/cdkd#6213)', () => {
  const CREDS = { accessKeyId: 'EMULATORKEY', secretAccessKey: 'emusecret' };
  beforeEach(() => {
    wiring.value = {
      mode: 'emulator',
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', loopback: true },
      emulatorCredentials: CREDS,
    };
  });

  it('wires the container to the local Lambda / Step Functions endpoint, after the wiring', async () => {
    await invoke();
    const opts = dr.runDetached.mock.calls[0]![0] as {
      env: Record<string, string>;
      envAfterWiring?: Record<string, string>;
      extraLoopbackPorts?: number[];
      sensitiveEnvKeys: Set<string>;
    };
    const url = opts.envAfterWiring?.['AWS_ENDPOINT_URL_LAMBDA'];
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:(\d+)\/[0-9a-f]{64}$/);
    expect(opts.envAfterWiring?.['AWS_ENDPOINT_URL_SFN']).toBe(url);
    expect(opts.extraLoopbackPorts).toEqual([Number(/:(\d+)\//.exec(url!)![1])]);
    // The docker client reads AWS_ENDPOINT_URL_* itself: never in its environment.
    expect(opts.sensitiveEnvKeys.has('AWS_ENDPOINT_URL_LAMBDA')).toBe(false);
    expect(opts.env['AWS_ENDPOINT_URL_LAMBDA']).toBeUndefined();
  });

  it('does not wire it without the emulator credentials a forwarded call is signed with', async () => {
    wiring.value = {
      mode: 'emulator',
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', loopback: true },
    };
    await invoke();
    const opts = dr.runDetached.mock.calls[0]![0] as { envAfterWiring?: unknown };
    expect(opts.envAfterWiring).toBeUndefined();
  });

  const hopOf = (call = 0) =>
    (dr.runDetached.mock.calls[call]![0] as { envAfterWiring?: Record<string, string> })
      .envAfterWiring;

  it('does not wire it for an emulator on another host (review C1)', async () => {
    wiring.value = {
      mode: 'emulator',
      emulatorEndpoint: { url: 'https://emu.lan:9297', loopback: false },
      emulatorCredentials: CREDS,
    };
    await invoke();
    expect(hopOf()).toBeUndefined();
  });

  it('starts nothing outside full emulator mode, even with credentials (T12)', async () => {
    wiring.value = {
      mode: 'forward',
      emulatorEndpoint: { url: 'https://127.0.0.1:9297', loopback: true },
      emulatorCredentials: CREDS,
    };
    await expect(invoke()).resolves.toBeUndefined();
    expect(dr.runDetached).not.toHaveBeenCalled();
  });

  it("revokes the container's token once its event finished (T11)", async () => {
    await invoke();
    const url = hopOf()!['AWS_ENDPOINT_URL_LAMBDA']!;
    // A signed call on a live token is forwarded (502: no emulator here); a
    // revoked token is refused before that.
    const client = new LambdaClient({
      region: 'us-east-1',
      endpoint: url,
      credentials: CREDS,
      maxAttempts: 1,
    });
    await expect(client.send(new ListFunctionsCommand({}))).rejects.toMatchObject({
      $metadata: { httpStatusCode: 403 },
    });
  });

  it('runs the container without it, and stops offering it, when the forwarder cannot reach it (C4)', async () => {
    dr.runDetached.mockRejectedValueOnce(
      new CdkdError('forwarder: ETIMEDOUT', 'LOCAL_AWS_EMULATOR_FORWARDER_FAILED')
    );
    await invoke();
    expect(hopOf(0)).toBeDefined();
    expect(hopOf(1)).toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not reachable from containers'));
    await invoke();
    expect(hopOf(2)).toBeUndefined();
  });

  it('does not retry another docker failure (C4)', async () => {
    dr.runDetached.mockRejectedValueOnce(new Error('no such image'));
    await expect(invoke()).rejects.toThrow('no such image');
    expect(dr.runDetached).toHaveBeenCalledTimes(1);
  });
});

describe('lambdaClientForRegion (review C2)', () => {
  it("uses the event's client in its region, and one client per other region", async () => {
    const base = new LambdaClient({ region: 'eu-west-1' });
    const clientFor = lambdaClientForRegion(base);
    expect(await clientFor('arn:aws:lambda:eu-west-1:000000000000:function:f')).toBe(base);
    expect(await clientFor('just-a-name')).toBe(base);
    const other = await clientFor('arn:aws:lambda:us-east-1:000000000000:function:f');
    expect(other).not.toBe(base);
    expect(await other.config.region()).toBe('us-east-1');
    expect(await clientFor('arn:aws:lambda:us-east-1:000000000000:function:g')).toBe(other);
  });
});

describe('a destroy resolves the function in the stack it destroys', () => {
  function twin(name: string, env: Record<string, unknown>): StackInfo {
    const s = appStack(name);
    (s.template.Resources!['Fn']!.Properties as Record<string, unknown>)['Environment'] = {
      Variables: env,
    };
    return s;
  }

  it('picks the bound stack among stacks with the same logical ids and code', async () => {
    assembly.stacks = [twin('Other', { A: 'other' }), twin('Mine', { A: 'mine' })];
    plan.resolveZipImagePlan.mockClear();
    await withCustomResourceStack('Mine', () => invoke());
    const lambda = plan.resolveZipImagePlan.mock.calls[0]![0] as { stack: StackInfo };
    expect(lambda.stack.stackName).toBe('Mine');
  });
});
