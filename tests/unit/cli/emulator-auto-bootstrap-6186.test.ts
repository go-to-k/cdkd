import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
} from '@aws-sdk/client-s3';
import { GetCallerIdentityCommand } from '@aws-sdk/client-sts';

vi.mock('../../../src/cli/commands/confirm-prompt.js', () => ({
  promptYesNo: vi.fn(async () => false),
}));
vi.mock('../../../src/state/state-bucket-lifecycle.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/state/state-bucket-lifecycle.js')>()),
  applyCustomResourceResponseExpiration: vi.fn(async () => ({ status: 'added' as const })),
}));

import { ensureAwsEmulatorStateBucket } from '../../../src/cli/commands/emulator-auto-bootstrap.js';
import { confirmAutoAssetStorageCreate } from '../../../src/cli/commands/deploy/helpers.js';
import { promptYesNo } from '../../../src/cli/commands/confirm-prompt.js';
import {
  resetAwsClientDefaults,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';
import { getLogger } from '../../../src/utils/logger.js';

/**
 * go-to-k/cdkd#6186: under `--aws-emulator` only, a state-writing command
 * creates the missing state bucket itself, and the per-region asset-storage
 * auto-create never prompts. Real AWS is unchanged on both paths.
 */

const EMULATOR = { endpoint: 'https://127.0.0.1:4566' };

function activateEmulator(): void {
  setAwsEndpointOverrideSource(() => EMULATOR as never);
}

function fakeClients(headError: { name: string } | undefined) {
  const s3Calls: unknown[] = [];
  const s3 = {
    config: { region: async () => 'us-east-1' },
    send: vi.fn(async (cmd: unknown) => {
      s3Calls.push(cmd);
      if (cmd instanceof HeadBucketCommand && headError) throw headError;
      return {};
    }),
  };
  const sts = {
    send: vi.fn(async (cmd: unknown) => {
      if (cmd instanceof GetCallerIdentityCommand) return { Account: '000000000000' };
      throw new Error('unexpected STS call');
    }),
  };
  return { s3: s3 as never, sts: sts as never, s3Calls, s3Send: s3.send, stsSend: sts.send };
}

const notFound = { name: 'NotFound' };

describe('ensureAwsEmulatorStateBucket', () => {
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    delete process.env['CDKD_STATE_BUCKET'];
  });
  afterEach(() => {
    vi.restoreAllMocks();
    setAwsEndpointOverrideSource(undefined);
    resetAwsClientDefaults();
  });

  it('real AWS: makes no AWS call at all, even when the bucket is missing', async () => {
    const c = fakeClients(notFound);
    const created = await ensureAwsEmulatorStateBucket({
      cliBucket: undefined,
      region: 'us-east-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(created).toBeUndefined();
    expect(c.s3Send).not.toHaveBeenCalled();
    expect(c.stsSend).not.toHaveBeenCalled();
  });

  it('real AWS with a source registered but no emulator active: unchanged', async () => {
    setAwsEndpointOverrideSource(() => undefined);
    const c = fakeClients(notFound);
    await ensureAwsEmulatorStateBucket({
      cliBucket: undefined,
      region: 'us-east-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(c.s3Send).not.toHaveBeenCalled();
  });

  it('emulator without a state bucket: creates and configures the default one, one info line', async () => {
    activateEmulator();
    const c = fakeClients(notFound);
    const created = await ensureAwsEmulatorStateBucket({
      cliBucket: undefined,
      region: 'ap-northeast-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(created).toBe('cdkd-state-000000000000');
    const kinds = c.s3Calls.map((cmd) => (cmd as object).constructor.name);
    expect(kinds).toEqual([
      HeadBucketCommand.name,
      CreateBucketCommand.name,
      PutBucketVersioningCommand.name,
      PutBucketEncryptionCommand.name,
      PutBucketPolicyCommand.name,
    ]);
    const create = c.s3Calls[1] as CreateBucketCommand;
    expect(create.input).toEqual({
      Bucket: 'cdkd-state-000000000000',
      CreateBucketConfiguration: { LocationConstraint: 'ap-northeast-1' },
    });
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0]![0])).toContain(
      'AWS Emulator had no cdkd bootstrap; bootstrapped it (state bucket cdkd-state-000000000000).'
    );
  });

  it('emulator: a named --state-bucket is the one created', async () => {
    activateEmulator();
    const c = fakeClients({ name: 'NoSuchBucket' });
    const created = await ensureAwsEmulatorStateBucket({
      cliBucket: 'my-state',
      region: 'us-east-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(created).toBe('my-state');
    expect((c.s3Calls[1] as CreateBucketCommand).input).toEqual({ Bucket: 'my-state' });
  });

  it('emulator with the bucket already there: HeadBucket only', async () => {
    activateEmulator();
    const c = fakeClients(undefined);
    const created = await ensureAwsEmulatorStateBucket({
      cliBucket: undefined,
      region: 'us-east-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(created).toBeUndefined();
    expect(c.s3Send).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('emulator: a lost CreateBucket race (BucketAlreadyOwnedByYou) still configures the bucket', async () => {
    activateEmulator();
    const c = fakeClients(notFound);
    c.s3Send.mockImplementation(async (cmd: unknown) => {
      c.s3Calls.push(cmd);
      if (cmd instanceof HeadBucketCommand) throw notFound;
      if (cmd instanceof CreateBucketCommand) throw { name: 'BucketAlreadyOwnedByYou' };
      return {};
    });
    const created = await ensureAwsEmulatorStateBucket({
      cliBucket: undefined,
      region: 'us-east-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(created).toBe('cdkd-state-000000000000');
    expect(c.s3Calls.some((cmd) => cmd instanceof PutBucketVersioningCommand)).toBe(true);
  });

  it('emulator: a failed create names the bucket and the retry command', async () => {
    activateEmulator();
    const c = fakeClients(notFound);
    c.s3Send.mockImplementation(async (cmd: unknown) => {
      if (cmd instanceof HeadBucketCommand) throw notFound;
      if (cmd instanceof CreateBucketCommand) throw new Error('boom');
      return {};
    });
    await expect(
      ensureAwsEmulatorStateBucket({ cliBucket: undefined, region: 'us-east-1', s3: c.s3, sts: c.sts })
    ).rejects.toThrow(
      /AWS Emulator auto-bootstrap of state bucket cdkd-state-000000000000 failed: boom.*cdkd bootstrap --aws-emulator --force/
    );
  });

  it('emulator: an error other than not-found is left to the preflight (no create)', async () => {
    activateEmulator();
    const c = fakeClients({ name: 'AccessDenied' });
    const created = await ensureAwsEmulatorStateBucket({
      cliBucket: undefined,
      region: 'us-east-1',
      s3: c.s3,
      sts: c.sts,
    });
    expect(created).toBeUndefined();
    expect(c.s3Send).toHaveBeenCalledTimes(1);
  });
});

describe('confirmAutoAssetStorageCreate', () => {
  const isTTY = process.stdin.isTTY;
  let info: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    info = vi.spyOn(getLogger(), 'info').mockImplementation(() => {});
    vi.mocked(promptYesNo).mockClear();
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  });
  afterEach(() => {
    Object.defineProperty(process.stdin, 'isTTY', { value: isTTY, configurable: true });
    vi.restoreAllMocks();
    setAwsEndpointOverrideSource(undefined);
    resetAwsClientDefaults();
  });

  it('real AWS, interactive: prompts (and honours the answer)', async () => {
    const ok = await confirmAutoAssetStorageCreate({
      assetRegion: 'eu-west-1',
      accountId: '123456789012',
      yes: false,
    });
    expect(promptYesNo).toHaveBeenCalledTimes(1);
    expect(ok).toBe(false);
  });

  it('real AWS, --yes: creates with an info line, no prompt', async () => {
    const ok = await confirmAutoAssetStorageCreate({
      assetRegion: 'eu-west-1',
      accountId: '123456789012',
      yes: true,
    });
    expect(ok).toBe(true);
    expect(promptYesNo).not.toHaveBeenCalled();
    expect(String(info.mock.calls[0]![0])).toContain('first deploy into this region');
  });

  it('emulator, interactive and no --yes: accepts without prompting', async () => {
    activateEmulator();
    const ok = await confirmAutoAssetStorageCreate({
      assetRegion: 'eu-west-1',
      accountId: '000000000000',
      yes: false,
    });
    expect(ok).toBe(true);
    expect(promptYesNo).not.toHaveBeenCalled();
    expect(String(info.mock.calls[0]![0])).toContain(
      "Creating cdkd asset storage for region 'eu-west-1' in AWS Emulator"
    );
  });
});
