import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const enableCompileCache = vi.fn();
vi.mock('node:module', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:module')>()),
  enableCompileCache,
}));

const { enableUserCompileCache } = await import('../../../src/cli/compile-cache.js');
const { getCdkdVersion } = await import('../../../src/version.js');

describe('enableUserCompileCache', () => {
  const saved = process.env['XDG_CACHE_HOME'];
  afterEach(() => {
    if (saved === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = saved;
    enableCompileCache.mockReset();
  });

  it('enables the cache in this version directory and prunes the others', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cdkd-compile-cache-enable-'));
    try {
      process.env['XDG_CACHE_HOME'] = home;
      const root = join(home, 'cdkd', 'compile-cache');
      const version = getCdkdVersion();
      mkdirSync(join(root, '0.1.0-older', 'v'), { recursive: true });
      mkdirSync(join(root, version), { recursive: true });

      enableUserCompileCache();

      expect(enableCompileCache).toHaveBeenCalledTimes(1);
      expect(enableCompileCache).toHaveBeenCalledWith(join(root, version));
      for (let i = 0; i < 100 && existsSync(join(root, '0.1.0-older')); i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(readdirSync(root)).toEqual([version]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
