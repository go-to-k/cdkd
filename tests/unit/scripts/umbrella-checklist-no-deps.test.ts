/**
 * `--umbrella-checklist` must RUN with the repo's dependencies unavailable
 * (issue [#2858](https://github.com/go-to-k/cdkd/issues/2858)).
 *
 * `.github/workflows/backfill-umbrella-sync.yml` deliberately sets
 * `run-install: false`, so its render step — which holds no token — cannot fail
 * on dependency resolution. The mode calls only `node:` builtins and reads one
 * committed file, and the workflow's comment said so. It was still wrong: ESM
 * resolves a module's WHOLE graph before any of its code runs, and
 * `diagnose-schema-refresh.mjs` imported `offline-property-evidence.ts`
 * (`typescript-v6`) and `published-sdk-typings.ts` (the same package, via
 * `gen-nested-key-coverage.ts`) at the top. Both of the only two runs the
 * workflow has ever had died at `Cannot find package 'typescript-v6'` — it has
 * never once succeeded, from the day it landed.
 *
 * A source-shape test would have been the obvious fence and the wrong one:
 * asserting "no static import of X" says nothing about the import Y adds
 * tomorrow, and the failure is about the graph, not about two names. So this
 * SPAWNS the mode against a corpus with no `node_modules` at all — the runner's
 * condition — and a POSITIVE CONTROL restores a static import into the same
 * corpus and requires it to fail, which is what proves the corpus can observe a
 * missing dependency rather than passing because nothing was ever resolved.
 */
import { describe, it, expect } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/** The shape guard the workflow itself applies to the rendered file. */
const WORKFLOW_SHAPE = /^- \[ \] |^_No remaining silent-drop properties/m;

/**
 * A corpus carrying what the mode READS and nothing else — no `node_modules`,
 * no `package.json`, so a resolution of any bare specifier must fail.
 */
function makeCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-umbrella-nodeps-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'src/provisioning'), { recursive: true });
  cpSync(join(repoRoot, 'scripts'), join(root, 'scripts'), { recursive: true });
  cpSync(
    join(repoRoot, 'src/provisioning/property-coverage.generated.ts'),
    join(root, 'src/provisioning/property-coverage.generated.ts')
  );
  return root;
}

function runChecklist(root: string) {
  return spawnSync(process.execPath, ['scripts/diagnose-schema-refresh.mjs', '--umbrella-checklist'], {
    cwd: root,
    encoding: 'utf8',
  });
}

describe('--umbrella-checklist runs without the repo dependencies', () => {
  it('renders the checklist in a corpus with no node_modules', () => {
    const root = makeCorpus();
    // The premise, asserted rather than assumed: a corpus that somehow carried
    // `node_modules` would make every case below pass for the wrong reason.
    expect(existsSync(join(root, 'node_modules'))).toBe(false);

    const run = runChecklist(root);
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(WORKFLOW_SHAPE);
  }, 60_000);

  it('CONTROL: the same corpus DOES fail when a dependency-bearing import is static', () => {
    // Without this the case above passes in a corpus where nothing resolves a
    // bare specifier at all — indistinguishable from one where the fix works.
    // Restoring the exact import issue #2858 removed must reproduce the exact
    // error both real runs died on.
    const root = makeCorpus();
    const scriptPath = join(root, 'scripts/diagnose-schema-refresh.mjs');
    const source = readFileSync(scriptPath, 'utf8');
    const anchor = "import { fileURLToPath } from 'node:url';";
    expect(source).toContain(anchor);
    writeFileSync(
      scriptPath,
      source.replace(
        anchor,
        `import { typedSdkMember } from './offline-property-evidence.ts';\n${anchor}`
      )
    );

    const run = runChecklist(root);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("Cannot find package 'typescript-v6'");
    // And the redirect the workflow performs would have produced an EMPTY file,
    // which its shape guard rejects — the second of the two stops.
    expect(run.stdout).not.toMatch(WORKFLOW_SHAPE);
  }, 60_000);

  it('REFUSES a mode that needs the helpers but never loaded them', async () => {
    // The other half of making the import lazy: a caller that neither loaded
    // nor injected must fail LOUDLY. Defaulting to "no evidence" would answer
    // the auto-tolerate question with silence, and that path's one outcome is
    // an allow-list entry — the outcome that must never be reached on a guess.
    //
    // It lives HERE rather than beside the other `diagnose-schema-refresh`
    // cases because the loader memoizes on the module: that file loads the
    // helpers in a `beforeAll`, so by the time any case ran the refusal would
    // be unreachable. A separate file gets its own module instance.
    const { partitionPendingSdkBump } = await import(
      '../../../scripts/diagnose-schema-refresh.mjs'
    );
    expect(() => partitionPendingSdkBump({ divergences: [] })).toThrow(
      /evidence helpers are not loaded/
    );
  });

  it('is a fence for the workflow as it is actually written', () => {
    // The premise this file rests on lives in the workflow: if a later change
    // installs dependencies there, this fence is still true but no longer
    // load-bearing, and the reader should be told rather than left guessing.
    const workflow = readFileSync(
      join(repoRoot, '.github/workflows/backfill-umbrella-sync.yml'),
      'utf8'
    );
    expect(workflow).toContain('run-install: false');
    expect(workflow).toContain('node scripts/diagnose-schema-refresh.mjs --umbrella-checklist');
  });
});
