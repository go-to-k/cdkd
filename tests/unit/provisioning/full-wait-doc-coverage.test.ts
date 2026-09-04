import { describe, it, expect } from 'vite-plus/test';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Enforce that every SDK provider whose stabilization wait is gated on
 * `CDKD_FULL_WAIT` is documented in the per-type wait table of
 * `docs/cli-deploy.md`. This is the `--full-wait`-side mirror of
 * `no-wait-doc-coverage.test.ts`: when a provider's default becomes
 * fire-and-forget with `--full-wait` opting into the wait, the resource type
 * MUST appear in that table — otherwise the user-facing "which resources
 * does --full-wait affect" list silently rots.
 *
 * `.claude/rules/providers.md` deferred this backstop while `AWS::ECS::Service`
 * was the only such type; `AWS::CloudFront::Distribution` joining in issue
 * #1282 is the trigger that added it.
 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const providersDir = join(repoRoot, 'src', 'provisioning', 'providers');
const deployDocPath = join(repoRoot, 'docs', 'cli-deploy.md');

/** The single H2 holding the per-resource-type wait table. */
const WAIT_TABLE_HEADING = '## Wait behaviour by resource type';

/** Extract the wait-table section (up to the next `## ` heading). */
function fullWaitSection(): string {
  const md = readFileSync(deployDocPath, 'utf8');
  const start = md.indexOf(WAIT_TABLE_HEADING);
  expect(
    start,
    `cli-deploy.md must have a "${WAIT_TABLE_HEADING}" section`
  ).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next >= 0 ? rest.slice(0, next) : rest;
}

function handledTypes(source: string): string[] {
  const matches = source.match(/'AWS::[A-Za-z0-9]+::[A-Za-z0-9]+'/g) ?? [];
  return [...new Set(matches.map((m) => m.slice(1, -1)))];
}

describe('--full-wait doc coverage', () => {
  const files = readdirSync(providersDir).filter((f) => f.endsWith('-provider.ts'));
  const fullWaitProviders = files
    .map((f) => ({ file: f, source: readFileSync(join(providersDir, f), 'utf8') }))
    .filter((p) => p.source.includes("process.env['CDKD_FULL_WAIT']"));

  it('finds every CDKD_FULL_WAIT-honoring provider (coverage floor)', () => {
    // A parse regression that stops seeing providers must fail loudly, not
    // pass vacuously. As of this test there are 2 such providers (ECS Service
    // steady state, CloudFront Distribution Deployed — issue #1282).
    expect(fullWaitProviders.length).toBeGreaterThanOrEqual(2);
  });

  it('documents each CDKD_FULL_WAIT provider in the cli-deploy.md wait table', () => {
    const section = fullWaitSection();
    const undocumented = fullWaitProviders.filter((p) => {
      const types = handledTypes(p.source);
      // At least one of the provider's handled types must appear in the wait
      // table (a provider handling many types may gate only one wait on
      // --full-wait, so one documented type suffices).
      return !types.some((t) => section.includes(t));
    });
    expect(
      undocumented.map((p) => p.file),
      'these providers honor --full-wait but no handled type appears in the cli-deploy.md wait table; add a row'
    ).toEqual([]);
  });
});
