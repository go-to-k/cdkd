/**
 * Every renderer of a lock's `expiresAt` goes through ONE helper (issue
 * #3085). Before it, three copies rendered the same field — `state show`'s
 * lock row, the LockManager's warning / retry / refusal, and the contention
 * refusal — and they disagreed twice: `expired NaNmNaNs ago` (issue #3083) and
 * a numeric string that one copy called a deadline and the expiry check called
 * expired. A fourth copy is how the next disagreement starts, so this fence
 * refuses a `formatDuration` / `expires in` spelling outside the owner.
 *
 * Source-text fence, satisfiable only by the real thing: the owner is matched
 * as a whole `export function formatLockExpiry(` declaration, and a consumer
 * counts only when the CALL appears, not a mention in a comment.
 */
import { describe, expect, it } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const OWNER = 'src/state/lock-contention-message.ts';
const CONSUMERS = ['src/cli/commands/state.ts', 'src/state/lock-manager.ts'];

/** Strip line and block comments so a mention in prose cannot satisfy or trip the fence. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('lock-expiry renderer sync (issue #3085)', () => {
  it('the owner declares formatLockExpiry once and is the only place that spells the expiry phrases', () => {
    const owner = code(read(OWNER));
    expect(owner.match(/export function formatLockExpiry\(/g)).toHaveLength(1);
    for (const rel of CONSUMERS) {
      const body = code(read(rel));
      expect(body, `${rel} must not carry its own expiry wording`).not.toMatch(
        /expires (in|at an unknown time)|expired [$][{]/
      );
    }
  });

  it('every consumer CALLS formatLockExpiry rather than re-deriving the deadline', () => {
    for (const rel of CONSUMERS) {
      const body = code(read(rel));
      expect(body, `${rel} must call formatLockExpiry`).toMatch(/formatLockExpiry\(/);
      // The raw field, never a difference — subtracting first is the coercion
      // that split the renderers.
      expect(body, `${rel} must hand the RAW expiresAt to the helper`).not.toMatch(
        /formatLockExpiry\([^)]*-\s*Date\.now\(\)/
      );
    }
    const owner = code(read(OWNER));
    expect(owner).not.toMatch(/formatLockExpiry\([^)]*-\s*Date\.now\(\)/);
  });
});
