import { beforeEach, describe, expect, it, vi } from 'vitest';

// STS + ECR client mocks. The hoisted captures let each test set the
// canned response per-call.
const stsSendMock = vi.fn();
vi.mock('@aws-sdk/client-sts', () => ({
  STSClient: vi.fn().mockImplementation(() => ({
    send: stsSendMock,
    destroy: vi.fn(),
  })),
  GetCallerIdentityCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const ecrSendMock = vi.fn();
vi.mock('@aws-sdk/client-ecr', () => ({
  ECRClient: vi.fn().mockImplementation(() => ({
    send: ecrSendMock,
    destroy: vi.fn(),
  })),
  GetAuthorizationTokenCommand: vi.fn().mockImplementation((input: unknown) => ({ input })),
}));

const childProcessMock = {
  execFile: vi.fn(),
  spawn: vi.fn(),
};
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    // promisify(execFile)(cmd, args) → calls execFile(cmd, args, cb).
    // execFileAsync(cmd, args, opts) → calls execFile(cmd, args, opts, cb).
    // Both shapes thread through the same code path here.
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (err: unknown, stdout?: { stdout: string }) => void;
      const cmd = allArgs[0] as string;
      const args = allArgs[1] as string[];
      const opts = allArgs.length === 4 ? allArgs[2] : undefined;
      childProcessMock.execFile(cmd, args, opts);
      // promisify expects `(err, value)` — for resolved-with-stdout shape
      // pass an `{stdout, stderr}` object so callers reading `.stdout`
      // get a string (not undefined).
      cb(null, { stdout: '' } as { stdout: string });
    },
    spawn: () => {
      childProcessMock.spawn();
      // Return a minimal spawn-result that resolves successfully:
      // emit close(0) on the next tick.
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
        kill: vi.fn(),
      };
      return proc as unknown;
    },
  };
});

import { parseEcrUri, pullEcrImage } from '../../../src/local/ecr-puller.js';
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
    ecrSendMock.mockReset();
    childProcessMock.execFile.mockReset();
    childProcessMock.spawn.mockReset();
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
  });

  it('rejects non-ECR image URIs with LocalInvokeBuildError', async () => {
    await expect(
      pullEcrImage('public.ecr.aws/lambda/nodejs:20', { skipPull: false })
    ).rejects.toBeInstanceOf(LocalInvokeBuildError);
  });

  it('rejects cross-account URIs with a clear deferred-PR message', async () => {
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    await expect(
      pullEcrImage('999999999999.dkr.ecr.us-east-1.amazonaws.com/r:t', {
        skipPull: false,
      })
    ).rejects.toThrow(/Cross-account ECR pull/);
  });

  it('rejects cross-region URIs when caller region is set', async () => {
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    process.env['AWS_REGION'] = 'us-west-2';
    await expect(
      pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
        skipPull: false,
      })
    ).rejects.toThrow(/Cross-region ECR pull/);
  });

  it('rejects cross-region URIs when --region option is set (env unset)', async () => {
    // Closes the gap where `--region us-west-2` was silently ignored
    // because the caller-region check only consulted env vars.
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    delete process.env['AWS_REGION'];
    delete process.env['AWS_DEFAULT_REGION'];
    await expect(
      pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
        skipPull: false,
        region: 'us-west-2',
      })
    ).rejects.toThrow(/Cross-region ECR pull/);
  });

  it('explicit region option wins over AWS_REGION env var', async () => {
    // AWS_REGION says same-region (us-east-1) but the caller passed
    // --region us-west-2 → the option wins and we surface cross-region.
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    process.env['AWS_REGION'] = 'us-east-1';
    await expect(
      pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
        skipPull: false,
        region: 'us-west-2',
      })
    ).rejects.toThrow(/Cross-region ECR pull/);
  });

  it('happy path: same-acct/region issues docker login + pull', async () => {
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
    expect(stsSendMock).toHaveBeenCalled();
    expect(ecrSendMock).toHaveBeenCalled();
    // spawn fires twice: once for `docker login` (ecrLogin), once for `docker pull`.
    expect(childProcessMock.spawn).toHaveBeenCalledTimes(2);
  });

  it('skipPull: verifies image is in local cache via docker image inspect', async () => {
    stsSendMock.mockResolvedValue({ Account: '111111111111' });
    process.env['AWS_REGION'] = 'us-east-1';
    const result = await pullEcrImage('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t', {
      skipPull: true,
    });
    expect(result).toBe('111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t');
    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      'docker',
      ['image', 'inspect', '111111111111.dkr.ecr.us-east-1.amazonaws.com/r:t'],
      undefined
    );
    // No spawn — login + pull are skipped.
    expect(childProcessMock.spawn).not.toHaveBeenCalled();
  });
});
