import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// STS + ECR client mocks. The hoisted captures let each test set the
// canned response per-call.
const stsSendMock = vi.fn();
const stsConstructorMock = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation((config: unknown) => {
    stsConstructorMock(config);
    return {
      send: stsSendMock,
      destroy: vi.fn(),
    };
  }),
  GetCallerIdentityCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ _kind: 'GetCallerIdentity', input })),
  AssumeRoleCommand: vi
    .fn()
    .mockImplementation((input: unknown) => ({ _kind: 'AssumeRole', input })),
}));

const ecrSendMock = vi.fn();
const ecrConstructorMock = vi.fn();
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation((config: unknown) => {
    ecrConstructorMock(config);
    return {
      send: ecrSendMock,
      destroy: vi.fn(),
    };
  }),
  GetAuthorizationTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

// Mock the docker-cmd helpers. `vi.mock` is hoisted ABOVE top-level
// `const`s, so the stub functions go through `vi.hoisted(...)`.
const { runDockerMock, spawnForegroundMock } = vi.hoisted(() => ({
  runDockerMock: vi.fn(),
  spawnForegroundMock: vi.fn(),
}));
vi.mock('../../../src/utils/docker-cmd.js', async () => {
  const actual = await vi.importActual<typeof import('../../../src/utils/docker-cmd.js')>(
    '../../../src/utils/docker-cmd.js'
  );
  return {
    ...actual,
    runDockerStreaming: runDockerMock,
  };
});
// The `docker pull` foreground call still uses `spawn` directly (so it
// can inherit stdio). Stub that path via `node:child_process.spawn`.
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (...args: unknown[]) => {
      spawnForegroundMock(...args);
      const handlers: Record<string, ((arg?: unknown) => void)[]> = {};
      const proc = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stderr: { on: vi.fn() },
        stdout: { on: vi.fn() },
        on: (evt: string, cb: (arg?: unknown) => void) => {
          (handlers[evt] ??= []).push(cb);
          if (evt === 'close') {
            setImmediate(() => cb(0));
          }
        },
        once: (evt: string, cb: (arg?: unknown) => void) => {
          if (evt === 'close') setImmediate(() => cb(0));
        },
        kill: vi.fn(),
      };
      return proc as unknown;
    },
  };
});

import {
  __resetStsCachesForTesting,
  parseEcrUri,
  pullEcrImage,
} from '../../../src/local/ecr-puller.js';
import { LocalInvokeBuildError } from '../../../src/utils/error-handler.js';

describe('parseEcrUri', () => {
  it('parses a same-region ECR URI', () => {
    const parsed = parseEcrUri('123456789012.dkr.ecr.us-east-1.amazonaws.com/my-repo:abcdef1234');
    expect(parsed).toEqual({
      accountId: '123456789012',
      region: 'us-east-1',
      repository: 'my-repo',
      tag: 'abcdef1234',
    });
  });

  it('returns undefined for non-ECR URIs', () => {
    expect(parseEcrUri('public.ecr.aws/lambda/nodejs:20')).toBeUndefined();
    expect(parseEcrUri('docker.io/library/node:20')).toBeUndefined();
  });

  it('parses cn region (.amazonaws.com.cn)', () => {
    const parsed = parseEcrUri('123456789012.dkr.ecr.cn-north-1.amazonaws.com.cn/repo:tag');
    expect(parsed?.region).toBe('cn-north-1');
  });
});

