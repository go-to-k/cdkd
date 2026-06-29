import { describe, it, expect, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isPreSynthesizedAssembly } from '../../../src/synthesis/synthesizer.js';

// Kept in its own file (no node:fs mock) so the helper runs against real fs.
// synthesizer.test.ts mocks node:fs, which would shadow existsSync / statSync.
describe('isPreSynthesizedAssembly', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'cdkd-presynth-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true for an existing directory (a pre-synthesized assembly)', () => {
    expect(isPreSynthesizedAssembly(tmp)).toBe(true);
  });

  it('returns false for a CDK app command, so it is synthesized normally', () => {
    expect(isPreSynthesizedAssembly('node app.ts')).toBe(false);
  });

  it('returns false for a path that does not exist', () => {
    expect(isPreSynthesizedAssembly(join(tmp, 'does-not-exist'))).toBe(false);
  });

  it('returns false for an existing file (only directories are assemblies)', () => {
    const file = join(tmp, 'cdk.out');
    writeFileSync(file, 'not a directory');
    expect(isPreSynthesizedAssembly(file)).toBe(false);
  });
});
