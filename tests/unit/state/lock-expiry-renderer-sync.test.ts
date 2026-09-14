/**
 * Every renderer of a lock's `expiresAt` goes through ONE helper (issue
 * #3085). Before it, three copies rendered the same field — `state show`'s
 * lock row, the LockManager's warning / retry / refusal, and the contention
 * refusal — and they disagreed twice: `expired NaNmNaNs ago` (issue #3083) and
 * a numeric string that one copy called a deadline and the expiry check called
 * expired. A fourth copy is how the next disagreement starts, so this fence
 * refuses the expiry PHRASES (`expires in` / `expires at an unknown time` /
 * `expired <duration> ago`) anywhere under `src/` but the owner, and requires
 * each known consumer to call the helper with the RAW field.
 *
 * Source-text fence, satisfiable only by the real thing: the owner is matched
 * as a whole `export function formatLockExpiry(` declaration, a consumer
 * counts only when the CALL appears, and comments are stripped first so a
 * mention in prose can neither satisfy nor trip it. Line comments are stripped
 * BEFORE block comments, and a block comment must open a line: the first cut
 * stripped `/*` anywhere, and a `deployments/*.jsonl` inside a `//` comment in
 * `lock-manager.ts` opened a phantom block that swallowed the `LockError`
 * refusal — the fence stayed green with the copy re-inlined there (review of
 * go-to-k/cdkd#3095).
 */
import { describe, expect, it } from 'vite-plus/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const read = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

const OWNER = 'src/state/lock-contention-message.ts';
/** The consumers that MUST call the helper (each rendered its own copy once). */
const CONSUMERS = ['src/cli/commands/state.ts', 'src/state/lock-manager.ts'];

/**
 * The phrases only the owner may spell. `expired` is matched with any of the
 * ways a duration gets glued on after it — `${`, a `+` concatenation, or a
 * closing quote followed by `+` — because a differently-spelled copy is still
 * a copy. A phrase that merely ENDS in `expired` (`treats as already expired`,
 * `Symbol('drain-cap-expired')`) glues nothing on and is not one.
 */
const EXPIRY_PHRASE = /expires (in|at an unknown time)|expired\s*(\$\{|\+)|expired\s+['"`]\s*\+/;

/** Strip line comments, then block comments that OPEN a line — see the header for why in that order. */
function code(text: string): string {
  return text.replace(/(^|[^:'"`])\/\/.*$/gm, '$1').replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

describe('lock-expiry renderer sync (issue #3085)', () => {
  it('the owner declares formatLockExpiry once', () => {
    expect(code(read(OWNER)).match(/export function formatLockExpiry\(/g)).toHaveLength(1);
  });

  it('no file under src/ but the owner spells an expiry phrase', () => {
    const files = walk(join(ROOT, 'src')).map((p) => relative(ROOT, p));
    // The population must include the three files this fence exists for, or a
    // renamed / moved one would drop out and read as compliant.
    for (const rel of [OWNER, ...CONSUMERS]) expect(files).toContain(rel);
    const offenders = files.filter((rel) => rel !== OWNER && EXPIRY_PHRASE.test(code(read(rel))));
    expect(offenders).toEqual([]);
  });

  it('every consumer CALLS formatLockExpiry with the RAW expiresAt', () => {
    for (const rel of CONSUMERS) {
      const body = code(read(rel));
      expect(body, `${rel} must call formatLockExpiry`).toMatch(/formatLockExpiry\(/);
      // Never a difference — subtracting first is the coercion that split the
      // renderers — whether inline or precomputed into a local on the lines
      // above the call.
      expect(body, `${rel} must not subtract before the call`).not.toMatch(
        /formatLockExpiry\([^)]*-\s*Date\.now\(\)/
      );
      for (const m of body.matchAll(/formatLockExpiry\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) {
        const local = m[1]!;
        expect(body, `${rel} passes a local '${local}' that was computed as a difference`).not.toMatch(
          new RegExp(`(const|let)\\s+${local}\\s*=[^;]*-\\s*Date\\.now\\(\\)`)
        );
      }
    }
    expect(code(read(OWNER))).not.toMatch(/formatLockExpiry\([^)]*-\s*Date\.now\(\)/);
  });
});
