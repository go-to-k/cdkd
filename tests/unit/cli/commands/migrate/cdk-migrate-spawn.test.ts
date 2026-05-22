import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { EventEmitter } from 'node:events';

// Mock node:child_process.spawn.
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock logger so noise doesn't pollute test output.
vi.mock('../../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

import { spawnCdkMigrate } from '../../../../../src/cli/commands/migrate/cdk-migrate-spawn.js';
import { LocalMigrateError } from '../../../../../src/utils/error-handler.js';

/**
 * Build a fake spawn child that callers can drive via `emit`. Mirrors
 * Node's child_process API enough to exercise `cdk-migrate-spawn.ts`.
 */
function buildFakeChild(): {
  child: EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return { child };
}

describe('spawnCdkMigrate', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('builds the correct argv for a minimal call (stack name + output path)', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);

    // Drive the child to success after a tick.
    queueMicrotask(() => {
      child.stdout.emit('data', Buffer.from('migrate complete\n'));
      child.emit('close', 0, null);
    });

    const result = await spawnCdkMigrate({
      stackName: 'MyStack',
      fromStackName: 'MyStack',
      outputPath: '/tmp/out',
    });

    expect(mockSpawn).toHaveBeenCalled();
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe('cdk');
    expect(args).toEqual([
      'migrate',
      '--from-stack',
      '--stack-name',
      'MyStack',
      '--output-path',
      '/tmp/out',
      '--language',
      'typescript',
    ]);
    expect(result.outputDir.endsWith('/tmp/out/MyStack')).toBe(true);
    expect(result.stdout).toMatch(/migrate complete/);
  });

  it('forwards --region / --account / --profile / --filter args', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));

    await spawnCdkMigrate({
      stackName: 'S',
      fromStackName: 'S',
      outputPath: '/tmp/out',
      region: 'us-west-2',
      account: '123456789012',
      profile: 'dev',
      filters: ['type=AWS::S3::Bucket', 'identifier=MyBucket'],
    });

    const [, args] = mockSpawn.mock.calls[0]!;
    expect(args).toContain('--region');
    expect(args).toContain('us-west-2');
    expect(args).toContain('--account');
    expect(args).toContain('123456789012');
    expect(args).toContain('--profile');
    expect(args).toContain('dev');
    // Filters should appear twice (one per entry).
    expect(args.filter((a: string) => a === '--filter')).toHaveLength(2);
    expect(args).toContain('type=AWS::S3::Bucket');
  });

  it('throws LocalMigrateError on non-zero exit', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);

    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('AccessDenied: ...\n'));
      child.emit('close', 1, null);
    });

    await expect(
      spawnCdkMigrate({ stackName: 'S', fromStackName: 'S', outputPath: '/tmp/out' })
    ).rejects.toBeInstanceOf(LocalMigrateError);
  });

  it('folds stdout+stderr into the error message on non-zero exit', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('AccessDenied marker\n'));
      child.emit('close', 1, null);
    });
    await expect(
      spawnCdkMigrate({ stackName: 'S', fromStackName: 'S', outputPath: '/tmp/out' })
    ).rejects.toThrow(/exited with code 1[\s\S]*AccessDenied marker/);
  });

  it('surfaces the signal name when a signal terminated the subprocess', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => {
      child.emit('close', null, 'SIGKILL');
    });
    await expect(
      spawnCdkMigrate({ stackName: 'S', fromStackName: 'S', outputPath: '/tmp/out' })
    ).rejects.toThrow(/killed by signal SIGKILL/);
  });

  it('surfaces the generic message when close fires with code and signal both null', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => {
      child.emit('close', null, null);
    });
    await expect(
      spawnCdkMigrate({ stackName: 'S', fromStackName: 'S', outputPath: '/tmp/out' })
    ).rejects.toThrow(/process closed without a code or signal/);
  });

  it('merges extraEnv with process.env (extraEnv takes precedence)', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));

    process.env.CDKD_TEST_KEY = 'from-process';
    await spawnCdkMigrate({
      stackName: 'S',
      fromStackName: 'S',
      outputPath: '/tmp/out',
      extraEnv: { CDKD_TEST_KEY: 'from-extra', AWS_ACCESS_KEY_ID: 'TEST' },
    });

    const opts = mockSpawn.mock.calls[0]![2] as { env: NodeJS.ProcessEnv };
    expect(opts.env['CDKD_TEST_KEY']).toBe('from-extra');
    expect(opts.env['AWS_ACCESS_KEY_ID']).toBe('TEST');
    delete process.env.CDKD_TEST_KEY;
  });

  it('honors cdkBinPath override', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));

    await spawnCdkMigrate({
      stackName: 'S',
      fromStackName: 'S',
      outputPath: '/tmp/out',
      cdkBinPath: '/usr/local/bin/cdk',
    });
    expect(mockSpawn.mock.calls[0]![0]).toBe('/usr/local/bin/cdk');
  });

  it('wraps a synchronous spawn failure as LocalMigrateError', async () => {
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn ENOENT');
    });
    await expect(
      spawnCdkMigrate({ stackName: 'S', fromStackName: 'S', outputPath: '/tmp/out' })
    ).rejects.toBeInstanceOf(LocalMigrateError);
  });

  it('wraps an async spawn error event as LocalMigrateError', async () => {
    const { child } = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('error', new Error('boom')));
    await expect(
      spawnCdkMigrate({ stackName: 'S', fromStackName: 'S', outputPath: '/tmp/out' })
    ).rejects.toBeInstanceOf(LocalMigrateError);
  });
});
