import { describe, it, expect } from 'vite-plus/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * A DOWN-ONLY byte ceiling on the context AGENTS.md injects.
 *
 * AGENTS.md is injected into every session AND into every subagent, so its size
 * is a token cost paid by every lane and every reviewer whether or not it reads
 * a single rule. A file with no ceiling regrows to whatever the last lane
 * needed: the 2026-09-04 compression cut it by half and it had regained 25% six
 * days later, one paragraph per new hook or gate.
 *
 * There is also a HARD external limit. AGENTS.md is a cross-tool convention,
 * and Codex concatenates the AGENTS.md chain under a 32 KiB default
 * (`project_doc_max_bytes`), dropping whatever does not fit. A root file over
 * that budget is silently truncated for those agents, so the ceiling is a
 * correctness bound and not only a cost one.
 *
 * WHY DOWN-ONLY: a ceiling a lane may raise to fit its own addition is not a
 * ceiling — raising it is strictly easier than compressing, so it is what every
 * lane would do. Lower this number when a pass wins bytes back; never raise it.
 *
 * NO CURRENT-SIZE FIGURE IS RECORDED HERE, deliberately: a "now" figure drifts
 * on every edit to the file it describes. The live value comes from `wc -c`.
 *
 * WHAT TO DO WHEN THIS REDS — in this order:
 *   1. Cut RATIONALE, not the directive. Dates, PR/issue numbers used as
 *      evidence, "measured 2026-xx-xx", incident retellings: move them to the
 *      issue or PR that established them.
 *   2. Check whether a HOOK already delivers the rule at the moment of the
 *      action — then AGENTS.md needs the pointer, not the full text.
 *   3. Move PATH-TRIGGERED detail to `.claude/rules/`, but only if a `paths:`
 *      glob genuinely fires when the rule is needed: on the file whose editing
 *      needs the rule, NOT on the file that documents it. Action-triggered
 *      rules (commit / merge / wrap) have no such glob and must stay resident.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const MAX_AGENTS_MD_BYTES = 12_000;

describe('AGENTS.md size budget', () => {
  it('stays under the down-only whole-file ceiling', () => {
    const bytes = Buffer.byteLength(readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8'), 'utf8');
    expect(bytes).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(MAX_AGENTS_MD_BYTES);
  });
});
