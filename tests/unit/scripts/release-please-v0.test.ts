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
  it('release-please splices the next entry at the TOP of CHANGELOG.md', () => {
    // release-please's Changelog updater (updaters/changelog.ts) finds its
    // insertion point with this regex and splices the new entry in FRONT of
    // the match. The leading \n is load-bearing: a file that begins directly
    // with a version header — what semantic-release wrote, with no title —
    // never matches its OWN top entry, so the search lands on the SECOND
    // header and every release is filed one section too low. Measured on
    // release PR go-to-k/cdkd#2503, which ordered the file 0.285.13,
    // 0.285.14, 0.285.12; the miss repeats at the same spot every release,
    // so the disorder compounds. The `# Changelog` title is the fix, and
    // it is also what release-please writes itself when creating the file.
    //
    // Asserting the title string alone would not be enough: the regex wants
    // ## or ###, so an H1 version header (semantic-release used H1 for
    // minor/major bumps) is invisible to it too. This asserts the OUTCOME —
    // the splice point is immediately before the first version header —
    // which covers both causes and any third.
    //
    // Only the FIRST regex below is the updater's — a hand copy of its
    // DEFAULT_VERSION_HEADER_REGEX, mirrored rather than imported, so it can
    // drift: an action bump that changed the constant would leave this
    // attesting to nothing. The sha pin asserted further down is what bounds
    // that, so re-check this literal when the pin moves. Verified against
    // release-please 17.3.0 — the version release-please-action@5c625bf
    // (v4.4.1) resolves and bundles, read from that tag's own package-lock
    // rather than from a locally installed copy, whose 17.11.x carries the
    // same constant and is easy to mistake for the shipped one. The SECOND
    // regex is the test's own and is deliberately WIDER
    // (it accepts H1) — that width is what catches an H1 sitting on top.
    //
    // Known bound: both are code-fence-blind, so a fenced `## [1.2.3]` line
    // inside the preamble would satisfy this while release-please spliced
    // INSIDE the fence, and a preamble line like `# 2026 archive` would red
    // it although the splice is correct. The preamble carries no code fence
    // and no heading; keep it that way rather than complicating the regexes.
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const spliceAt = changelog.search(/\n###? v?[0-9[]/s);
    expect(spliceAt, 'no version header release-please could splice against').toBeGreaterThan(-1);
    const firstHeaderAt = changelog.search(/^#{1,3} v?[0-9[]/m);
    expect(firstHeaderAt, 'no version header at all').toBeGreaterThan(-1);
    expect(
      spliceAt + 1,
      'release-please would file the next release BELOW the newest entry: ' +
        'restore the `# Changelog` title block, or demote a top H1 version header to `## [`',
    ).toBe(firstHeaderAt);
  });

  it('no CHANGELOG.md version header is left at H1', () => {
    // The whole file was normalized to release-please's own shape (title, H2
    // version headers) so that nothing has to be done per release for it to
    // stay conformant: release-please only ever writes `## [x.y.z]`, so an H1
    // version header can now only arrive by hand. semantic-release wrote H1
    // for minor/major bumps, and one of those sitting on top is invisible to
    // the splice regex above (it wants ## or ###) — this keeps the file from
    // drifting back into the mixed state that made the splice miss possible.
    const changelog = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8');
    const h1Versions = changelog.match(/^# v?[0-9[].*$/gm) ?? [];
    expect(h1Versions, 'H1 version headers must be H2').toEqual([]);
    // Floored AT the measurement (878 at the normalization), not under it.
    // A floor far below its subject fences only total disappearance — the
    // shape check-scope-checker-inputs.test.ts already ruled on, and the
    // first cut here was 100 against 878, which an 88% collapse would have
    // passed. At-measurement is safe BECAUSE the count only ever grows (one
    // header per release), so it can never false-red; and it buys a property
    // a lower floor does not have — deleting a single entry reds it.
    // `toBeGreaterThanOrEqual`, not `toBe`: an equality would red on the very
    // next release.
    expect(
      changelog.match(/^## v?[0-9[]/gm)?.length ?? 0,
      'a CHANGELOG version entry went missing — re-measure only if the removal was deliberate',
    ).toBeGreaterThanOrEqual(878);
  });

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
