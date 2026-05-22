import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOutputDirAvailable } from '../../../../../src/cli/commands/migrate/output-dir-guard.js';
import { LocalMigrateError } from '../../../../../src/utils/error-handler.js';

describe('assertOutputDirAvailable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-migrate-test-'));
  });

  afterEach(() => {
    if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true });
  });

  it('accepts a non-existent target directory', () => {
    expect(() => assertOutputDirAvailable(tmp, 'MyStack')).not.toThrow();
  });

  it('accepts an empty existing target directory', () => {
    mkdirSync(join(tmp, 'MyStack'));
    expect(() => assertOutputDirAvailable(tmp, 'MyStack')).not.toThrow();
  });

  it('throws LocalMigrateError when target dir exists and is non-empty', () => {
    mkdirSync(join(tmp, 'MyStack'));
    writeFileSync(join(tmp, 'MyStack', 'package.json'), '{}');
    expect(() => assertOutputDirAvailable(tmp, 'MyStack')).toThrow(LocalMigrateError);
  });

  it('error message includes the recovery rm -rf command', () => {
    mkdirSync(join(tmp, 'MyStack'));
    writeFileSync(join(tmp, 'MyStack', 'package.json'), '{}');
    try {
      assertOutputDirAvailable(tmp, 'MyStack');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(LocalMigrateError);
      expect((e as Error).message).toMatch(/rm -rf/);
      expect((e as Error).message).toMatch(/cdkd migrate --from-cfn-stack MyStack/);
    }
  });

  it('throws LocalMigrateError when target path is a file, not a directory', () => {
    writeFileSync(join(tmp, 'MyStack'), 'oops');
    expect(() => assertOutputDirAvailable(tmp, 'MyStack')).toThrow(LocalMigrateError);
    try {
      assertOutputDirAvailable(tmp, 'MyStack');
    } catch (e) {
      expect((e as Error).message).toMatch(/is not a directory/);
    }
  });
});
