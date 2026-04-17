import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

// Mock node:child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

// Mock node:fs
vi.mock('node:fs', () => ({
  writeFileSync: vi.fn(),
  mkdtempSync: vi.fn(),
  rmSync: vi.fn(),
}));

// Note: node:os is NOT mocked - tmpdir() uses real OS temp directory

// Mock logger
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  }),
}));

import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { AppExecutor } from '../../../src/synthesis/app-executor.js';
import { SynthesisError } from '../../../src/utils/error-handler.js';

/**
 * Helper to create a mock ChildProcess that emits events
 */
function createMockProcess(): ChildProcess & {
  _stdout: EventEmitter;
  _stderr: EventEmitter;
} {
  const proc = new EventEmitter() as ChildProcess & {
    _stdout: EventEmitter;
    _stderr: EventEmitter;
  };
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  (proc as unknown as Record<string, unknown>).stdout = proc._stdout;
  (proc as unknown as Record<string, unknown>).stderr = proc._stderr;
  return proc;
}

describe('AppExecutor', () => {
  let executor: AppExecutor;

  beforeEach(() => {
    vi.resetAllMocks();
    executor = new AppExecutor();
  });

  describe('execute', () => {
    it('should execute CDK app command via subprocess', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'npx ts-node bin/app.ts',
        outputDir: '/tmp/cdk.out',
        context: { foo: 'bar' },
      });

      // Simulate successful exit
      mockProc.emit('close', 0);

      await promise;

      expect(spawn).toHaveBeenCalledWith(
        'npx ts-node bin/app.ts',
        expect.objectContaining({
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        })
      );
    });

    it('should pass proper environment variables', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'npx ts-node bin/app.ts',
        outputDir: '/tmp/cdk.out',
        context: { key: 'value' },
        region: 'us-east-1',
        accountId: '123456789012',
      });

      mockProc.emit('close', 0);
      await promise;

      const callEnv = vi.mocked(spawn).mock.calls[0][1] as { env: Record<string, string> };
      const env = callEnv.env;

      expect(env['CDK_OUTDIR']).toBe('/tmp/cdk.out');
      expect(env['CDK_DEFAULT_REGION']).toBe('us-east-1');
      expect(env['CDK_DEFAULT_ACCOUNT']).toBe('123456789012');
      expect(env['CDK_CLI_ASM_VERSION']).toBe('38.0.0');
      expect(env['CDK_CONTEXT_JSON']).toBe(JSON.stringify({ key: 'value' }));
    });

    it('should handle large context by writing to temp file', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);
      const fakeTempDir = '/fake/cdkd-context-abc123';
      vi.mocked(mkdtempSync).mockReturnValue(fakeTempDir);

      // Create a context larger than 32KB
      const largeContext: Record<string, string> = {};
      for (let i = 0; i < 2000; i++) {
        largeContext[`key-${i}`] = 'x'.repeat(20);
      }

      const promise = executor.execute({
        app: 'npx ts-node bin/app.ts',
        outputDir: '/tmp/cdk.out',
        context: largeContext,
      });

      mockProc.emit('close', 0);
      await promise;

      // Should have written context to temp file
      expect(mkdtempSync).toHaveBeenCalled();
      expect(writeFileSync).toHaveBeenCalledWith(
        `${fakeTempDir}/context.json`,
        JSON.stringify(largeContext),
        'utf-8'
      );

      // Should set CONTEXT_OVERFLOW_LOCATION_ENV instead of CDK_CONTEXT_JSON
      const callEnv = vi.mocked(spawn).mock.calls[0][1] as { env: Record<string, string> };
      const env = callEnv.env;
      expect(env['CONTEXT_OVERFLOW_LOCATION_ENV']).toBe(`${fakeTempDir}/context.json`);
      expect(env['CDK_CONTEXT_JSON']).toBeUndefined();

      // Should clean up temp dir
      expect(rmSync).toHaveBeenCalledWith(fakeTempDir, {
        recursive: true,
        force: true,
      });
    });

    it('should prepend node for .js files', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'bin/app.js',
        outputDir: '/tmp/cdk.out',
        context: {},
      });

      mockProc.emit('close', 0);
      await promise;

      const commandLine = vi.mocked(spawn).mock.calls[0][0] as string;
      expect(commandLine).toContain(process.execPath);
      expect(commandLine).toContain('bin/app.js');
    });

    it('should throw SynthesisError on non-zero exit code', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'npx ts-node bin/app.ts',
        outputDir: '/tmp/cdk.out',
        context: {},
      });

      mockProc.emit('close', 1);

      await expect(promise).rejects.toThrow(SynthesisError);
      await expect(promise).rejects.toThrow(/exited with code 1/);
    });

    it('should include stderr in error message on failure', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'npx ts-node bin/app.ts',
        outputDir: '/tmp/cdk.out',
        context: {},
      });

      // Emit stderr data before exit
      mockProc._stderr.emit('data', Buffer.from('Error: something went wrong'));
      mockProc.emit('close', 1);

      await expect(promise).rejects.toThrow(/something went wrong/);
    });

    it('should throw SynthesisError on spawn error', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'nonexistent-command',
        outputDir: '/tmp/cdk.out',
        context: {},
      });

      mockProc.emit('error', new Error('spawn ENOENT'));

      await expect(promise).rejects.toThrow(SynthesisError);
      await expect(promise).rejects.toThrow(/Failed to execute CDK app/);
    });

    it('should not set CDK_DEFAULT_REGION when region is not provided', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc);

      const promise = executor.execute({
        app: 'npx ts-node bin/app.ts',
        outputDir: '/tmp/cdk.out',
        context: {},
      });

      mockProc.emit('close', 0);
      await promise;

      const callEnv = vi.mocked(spawn).mock.calls[0][1] as { env: Record<string, string> };
      const env = callEnv.env;
      expect(env['CDK_DEFAULT_REGION']).toBeUndefined();
      expect(env['CDK_DEFAULT_ACCOUNT']).toBeUndefined();
    });
  });
});
