import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';

/**
 * Every registered SDK provider must be documented in BOTH user-facing
 * coverage pages.
 *
 * WHY. `docs/supported-resources.md` is what a user reads to find out whether
 * cdkd can deploy their resource type, and `docs/import.md` is what they read
 * to find out whether `cdkd import` can adopt it. A type that is registered but
 * absent from either page works and is invisible: the v2 drift-coverage push
 * (PRs #210-#216) shipped seven new resource types — Glue Job / Crawler /
 * Connection / Trigger / Workflow / SecurityConfiguration plus Kinesis
 * StreamConsumer — and missed BOTH pages, caught only by a post-merge audit
 * (#219). This is a PRODUCT property, not a process one: the shipped
 * documentation is wrong until someone notices.
 *
 * This replaces `.claude/hooks/provider-docs-gate.sh`, which asserted the same
 * thing at `git commit` time by diffing the staged index. A PreToolUse hook is
 * the wrong place for it — the harm is a stale docs page, which is reversible
 * and lands on nobody until a release, so by the repo's blocking criterion
 * (`.claude/rules/hooks.md`) it belongs in CI. A tree scan is also strictly
 * stronger than the hook was: the hook only looked at registrations the CURRENT
 * commit ADDED, so a type that slipped through once was never re-examined.
 *
 * The match is on the type STRING, so the shape of either page is free to
 * change; only the exact `AWS::Service::Type` spelling has to appear. It is a
 * WHOLE-TOKEN match: a bare substring test counts `AWS::EC2::Route` as
 * documented wherever `AWS::EC2::RouteTable` is (issue #3412).
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const REGISTER = join(REPO_ROOT, 'src/provisioning/register-providers.ts');

/**
 * Anti-vacuity floor. A refactor that renames `registry.register(` or moves the
 * calls out of this file would make every assertion below pass over an empty
 * set. The floor is well under the current count so ordinary churn does not
 * touch it; it exists to turn "found nothing" into a failure.
 */
const MIN_REGISTERED_TYPES = 100;

/** Whether `body` names `type` as a whole token, not as a prefix of a longer type. */
const namesType = (body: string, type: string): boolean =>
  new RegExp(`(?<![A-Za-z0-9:])${type.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9:])`).test(
    body,
  );

const registeredTypes = (): string[] => {
  const src = readFileSync(REGISTER, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/registry\.register\(\s*'(AWS::[^']+)'/g)) {
    out.add(m[1]!);
  }
  return [...out].sort();
};

describe('registered provider types are documented', () => {
  const types = registeredTypes();

  it('parses a plausible number of registrations', () => {
    expect(types.length).toBeGreaterThanOrEqual(MIN_REGISTERED_TYPES);
  });

  it('docs/supported-resources.md names every registered type', () => {
    const body = readFileSync(join(REPO_ROOT, 'docs/supported-resources.md'), 'utf8');
    const missing = types.filter((t) => !namesType(body, t));
    expect(
      missing,
      `add these resource types to docs/supported-resources.md:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('docs/import.md names every registered type', () => {
    const body = readFileSync(join(REPO_ROOT, 'docs/import.md'), 'utf8');
    const missing = types.filter((t) => !namesType(body, t));
    expect(
      missing,
      `add these resource types to docs/import.md:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });
});
