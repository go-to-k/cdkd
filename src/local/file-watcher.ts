import * as chokidar from 'chokidar';
import { getLogger } from '../utils/logger.js';

/**
 * Debounced file watcher used by `cdkd local start-api --watch`
 * (PR 8c, issue #235).
 *
 * Wraps {@link chokidar.watch} with a 500ms debounce window so a single
 * `cdk synth` (which rewrites every file under `cdk.out/` over the
 * course of a few hundred ms) collapses to one `'reload'` event.
 *
 * The watch list is dynamic — at server boot we pass in `cdk.out/`
 * plus every routed Lambda's asset directory; on hot reload we
 * `update(...)` to add/remove paths in place rather than tearing the
 * watcher down + rebuilding (which would lose chokidar's internal
 * inode-stat cache and re-fire `'add'` events for every existing
 * file).
 *
 * Emits a single `'reload'` callback per debounce window. Does NOT
 * pass the changed file path — the orchestrator re-runs the full
 * synth → discover → diff sequence regardless of which file changed,
 * because `cdk synth` rewrites template + asset paths atomically and
 * the orchestrator can't reason about partial updates.
 */

export interface FileWatcher {
  /** Replace the watched-paths list. Accepts both add + remove. */
  update(paths: readonly string[]): void;
  /** Stop watching everything. */
  close(): Promise<void>;
}

export interface FileWatcherOptions {
  /** Initial set of paths to watch. */
  paths: readonly string[];
  /** Callback fired (debounced) when any watched path changes. */
  onChange: () => void;
  /** Debounce window in ms. Default 500ms (issue brief). */
  debounceMs?: number;
  /**
   * Pass `true` to suppress the initial `'add'` event chokidar
   * normally fires for every existing file when the watcher starts up
   * — without this, the first `cdk synth` watcher boot would fire
   * `'reload'` immediately. Default `true`.
   */
  ignoreInitial?: boolean;
}

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Construct a {@link FileWatcher}. The watcher is active immediately
 * (chokidar starts listening before this function returns); the
 * caller does not need to `await` ready.
 *
 * Errors from chokidar (typically "ENOENT: path doesn't exist") are
 * logged at debug and otherwise swallowed — the start-api server
 * should keep serving even when one of the watched asset directories
 * goes missing during a reload.
 */
export function createFileWatcher(options: FileWatcherOptions): FileWatcher {
  const logger = getLogger().child('start-api-watch');
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ignoreInitial = options.ignoreInitial !== false;

  const watcher = chokidar.watch([...options.paths], {
    ignoreInitial,
    // Don't follow symlinks — asset directories under `cdk.out/asset.<hash>/`
    // are real directories; following symlinks would risk cycling into
    // `node_modules` or similar.
    followSymlinks: false,
    // Don't crash on permission errors.
    ignorePermissionErrors: true,
  });

  let timer: NodeJS.Timeout | null = null;
  const fire = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      try {
        options.onChange();
      } catch (err) {
        logger.warn(`onChange callback threw: ${err instanceof Error ? err.message : String(err)}`);
      }
    }, debounceMs);
    timer.unref?.();
  };

  // Subscribe to every file-changing event chokidar emits. We
  // intentionally don't subscribe to `'addDir'` / `'unlinkDir'` because
  // those fire for every nested directory chokidar discovers at
  // start-up; the surrounding `'add'` / `'unlink'` events are enough
  // for our purposes (a directory rename that doesn't change any file
  // contents shouldn't trigger a hot reload).
  watcher.on('add', fire);
  watcher.on('change', fire);
  watcher.on('unlink', fire);

  watcher.on('error', (err) => {
    logger.debug(
      `chokidar error: ${err instanceof Error ? err.message : String(err)}. Continuing.`
    );
  });

  let currentPaths = new Set(options.paths);

  return {
    update: (paths: readonly string[]): void => {
      const next = new Set(paths);
      const toAdd: string[] = [];
      const toRemove: string[] = [];
      for (const p of next) if (!currentPaths.has(p)) toAdd.push(p);
      for (const p of currentPaths) if (!next.has(p)) toRemove.push(p);
      if (toAdd.length > 0) watcher.add(toAdd);
      if (toRemove.length > 0) watcher.unwatch(toRemove);
      currentPaths = next;
    },
    close: async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await watcher.close();
    },
  };
}
