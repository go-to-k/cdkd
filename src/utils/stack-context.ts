import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-stack log buffer for parallel multi-stack deploys.
 *
 * Without buffering, two concurrent `deploy()` calls interleave their
 * `logger.info(...)` lines: stack A's "Changes: 4 to create" appears in
 * the middle of stack B's `[N/N] ✅ ...` progress, and stack B's
 * "Deployment completed" lands after stack A's late progress lines. With
 * buffering, each stack's log output is captured into its own buffer
 * for the duration of the deploy and flushed atomically when the deploy
 * finishes — so the user sees one clean per-stack block.
 *
 * Single-stack deploys do NOT enable buffering (the caller checks
 * `stacks.length > 1`); real-time output is preferred when there is no
 * interleaving risk.
 */
export interface StackOutputBuffer {
  lines: string[];
}

const outputBufferStore = new AsyncLocalStorage<StackOutputBuffer>();

/**
 * Run `fn` with a fresh log buffer scoped to its async chain. Any
 * `logger.info / debug / warn / error` calls inside `fn` (and any
 * `await`s) push into the buffer instead of writing to stdout/stderr.
 * Returns the buffered lines (and either `result` or `error`) so the
 * caller can flush them in one block.
 */
export async function runStackBuffered<T>(
  fn: () => Promise<T>
): Promise<{ lines: string[] } & ({ ok: true; result: T } | { ok: false; error: unknown })> {
  const buffer: StackOutputBuffer = { lines: [] };
  return outputBufferStore.run(buffer, async () => {
    try {
      const result = await fn();
      return { ok: true, result, lines: buffer.lines };
    } catch (error) {
      return { ok: false, error, lines: buffer.lines };
    }
  });
}

/**
 * Get the current async context's stack output buffer, or `undefined`
 * if no `runStackBuffered` is active. The logger consults this on every
 * call: present → push to buffer; absent → fall through to live
 * renderer / console.
 */
export function getCurrentStackOutputBuffer(): StackOutputBuffer | undefined {
  return outputBufferStore.getStore();
}
