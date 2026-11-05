import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const warnSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../src/utils/logger.js', () => ({
  getLogger: () => ({ warn: warnSpy, info: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  outputsFileOption,
  resolveOutputsFile,
  toOutputValueString,
  writeStackOutputsFile,
} from '../../../src/cli/commands/outputs-file.js';
import { CdkdError } from '../../../src/utils/error-handler.js';

describe('resolveOutputsFile', () => {
  it('prefers the flag over cdk.json', () => {
    expect(resolveOutputsFile('flag.json', { outputsFile: 'cfg.json' })).toBe('flag.json');
  });
  it('uses cdk.json when the flag is absent', () => {
    expect(resolveOutputsFile(undefined, { outputsFile: 'cfg.json' })).toBe('cfg.json');
  });
  it('is undefined when neither is set', () => {
    expect(resolveOutputsFile(undefined, null)).toBeUndefined();
    expect(resolveOutputsFile(undefined, {})).toBeUndefined();
  });
  it.each([[42], [''], [null], [['a']], [{}]])('rejects invalid cdk.json value %j', (v) => {
    try {
      resolveOutputsFile(undefined, { outputsFile: v });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(CdkdError);
      expect((e as CdkdError).code).toBe('INVALID_OUTPUTS_FILE');
    }
  });
});

describe('toOutputValueString', () => {
  it('stringifies each shape', () => {
    expect(toOutputValueString('s')).toBe('s');
    expect(toOutputValueString(42)).toBe('42');
    expect(toOutputValueString(true)).toBe('true');
    expect(toOutputValueString(['a', 'b', 1])).toBe('a,b,1');
    expect(toOutputValueString({ a: 1 })).toBe('{"a":1}');
  });
});

describe('writeStackOutputsFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cdkd-outputs-unit-'));
    warnSpy.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes 2-space JSON with a trailing newline and creates parent dirs', () => {
    const p = join(dir, 'a', 'b', 'out.json');
    writeStackOutputsFile(p, { S: { K: 'v' } }, { deployFailed: false });
    expect(readFileSync(p, 'utf8')).toBe('{\n  "S": {\n    "K": "v"\n  }\n}\n');
  });

  it('overwrites an existing file without merging', () => {
    const p = join(dir, 'out.json');
    writeFileSync(p, JSON.stringify({ Old: { x: '1' } }));
    writeStackOutputsFile(p, { New: {} }, { deployFailed: false });
    expect(JSON.parse(readFileSync(p, 'utf8'))).toEqual({ New: {} });
  });

  it('resolves a relative path against process.cwd()', () => {
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    writeStackOutputsFile('rel/out.json', { S: {} }, { deployFailed: false });
    expect(existsSync(join(dir, 'rel', 'out.json'))).toBe(true);
  });

  describe('write failure (parent is a regular file)', () => {
    let target: string;
    beforeEach(() => {
      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'x');
      target = join(blocker, 'out.json');
    });

    it('throws OUTPUTS_FILE_WRITE_FAILED when the deploy succeeded', () => {
      try {
        writeStackOutputsFile(target, {}, { deployFailed: false });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(CdkdError);
        expect((e as CdkdError).code).toBe('OUTPUTS_FILE_WRITE_FAILED');
      }
    });

    it('only warns when the deploy already failed', () => {
      expect(() => writeStackOutputsFile(target, {}, { deployFailed: true })).not.toThrow();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(String(warnSpy.mock.calls[0]![0])).toContain('Failed to write stack outputs');
    });
  });
});

describe('outputsFileOption', () => {
  it('declares -O, --outputs-file <path>', () => {
    expect(outputsFileOption.flags).toBe('-O, --outputs-file <path>');
  });
});
