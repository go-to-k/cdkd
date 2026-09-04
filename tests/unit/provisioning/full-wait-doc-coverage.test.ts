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

/**
 * The types whose row says `--full-wait` does something the default does not.
 *
 * Both halves of that are load-bearing. Parsing ROWS rather than the section's
 * text keeps a type named only in the surrounding prose from satisfying the
 * check. Filtering on the `--full-wait` COLUMN is what keeps this fence
 * distinct from its `--no-wait` sibling now that both read one merged table:
 * eleven types have a row, but only the two that `--full-wait` actually
 * changes should count here — otherwise a provider newly gating a wait on
 * `CDKD_FULL_WAIT` passes silently because one of its types already appears
 * for an unrelated `--no-wait` reason.
 */
function fullWaitRowTypes(): string[] {
  const md = readFileSync(deployDocPath, 'utf8');
  const start = md.indexOf(WAIT_TABLE_HEADING);
  expect(
    start,
    `cli-deploy.md must have a "${WAIT_TABLE_HEADING}" section`
  ).toBeGreaterThanOrEqual(0);
  const rest = md.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const section = next >= 0 ? rest.slice(0, next) : rest;

  let rows = 0;
  const types: string[] = [];
  for (const line of section.split('\n')) {
    if (!line.startsWith('|')) continue;
    // | type | --no-wait | default | --full-wait | CloudFormation | Terraform |
    const cells = line.split('|').slice(1, -1);
    if (cells.length < 4) continue;
    const rowTypes = cells[0]!.match(/AWS::[A-Za-z0-9]+::[A-Za-z0-9]+/g) ?? [];
    if (rowTypes.length === 0) continue;
    rows += 1;
    if (cells[3]!.trim().toLowerCase() === 'same as default') continue;
    types.push(...rowTypes);
  }
  expect(
    rows,
    `parsed no rows out of "${WAIT_TABLE_HEADING}" — the table's shape changed and this fence is measuring nothing`
  ).toBeGreaterThanOrEqual(10);
  return types;
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
    const affected = new Set(fullWaitRowTypes());
    const undocumented = fullWaitProviders.filter((p) => {
      const types = handledTypes(p.source);
      // At least one of the provider's handled types must have a row whose
      // --full-wait column is not "same as default" (a provider handling many
      // types may gate only one wait on --full-wait, so one suffices).
      return !types.some((t) => affected.has(t));
    });
    expect(
      undocumented.map((p) => p.file),
      "these providers honor --full-wait but no handled type has a wait-table row whose --full-wait column differs from the default; add or correct a row"
    ).toEqual([]);
  });
});
