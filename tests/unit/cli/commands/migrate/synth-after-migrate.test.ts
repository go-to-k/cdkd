import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mock node:child_process.spawn.
const mockSpawn = vi.fn();
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock logger.
vi.mock('../../../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    setLevel: vi.fn(),
  }),
}));

import {
  installGeneratedAppDeps,
  synthGeneratedApp,
} from '../../../../../src/cli/commands/migrate/synth-after-migrate.js';
import { LocalMigrateError } from '../../../../../src/utils/error-handler.js';

function buildFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe('installGeneratedAppDeps', () => {
  let tmp: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-migrate-test-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('skips npm install when skipInstall is true', async () => {
    await installGeneratedAppDeps(tmp, { skipInstall: true });
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('runs npm install in the given directory', async () => {
    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));
    await installGeneratedAppDeps(tmp, {});
    expect(mockSpawn).toHaveBeenCalled();
    const [bin, args, opts] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe('npm');
    expect(args).toEqual(['install']);
    expect((opts as { cwd: string }).cwd).toBe(tmp);
  });

  it('throws LocalMigrateError when the target dir does not exist', async () => {
    await expect(
      installGeneratedAppDeps(join(tmp, 'nonexistent'), {})
    ).rejects.toBeInstanceOf(LocalMigrateError);
  });

  it('throws LocalMigrateError on non-zero npm exit', async () => {
    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('npm ERR\n'));
      child.emit('close', 1, null);
    });
    await expect(installGeneratedAppDeps(tmp, {})).rejects.toBeInstanceOf(LocalMigrateError);
  });
});

describe('synthGeneratedApp', () => {
  let tmp: string;

  beforeEach(() => {
    mockSpawn.mockReset();
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-migrate-synth-test-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null templateBody when skipSynth is true', async () => {
    const result = await synthGeneratedApp(tmp, { skipSynth: true });
    expect(result.templateBody).toBeNull();
    expect(result.assemblyDir.endsWith('/cdk.out')).toBe(true);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('throws LocalMigrateError when the target dir does not exist', async () => {
    await expect(
      synthGeneratedApp(join(tmp, 'nonexistent'), {})
    ).rejects.toBeInstanceOf(LocalMigrateError);
  });

  it('runs cdk synth and returns the parsed root template', async () => {
    // Pre-populate cdk.out + a template that "synth" would have produced.
    const assemblyDir = join(tmp, 'cdk.out');
    mkdirSync(assemblyDir);
    writeFileSync(
      join(assemblyDir, 'SmokeMigrated.template.json'),
      JSON.stringify({
        Resources: {
          MyBucket: { Type: 'AWS::S3::Bucket' },
        },
      })
    );

    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));

    const result = await synthGeneratedApp(tmp, {});
    expect(mockSpawn).toHaveBeenCalled();
    const [bin, args] = mockSpawn.mock.calls[0]!;
    expect(bin).toBe('cdk');
    expect(args).toEqual(['synth', '--quiet']);
    expect(result.assemblyDir).toBe(assemblyDir);
    expect(result.templateBody).toEqual({
      Resources: { MyBucket: { Type: 'AWS::S3::Bucket' } },
    });
  });

  it('honors cdkBinPath override', async () => {
    const assemblyDir = join(tmp, 'cdk.out');
    mkdirSync(assemblyDir);
    writeFileSync(
      join(assemblyDir, 'S.template.json'),
      JSON.stringify({ Resources: {} })
    );

    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));

    await synthGeneratedApp(tmp, { cdkBinPath: '/usr/local/bin/cdk' });
    expect(mockSpawn.mock.calls[0]![0]).toBe('/usr/local/bin/cdk');
  });

  it('throws LocalMigrateError on non-zero cdk synth exit', async () => {
    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => {
      child.stderr.emit('data', Buffer.from('synth failed\n'));
      child.emit('close', 2, null);
    });
    await expect(synthGeneratedApp(tmp, {})).rejects.toBeInstanceOf(LocalMigrateError);
  });

  it('throws LocalMigrateError when cdk synth runs but cdk.out is missing', async () => {
    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));
    await expect(synthGeneratedApp(tmp, {})).rejects.toBeInstanceOf(LocalMigrateError);
  });

  it('returns null templateBody when cdk.out has no .template.json files', async () => {
    mkdirSync(join(tmp, 'cdk.out'));
    writeFileSync(join(tmp, 'cdk.out', 'manifest.json'), '{}');
    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));
    const result = await synthGeneratedApp(tmp, {});
    expect(result.templateBody).toBeNull();
  });

  it('surfaces JSON parse errors on a corrupt template', async () => {
    mkdirSync(join(tmp, 'cdk.out'));
    writeFileSync(
      join(tmp, 'cdk.out', 'S.template.json'),
      '{this is not valid json}'
    );
    const child = buildFakeChild();
    mockSpawn.mockReturnValue(child);
    queueMicrotask(() => child.emit('close', 0, null));
    await expect(synthGeneratedApp(tmp, {})).rejects.toBeInstanceOf(LocalMigrateError);
  });
});
