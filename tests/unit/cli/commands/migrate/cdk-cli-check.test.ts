import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';

// Mock node:child_process — verifyCdkCliAvailable uses
// promisify(execFile)(bin, ['--version']). Mock execFile in the
// 3-argument (cmd, args, cb) shape and call the callback with the
// stubbed stdout / err per-test.
const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
}));
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFile: (...allArgs: unknown[]) => {
      const cb = allArgs[allArgs.length - 1] as (
        err: NodeJS.ErrnoException | null,
        stdout?: string | { stdout: string }
      ) => void;
      const cmd = allArgs[0] as string;
      const args = allArgs[1] as string[];
      // Record the call BEFORE invoking the callback so the test can
      // assert on argv even on the error path.
      mocks.execFile(cmd, args);
      // Use a microtask so the call shape matches Node's async behavior.
      const result = mocks.execFile.mock.results[mocks.execFile.mock.results.length - 1];
      // The driver below sets the "next response" via a side channel.
      Promise.resolve().then(() => {
        const next = (mocks as { _nextResponse?: NextResponse })._nextResponse;
        if (next?.error) {
          cb(next.error);
        } else {
          // promisify(execFile) resolves with { stdout, stderr }; our
          // helper accepts an object with `.stdout` or a raw string.
          cb(null, { stdout: next?.stdout ?? '' });
        }
      });
    },
  };
});

type NextResponse = { stdout?: string; error?: NodeJS.ErrnoException };

function stubExec(next: NextResponse): void {
  (mocks as { _nextResponse?: NextResponse })._nextResponse = next;
}

import {
  parseCdkVersion,
  verifyCdkCliAvailable,
} from '../../../../../src/cli/commands/migrate/cdk-cli-check.js';
import { MissingCdkCliError } from '../../../../../src/utils/error-handler.js';

describe('parseCdkVersion', () => {
  it('extracts a bare semver from cdk --version output', () => {
    expect(parseCdkVersion('2.1112.0\n')).toBe('2.1112.0');
  });

  it('extracts a semver from output with a trailing build suffix', () => {
    expect(parseCdkVersion('2.1112.0 (build abc123)\n')).toBe('2.1112.0');
  });

  it('returns undefined when no semver is present', () => {
    expect(parseCdkVersion('foobar')).toBeUndefined();
  });

  it('extracts a semver from the leading line of multi-line output', () => {
    expect(parseCdkVersion('2.150.5\n(some other text)\n')).toBe('2.150.5');
  });
});

describe('verifyCdkCliAvailable', () => {
  beforeEach(() => {
    mocks.execFile.mockReset();
    (mocks as { _nextResponse?: NextResponse })._nextResponse = undefined;
  });

  it('returns the version on a fresh modern cdk CLI without warn', async () => {
    stubExec({ stdout: '2.1112.0 (build deadbeef)\n' });
    const result = await verifyCdkCliAvailable('cdk');
    expect(result.version).toBe('2.1112.0');
    expect(result.warn).toBeUndefined();
  });

  it('returns a warn message when the cdk CLI is below the recommended minimum', async () => {
    stubExec({ stdout: '2.100.0\n' });
    const result = await verifyCdkCliAvailable('cdk');
    expect(result.version).toBe('2.100.0');
    expect(result.warn).toBeDefined();
    expect(result.warn).toMatch(/older than the recommended minimum/);
  });

  it('throws MissingCdkCliError when the binary is missing (ENOENT)', async () => {
    const err = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    stubExec({ error: err });
    await expect(verifyCdkCliAvailable('cdk')).rejects.toBeInstanceOf(MissingCdkCliError);
  });

  it('throws MissingCdkCliError when cdk --version output is unparseable', async () => {
    stubExec({ stdout: 'something completely different\n' });
    await expect(verifyCdkCliAvailable('cdk')).rejects.toBeInstanceOf(MissingCdkCliError);
  });

  it('honors the cdkBinPath argument', async () => {
    stubExec({ stdout: '2.1112.0\n' });
    await verifyCdkCliAvailable('/usr/local/bin/cdk');
    expect(mocks.execFile).toHaveBeenCalled();
    const [bin, args] = mocks.execFile.mock.calls[0]!;
    expect(bin).toBe('/usr/local/bin/cdk');
    expect(args).toEqual(['--version']);
  });

  it('handles cdk version 2.124.0 exactly (boundary — no warn)', async () => {
    stubExec({ stdout: '2.124.0\n' });
    const result = await verifyCdkCliAvailable('cdk');
    expect(result.warn).toBeUndefined();
  });

  it('emits warn for cdk version 2.123.99 (just below the floor)', async () => {
    stubExec({ stdout: '2.123.99\n' });
    const result = await verifyCdkCliAvailable('cdk');
    expect(result.warn).toBeDefined();
  });
});
