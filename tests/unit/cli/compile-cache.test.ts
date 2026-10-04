import { describe, expect, it } from 'vite-plus/test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  compileCacheDirectory,
  compileCacheVersionDirectory,
  pruneOtherVersions,
} from '../../../src/cli/compile-cache.js';

describe('compileCacheDirectory', () => {
  it('uses $XDG_CACHE_HOME when set', () => {
    expect(compileCacheDirectory({ XDG_CACHE_HOME: '/x/cache' }, () => '/home/u')).toBe(
      join('/x/cache', 'cdkd', 'compile-cache')
    );
  });

  it('falls back to ~/.cache, also for an empty $XDG_CACHE_HOME', () => {
    const expected = join('/home/u', '.cache', 'cdkd', 'compile-cache');
    expect(compileCacheDirectory({}, () => '/home/u')).toBe(expected);
    expect(compileCacheDirectory({ XDG_CACHE_HOME: '' }, () => '/home/u')).toBe(expected);
  });

  // A relative value would resolve against the cwd — a cloned repository.
  it('ignores a relative $XDG_CACHE_HOME', () => {
    expect(compileCacheDirectory({ XDG_CACHE_HOME: '.cache' }, () => '/home/u')).toBe(
      join('/home/u', '.cache', 'cdkd', 'compile-cache')
    );
  });

  // Never a shared location: with no home there is no cache at all.
  it('answers undefined when no home directory can be determined', () => {
    expect(compileCacheDirectory({}, () => '')).toBeUndefined();
    expect(compileCacheDirectory({}, () => 'rel')).toBeUndefined();
    expect(
      compileCacheDirectory({}, () => {
        throw new Error('no passwd entry');
      })
    ).toBeUndefined();
  });
});

describe('compileCacheVersionDirectory', () => {
  it('nests the cache under the cdkd version', () => {
    expect(compileCacheVersionDirectory('/c', '0.294.7')).toBe(join('/c', '0.294.7'));
    expect(compileCacheVersionDirectory('/c', '0.0.0-dev')).toBe(join('/c', '0.0.0-dev'));
  });

  // The version becomes a path segment that pruneOtherVersions keeps; one that
  // could escape the root, or name it, gets no cache at all.
  it('answers undefined for a version that is not a plain path segment', () => {
    for (const v of ['', '.', '..', '../x', 'a/b', 'a\\b', '1..2', '-1']) {
      expect(compileCacheVersionDirectory('/c', v)).toBeUndefined();
    }
  });
});

describe('pruneOtherVersions', () => {
  async function settled(dir: string, expected: string[]): Promise<string[]> {
    for (let i = 0; i < 100; i++) {
      const now = readdirSync(dir).sort();
      if (now.join() === expected.join()) return now;
      await new Promise((r) => setTimeout(r, 10));
    }
    return readdirSync(dir).sort();
  }

  it('deletes every other version and the version-less layout, keeping the current one', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cdkd-compile-cache-prune-'));
    try {
      for (const d of ['0.294.6', '0.294.7', 'v24.21.0-arm64-964aae3f-501']) {
        mkdirSync(join(root, d, 'sub'), { recursive: true });
        writeFileSync(join(root, d, 'sub', 'entry'), 'x');
      }
      writeFileSync(join(root, 'stray-file'), 'x');

      pruneOtherVersions(root, '0.294.7');

      expect(await settled(root, ['0.294.7'])).toEqual(['0.294.7']);
      expect(existsSync(join(root, '0.294.7', 'sub', 'entry'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // rmSync removes a symlinked entry itself and never descends into its target.
  it('removes a symlinked entry without touching what it points at', async () => {
    const base = mkdtempSync(join(tmpdir(), 'cdkd-compile-cache-link-'));
    try {
      const root = join(base, 'root');
      const outside = join(base, 'outside');
      mkdirSync(join(root, '0.294.7'), { recursive: true });
      mkdirSync(outside);
      writeFileSync(join(outside, 'keep-me'), 'x');
      symlinkSync(outside, join(root, 'link'));

      pruneOtherVersions(root, '0.294.7');

      expect(await settled(root, ['0.294.7'])).toEqual(['0.294.7']);
      expect(existsSync(join(outside, 'keep-me'))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  // readdirSync follows a symlinked root, so pruning through one would empty
  // whatever directory a misconfigured XDG_CACHE_HOME points at.
  it('deletes nothing when the root itself is a symlink', () => {
    const base = mkdtempSync(join(tmpdir(), 'cdkd-compile-cache-rootlink-'));
    try {
      const target = join(base, 'somewhere');
      mkdirSync(join(target, 'unrelated'), { recursive: true });
      symlinkSync(target, join(base, 'root'));

      pruneOtherVersions(join(base, 'root'), '0.294.7');

      expect(readdirSync(target)).toEqual(['unrelated']);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('does nothing, and does not throw, when the root does not exist', () => {
    expect(() => pruneOtherVersions(join(tmpdir(), 'cdkd-no-such-root-x'), '0.1.0')).not.toThrow();
  });
});
