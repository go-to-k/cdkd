import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vite-plus/test';

/**
 * v0 release fence.
 *
 * cdkd deliberately stays at major version 0 — a v1.0.0 release must be
 * impossible to ship by accident. Releases are batched via release-please
 * (release-please-config.json + .github/workflows/release.yml), and the v0
 * requirement rests on two independent layers this suite pins:
 *
 *   1. `bump-minor-pre-major: true` — while the version is < 1.0.0, a
 *      breaking-change commit bumps MINOR (0.x.0), never 1.0.0. Without it,
 *      release-please's default maps a `feat!:` / BREAKING CHANGE footer
 *      straight to 1.0.0.
 *   2. The publish job's guard step — it hard-fails before `npm publish`
 *      when the computed major is not 0, which also covers the paths layer 1
 *      cannot (a manual `Release-As: 1.0.0` footer, a hand-edited manifest).
 *
 * Losing either layer is silent until the wrong tag exists, so both are
 * fenced here rather than trusted. The version-shaped assertions on the
 * manifest and package.json are the same invariant read from the state
 * files: they go red the moment anything moves the tracked version out of
 * 0.x, and deleting them is the deliberate act a real 1.0.0 would require.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('release-please v0 fence', () => {
  it('bump-minor-pre-major keeps breaking changes below 1.0.0', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'release-please-config.json'), 'utf8'));
    const pkg = config.packages?.['.'];
    expect(pkg).toBeDefined();
    expect(pkg['release-type']).toBe('node');
    expect(pkg['bump-minor-pre-major']).toBe(true);
  });

  it('release PR titles keep the chore(release) convention', () => {
    const config = JSON.parse(readFileSync(join(repoRoot, 'release-please-config.json'), 'utf8'));
    const pattern = config.packages?.['.']?.['pull-request-title-pattern'];
    // chore(release) passes the pr-title-check workflow and, squashed, does
    // not feed a feat/fix bump back into the next release computation.
    expect(pattern).toMatch(/^chore\(release\): /);
    expect(pattern).toContain('${version}');
  });

  it('the tracked versions are still 0.x', () => {
    const manifest = JSON.parse(
      readFileSync(join(repoRoot, '.release-please-manifest.json'), 'utf8'),
    );
    expect(manifest['.']).toMatch(/^0\./);
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
    expect(pkg.version).toMatch(/^0\./);
  });

  it('the publish job refuses a non-0 major before npm publish', () => {
    const workflow = parseYaml(
      readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8'),
    );
    const publish = workflow.jobs?.publish;
    expect(publish).toBeDefined();
    // Publish only runs on an actual release (the release-PR merge), never on
    // the ordinary pushes that merely update the release PR. Exact match, not
    // toContain — an `always() || ...` weakening must fail here.
    expect(publish.if).toBe("${{ needs.release-please.outputs.release_created == 'true' }}");
    // npm OIDC trusted publishing needs the id-token permission on THIS job.
    expect(publish.permissions?.['id-token']).toBe('write');

    const steps: Array<{ run?: string; name?: string }> = publish.steps;
    const guard = steps.find((s) => s.run?.includes('"$MAJOR" != "0"'));
    expect(guard, 'v0 guard step missing from the publish job').toBeDefined();
    // Pin each guard arm with its own exit 1 — the run block carries several
    // `exit 1`s, so a bare toContain('exit 1') would stay green if one arm
    // were softened to a warning. Each arm's body is bounded at its FIRST
    // `fi` line before asserting, so the lazy match cannot cross into a
    // sibling arm and be satisfied by that arm's exit 1.
    const pkgArm = guard!.run!.match(
      /if \[ "\$PKG_VERSION" != "\$VERSION" \]; then\n([^]*?)\nfi\n/,
    );
    expect(pkgArm, 'PKG_VERSION mismatch arm missing').not.toBeNull();
    expect(pkgArm![1]).toContain('exit 1');
    const majorArm = guard!.run!.match(/if \[ "\$MAJOR" != "0" \]; then\n([^]*?)\nfi\n/);
    expect(majorArm, 'MAJOR != 0 arm missing').not.toBeNull();
    expect(majorArm![1]).toContain('exit 1');
    // The 0.* case arm is the third, independent spelling of the same fence.
    expect(guard?.run).toContain('0.*)');
    expect(guard?.run).toMatch(/\*\)\n[^]*?\bexit 1\n/);

    const guardIndex = steps.indexOf(guard!);
    // Exact pin on purpose: any flag added to npm publish (e.g. --provenance)
    // must be a deliberate test edit, not a silent drift of what ships.
    const publishIndex = steps.findIndex((s) => s.run?.trim() === 'npm publish');
    expect(
      publishIndex,
      'no step whose run is exactly `npm publish` (a flag change must update this pin)',
    ).toBeGreaterThan(-1);
    expect(guardIndex, 'v0 guard must run before npm publish').toBeLessThan(publishIndex);
  });

  it('the release-please action is pinned to a full commit sha', () => {
    const workflow = parseYaml(
      readFileSync(join(repoRoot, '.github/workflows/release.yml'), 'utf8'),
    );
    const steps: Array<{ uses?: string }> = workflow.jobs['release-please'].steps;
    const action = steps.find((s) => s.uses?.startsWith('googleapis/release-please-action@'));
    expect(action).toBeDefined();
    expect(action?.uses).toMatch(/@[0-9a-f]{40}( |$)/);
  });
});
