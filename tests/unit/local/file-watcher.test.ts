import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFileWatcher, type FileWatcher } from '../../../src/local/file-watcher.js';

/**
 * file-watcher tests use a real tmpdir + real chokidar. Each test
 * waits ~700ms for the debounce window (500ms default + slack for
 * chokidar's event-loop scheduling); the suite is intentionally small
 * to keep the runtime under ~3s.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('createFileWatcher', () => {
  let dir: string;
  let watcher: FileWatcher | undefined;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cdkd-file-watcher-test-'));
  });

  afterEach(async () => {
    if (watcher) {
      await watcher.close();
      watcher = undefined;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('debounces multiple changes into a single onChange call', async () => {
    let callCount = 0;
    watcher = createFileWatcher({
      paths: [dir],
      onChange: () => {
        callCount++;
      },
      debounceMs: 100,
    });
    // Wait for chokidar's initial scan to settle.
    await sleep(150);
    // Burst of writes within the debounce window.
    writeFileSync(path.join(dir, 'a.txt'), '1');
    writeFileSync(path.join(dir, 'b.txt'), '2');
    writeFileSync(path.join(dir, 'c.txt'), '3');
    // Wait past the debounce window.
    await sleep(300);
    expect(callCount).toBe(1);
  });

  it('fires onChange again after a fresh change post-debounce', async () => {
    let callCount = 0;
    watcher = createFileWatcher({
      paths: [dir],
      onChange: () => {
        callCount++;
      },
      debounceMs: 100,
    });
    await sleep(150);
    writeFileSync(path.join(dir, 'a.txt'), '1');
    await sleep(300);
    expect(callCount).toBe(1);
    writeFileSync(path.join(dir, 'b.txt'), '2');
    await sleep(300);
    expect(callCount).toBe(2);
  });

  it('update() adds and removes paths in place', async () => {
    const dir2 = mkdtempSync(path.join(tmpdir(), 'cdkd-file-watcher-test-b-'));
    try {
      let callCount = 0;
      watcher = createFileWatcher({
        paths: [dir],
        onChange: () => {
          callCount++;
        },
        debounceMs: 100,
      });
      await sleep(150);
      // Add dir2 to the watch list.
      watcher.update([dir, dir2]);
      await sleep(150);
      // Touch a file in dir2 — should now fire.
      writeFileSync(path.join(dir2, 'x.txt'), 'x');
      await sleep(300);
      expect(callCount).toBeGreaterThanOrEqual(1);
      const afterAdd = callCount;
      // Now remove dir from the watch list. Touching a file in dir
      // should NOT fire (we wait past the debounce window).
      watcher.update([dir2]);
      await sleep(150);
      writeFileSync(path.join(dir, 'y.txt'), 'y');
      await sleep(300);
      expect(callCount).toBe(afterAdd);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});
