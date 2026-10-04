import { describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';

import { compileCacheDirectory } from '../../../src/cli/compile-cache.js';

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
    expect(
      compileCacheDirectory({}, () => {
        throw new Error('no passwd entry');
      })
    ).toBeUndefined();
  });
});
