import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUTPUT_PATH, assembleChangelog } from '../scripts/assemble-changelog.js';

/**
 * Vitest `globalSetup`: materialises `docs/changelog-cdkd.md` before any test
 * file runs.
 *
 * WHY A GLOBAL SETUP AND NOT A TASK DEPENDENCY. Since issue go-to-k/cdkd#2779
 * option A the shipped changelog is ASSEMBLED from `changelog.d/` and
 * gitignored, so a fresh clone does not have it -- and two suites read it by
 * PATH rather than assembling it, for reasons that are correct in both cases:
 *
 *   - `changelog-entry-size.test.ts`'s PROSE_COPIES walk asks whether the
 *     SHIPPED page states the cap, which is a question about the page.
 *   - `docs-site-links.test.ts` resolves every relative Markdown link to a
 *     real file on disk. Five docs link to the changelog, and a link target
 *     cannot be satisfied in memory.
 *
 * Both were measured RED with the artifact absent -- green locally only
 * because the file happened to exist, which is the shape of a defect that
 * ships and fails in CI.
 *
 * `vite.config.ts` declares `dependsOn: ['gen:changelog']` on the three docs
 * tasks, and that is deliberately NOT the mechanism here: `vp test run` is the
 * canonical test command and invokes vitest directly, so a task dependency
 * never fires for it. A `globalSetup` runs whatever the entry point.
 *
 * It is not a substitute for the in-memory assembly the changelog FENCES do --
 * those take the fragments as their subject, which is what a lane edits.
 */
export default function setup(): void {
  const root = join(import.meta.dirname, '..');
  writeFileSync(join(root, OUTPUT_PATH), assembleChangelog(root));
}