describe('pullEcrImage', () => {
  beforeEach(() => {
    stsSendMock.mockReset();
    stsConstructorMock.mockReset();
    ecrSendMock.mockReset();
    ecrConstructorMock.mockReset();
    runDockerMock.mockReset();
    runDockerMock.mockResolvedValue({ stdout: '', stderr: '' });
    spawnForegroundMock.mockReset();
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    // Drain the module-level STS caches so cached credentials from one test
    // don't bleed into the next.
    __resetStsCachesForTesting();
  });

  it('rejects non-ECR image URIs with LocalInvokeBuildError', async () => {
    await expect(
      pullEcrImage('public.ecr.aws/lambda/nodejs:20', { skipPull: false })
    ).rejects.toBeInstanceOf(LocalInvokeBuildError);
  });

  it('same-account / same-region: fast path, no AssumeRole, docker login + pull issued', async () => {
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://111111111111.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    const result = await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
    });
    expect(result).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t');

    // STS was called once (GetCallerIdentity) — no AssumeRole.
    expect(stsSendMock).toHaveBeenCalledTimes(1);
    expect(stsSendMock.mock.calls[0]![0]._kind).toBe('GetCallerIdentity');

    // ECR client was built without explicit credentials (default chain).
    expect(ecrConstructorMock).toHaveBeenCalledTimes(1);
    const ecrConfig = ecrConstructorMock.mock.calls[0]![0] as { region?: string; credentials?: unknown };
    expect(ecrConfig.region).toBe('us-east-1');
    expect(ecrConfig.credentials).toBeUndefined();

    expect(ecrSendMock).toHaveBeenCalled();
    const loginCall = runDockerMock.mock.calls.find(
      ([args]) => Array.isArray(args) && args[0] === 'login'
    );
    expect(loginCall).toBeDefined();
    expect(spawnForegroundMock).toHaveBeenCalledTimes(1);
    const [, pullArgs] = spawnForegroundMock.mock.calls[0] as [string, string[]];
    expect(pullArgs[0]).toBe('pull');
  });

  it('cross-region: uses image region for ECR client, no longer hard-errors', async () => {
    // Pre-#455 cdkd hard-errored here. Post-#455 it proceeds and builds
    // the ECR client for the URI's region (not the caller's region).
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://111111111111.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-west-2';
    const result = await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
    });
    expect(result).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t');

    // The ECR client was built for the URI's region, NOT the caller's.
    const ecrConfig = ecrConstructorMock.mock.calls[0]![0] as { region?: string };
    expect(ecrConfig.region).toBe('us-east-1');
  });

  it('cross-account WITHOUT --ecr-role-arn: proceeds with caller creds + info log', async () => {
    // Pre-#455 cdkd hard-errored. Post-#455 cdkd proceeds with the
    // caller's credentials — works when the target ECR repository's
    // resource policy grants cross-account access directly. If AWS
    // rejects with AccessDenied the user is pointed at --ecr-role-arn.
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    const result = await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
    });
    expect(result).toBe('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t');

    // No AssumeRole was issued.
    const assumeRoleCalls = stsSendMock.mock.calls.filter((c) => c[0]._kind === 'AssumeRole');
    expect(assumeRoleCalls).toHaveLength(0);

    // ECR client built without explicit credentials (default chain).
    const ecrConfig = ecrConstructorMock.mock.calls[0]![0] as { credentials?: unknown };
    expect(ecrConfig.credentials).toBeUndefined();
  });

  it('cross-account WITH --ecr-role-arn: issues AssumeRole + threads creds into ECR client', async () => {
    // GetCallerIdentity returns caller account; AssumeRole returns
    // temp creds for the target account.
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAEXAMPLE',
          SecretAccessKey: 'examplesecret',
          SessionToken: 'examplesessiontoken',
          Expiration: new Date('2030-01-01T00:00:00Z'),
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    const result = await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: 'arn:aws:iam::999999999999:role/CrossAccountEcrPull',
    });
    expect(result).toBe('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t');

    // Two STS calls: GetCallerIdentity then AssumeRole.
    expect(stsSendMock).toHaveBeenCalledTimes(2);
    expect(stsSendMock.mock.calls[0]![0]._kind).toBe('GetCallerIdentity');
    expect(stsSendMock.mock.calls[1]![0]._kind).toBe('AssumeRole');
    const assumeRoleInput = stsSendMock.mock.calls[1]![0].input;
    expect(assumeRoleInput.RoleArn).toBe('arn:aws:iam::999999999999:role/CrossAccountEcrPull');
    expect(assumeRoleInput.RoleSessionName).toMatch(/^cdkd-local-ecr-/);

    // ECR client built with the temp creds.
    const ecrConfig = ecrConstructorMock.mock.calls[0]![0] as {
      credentials?: { accessKeyId?: string; sessionToken?: string };
      region?: string;
    };
    expect(ecrConfig.credentials).toBeDefined();
    expect(ecrConfig.credentials?.accessKeyId).toBe('ASIAEXAMPLE');
    expect(ecrConfig.credentials?.sessionToken).toBe('examplesessiontoken');
    expect(ecrConfig.region).toBe('us-east-1');
  });

  it('same-account WITH --ecr-role-arn: still issues AssumeRole (explicit opt-in)', async () => {
    // Per design: an explicit `--ecr-role-arn` always takes effect even
    // on same-account pulls — useful when the caller's identity does
    // not have ECR permissions but the role does.
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAEXAMPLE',
          SecretAccessKey: 'examplesecret',
          SessionToken: 'examplesessiontoken',
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://111111111111.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: 'arn:aws:iam::111111111111:role/EcrPull',
    });
    const assumeRoleCalls = stsSendMock.mock.calls.filter((c) => c[0]._kind === 'AssumeRole');
    expect(assumeRoleCalls).toHaveLength(1);
  });

  it('cross-region + cross-account + --ecr-role-arn: full STS hop + region-correct ECR client', async () => {
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAEXAMPLE',
          SecretAccessKey: 'examplesecret',
          SessionToken: 'examplesessiontoken',
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.eu-west-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    await pullEcrImage('999999999999.dkr.ecr.eu-west-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: 'arn:aws:iam::999999999999:role/CrossAccountEcrPull',
    });
    const ecrConfig = ecrConstructorMock.mock.calls[0]![0] as {
      region?: string;
      credentials?: { accessKeyId?: string };
    };
    expect(ecrConfig.region).toBe('eu-west-1');
    expect(ecrConfig.credentials?.accessKeyId).toBe('ASIAEXAMPLE');
  });

  it('--ecr-role-arn AssumeRole failure surfaces actionable LocalInvokeBuildError', async () => {
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockRejectedValueOnce(new Error('AccessDenied: not authorized to AssumeRole'));
    await expect(
      pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
        skipPull: false,
        ecrRoleArn: 'arn:aws:iam::999999999999:role/Bad',
      })
    ).rejects.toThrow(/Failed to assume role .* for ECR pull.*AccessDenied/);
  });

  it('--ecr-role-arn AssumeRole returns no Credentials: clear error', async () => {
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({ Credentials: undefined });
    await expect(
      pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
        skipPull: false,
        ecrRoleArn: 'arn:aws:iam::999999999999:role/Missing',
      })
    ).rejects.toThrow(/AssumeRole.*returned no usable credentials/);
  });

  it('GetCallerIdentity returns no Account: clear error', async () => {
    stsSendMock.mockResolvedValue({ Account: undefined });
    await expect(
      pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', { skipPull: false })
    ).rejects.toThrow(/STS GetCallerIdentity returned no Account/);
  });

  it('skipPull: verifies image is in local cache via docker image inspect — no STS calls', async () => {
    process.env['AWS_REGION'] = 'us-east-1';
    const result = await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: true,
    });
    expect(result).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t');
    const inspectCall = runDockerMock.mock.calls.find(
      ([args]) =>
        Array.isArray(args) && args[0] === 'image' && args[1] === 'inspect'
    );
    expect(inspectCall).toBeDefined();
    // No `docker pull` — skipped.
    expect(spawnForegroundMock).not.toHaveBeenCalled();
    // skipPull short-circuits BEFORE the GetCallerIdentity round-trip, so
    // an ECS run-task that pre-pulled all N images issues zero STS calls.
    expect(stsSendMock).not.toHaveBeenCalled();
  });

  it('skipPull + cross-account + --ecr-role-arn: zero STS calls (skipPull short-circuits before STS)', async () => {
    // skipPull only needs to verify the image is in the local cache —
    // no ECR auth required, so the entire STS block is skipped (both
    // GetCallerIdentity AND AssumeRole). This matters for ECS run-task
    // with `--no-pull` on a cross-account image — the user has already
    // pre-pulled and shouldn't pay any STS round-trips.
    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: true,
      ecrRoleArn: 'arn:aws:iam::999999999999:role/EcrPull',
    });
    expect(stsSendMock).not.toHaveBeenCalled();
    expect(ecrConstructorMock).not.toHaveBeenCalled();
  });

  it('explicit region option seeds the STS client (not the ECR client)', async () => {
    // The `region` option in EcrPullOptions is the CALLER's region (used
    // to seed STS), not the target ECR region (always from the URI).
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://111111111111.dkr.ecr.eu-west-1.amazonaws.com',
        },
      ],
    });
    await pullEcrImage('111111111111.dkr.ecr.eu-west-1.amazonaws.com/r:t', {
      skipPull: false,
      region: 'us-east-1',
    });
    // STS got the caller's region.
    expect(stsConstructorMock).toHaveBeenCalled();
    const stsConfig = stsConstructorMock.mock.calls[0]![0] as { region?: string };
    expect(stsConfig.region).toBe('us-east-1');
    // ECR got the URI's region.
    const ecrConfig = ecrConstructorMock.mock.calls[0]![0] as { region?: string };
    expect(ecrConfig.region).toBe('eu-west-1');
  });

  // ---------- STS credential caching (closes #485 reviewer's MAJOR finding) ----------

  it('caches GetCallerIdentity: two pulls in same region → only ONE GetCallerIdentity', async () => {
    // The ECS run-task pattern: N containers under the same default
    // credentials issuing N pulls. Pre-fix this generated N GetCallerIdentity
    // round-trips for an identity invariant for the process. Post-fix
    // it's 1.
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://111111111111.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';

    await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r1:t', { skipPull: false });
    await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r2:t', { skipPull: false });
    await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r3:t', { skipPull: false });

    const callerIdentityCalls = stsSendMock.mock.calls.filter(
      (c) => c[0]._kind === 'GetCallerIdentity'
    );
    expect(callerIdentityCalls).toHaveLength(1);
  });

  it('caches AssumeRole: three pulls under one --ecr-role-arn → only ONE AssumeRole', async () => {
    // The reviewer's literal canonical case: an ECS run-task with 3 ECR
    // images and --ecr-role-arn used to issue 3× AssumeRole. Now: 1×.
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAEXAMPLE',
          SecretAccessKey: 'examplesecret',
          SessionToken: 'examplesessiontoken',
          // Fresh — well into the future, well past the 5-minute margin.
          Expiration: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    const roleArn = 'arn:aws:iam::999999999999:role/CrossAccountEcrPull';

    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r1:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });
    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r2:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });
    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r3:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });

    const assumeRoleCalls = stsSendMock.mock.calls.filter((c) => c[0]._kind === 'AssumeRole');
    expect(assumeRoleCalls).toHaveLength(1);
    const callerIdentityCalls = stsSendMock.mock.calls.filter(
      (c) => c[0]._kind === 'GetCallerIdentity'
    );
    expect(callerIdentityCalls).toHaveLength(1);
  });

  it('re-issues AssumeRole when cached credential is past the 5-minute safety margin', async () => {
    // Stale-cache eviction: an Expiration within the 5-minute safety
    // margin counts as stale → re-issue.
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      // First AssumeRole returns creds expiring soon (within 5-minute margin).
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAFIRSTKEY',
          SecretAccessKey: 'firstsecret',
          SessionToken: 'firsttoken',
          Expiration: new Date(Date.now() + 2 * 60 * 1000), // 2 min → stale by 5-min margin
        },
      })
      // Second AssumeRole returns fresh creds.
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIASECONDKEY',
          SecretAccessKey: 'secondsecret',
          SessionToken: 'secondtoken',
          Expiration: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    const roleArn = 'arn:aws:iam::999999999999:role/EcrPull';

    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r1:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });
    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r2:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });

    const assumeRoleCalls = stsSendMock.mock.calls.filter((c) => c[0]._kind === 'AssumeRole');
    expect(assumeRoleCalls).toHaveLength(2);

    // Second ECR client should use the FRESH credentials, not the stale ones.
    const secondEcrConfig = ecrConstructorMock.mock.calls[1]![0] as {
      credentials?: { accessKeyId?: string };
    };
    expect(secondEcrConfig.credentials?.accessKeyId).toBe('ASIASECONDKEY');
  });

  it('cache is keyed on (roleArn, region): different ARNs → separate AssumeRole calls', async () => {
    // Two different roleArns in the same region must NOT share a cache
    // entry. Same shape applies to two different regions under the same
    // role (validated via the region key part of the cache key).
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIAFIRST',
          SecretAccessKey: 'firstsecret',
          SessionToken: 'firsttoken',
          Expiration: new Date(Date.now() + 60 * 60 * 1000),
        },
      })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIASECOND',
          SecretAccessKey: 'secondsecret',
          SessionToken: 'secondtoken',
          Expiration: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';

    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: 'arn:aws:iam::999999999999:role/RoleA',
    });
    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: 'arn:aws:iam::999999999999:role/RoleB',
    });

    const assumeRoleCalls = stsSendMock.mock.calls.filter((c) => c[0]._kind === 'AssumeRole');
    expect(assumeRoleCalls).toHaveLength(2);

    // Each call's RoleArn matches the input.
    expect(assumeRoleCalls[0]![0].input.RoleArn).toBe('arn:aws:iam::999999999999:role/RoleA');
    expect(assumeRoleCalls[1]![0].input.RoleArn).toBe('arn:aws:iam::999999999999:role/RoleB');
  });

  it('AssumeRole credentials without Expiration: treated as stale → re-issue every call', async () => {
    // Defensive: the AWS SDK declares Expiration as optional. If STS
    // ever returns creds without one (shouldn't happen in practice but
    // possible with mocked / proxy setups), we re-issue rather than
    // cache forever.
    stsSendMock
      .mockResolvedValueOnce({ Account: '111111111111' })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIANOEXP',
          SecretAccessKey: 'nosecret',
          SessionToken: 'notoken',
          // No Expiration!
        },
      })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: 'ASIANOEXP2',
          SecretAccessKey: 'nosecret2',
          SessionToken: 'notoken2',
        },
      });
    ecrSendMock.mockResolvedValue({
      authorizationData: [
        {
          authorizationToken: Buffer.from('AWS:dummypw').toString('base64'),
          proxyEndpoint: 'https://999999999999.dkr.ecr.us-east-1.amazonaws.com',
        },
      ],
    });
    process.env['AWS_REGION'] = 'us-east-1';
    const roleArn = 'arn:aws:iam::999999999999:role/EcrPull';

    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });
    await pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: false,
      ecrRoleArn: roleArn,
    });

    const assumeRoleCalls = stsSendMock.mock.calls.filter((c) => c[0]._kind === 'AssumeRole');
    expect(assumeRoleCalls).toHaveLength(2);
  });
});
