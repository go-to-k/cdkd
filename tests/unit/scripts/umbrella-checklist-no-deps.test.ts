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
import type { EvidenceDeps } from '../../../scripts/diagnose-schema-refresh.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Compile-time fence for `EvidenceDeps`.
 *
 * The declaration file is checked by a CONFIG-LESS `tsc` and cannot import from
 * a `.ts` module, so its three members are a STRUCTURAL COPY of what
 * `offline-property-evidence.ts` and `published-sdk-typings.ts` export — and a
 * copy with nothing comparing it drifts silently. Assigning the real signatures
 * to the declared shape makes `vp run typecheck:test` the comparison.
 *
 * TYPE-ONLY on purpose: a value import would pull `typescript-v6` and the whole
 * SDK-model graph into a file whose entire subject is running WITHOUT them.
 */
type RealEvidenceDeps = {
  typedSdkMember: typeof import('../../../scripts/offline-property-evidence.ts').typedSdkMember;
  providerWiresProperty: typeof import('../../../scripts/offline-property-evidence.ts').providerWiresProperty;
  publishedSdkInterfaces: typeof import('../../../scripts/published-sdk-typings.ts').publishedSdkInterfaces;
};
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _evidenceDepsMatchesTheHelpers: EvidenceDeps = null as unknown as RealEvidenceDeps;

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

/**
 * Replace BOTH helper modules with stubs, so a loader case reaches exactly the
 * condition it injects.
 *
 * Stubbing only one leaves the other's real transitive graph in play, and in a
 * corpus this small that graph fails first for a reason the case is not about.
 * Measured with only `offline-property-evidence.ts` stubbed: the run reports
 * `Cannot find package 'typescript-v6' imported from
 * scripts/gen-nested-key-coverage.ts`, reached through
 * `published-sdk-typings.ts` — so the case would have asserted on a failure it
 * did not inject. With both stubbed it needs no `node_modules` either.
 */
function stubHelpers(root: string, evidenceSource: string): void {
  writeFileSync(join(root, 'scripts/offline-property-evidence.ts'), evidenceSource);
  writeFileSync(
    join(root, 'scripts/published-sdk-typings.ts'),
    'export const publishedSdkInterfaces = () => undefined;\n'
  );
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

  it('a FAILED load exits non-zero instead of rendering a diagnosis', () => {
    // The load sits OUTSIDE the catch that renders `_The automated diagnosis
    // failed to run …_` at exit 0. That swallow exists so a broken diagnosis
    // cannot take down the PR it describes, and the reasoning does not carry
    // here: a run whose inputs never loaded read NOTHING, and reporting that as
    // a diagnosis cdkd chose to write is the same misread the lazy import
    // removes one layer down.
    const root = makeCorpus();
    stubHelpers(root, "throw new Error('module blew up on import');\n");

    // Any non-checklist invocation: the load runs before `main()`, so argv
    // beyond the mode test is irrelevant to what is being fenced.
    const run = spawnSync(process.execPath, ['scripts/diagnose-schema-refresh.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('could not load the evidence helpers');
    expect(run.stderr).toContain('module blew up on import');
    expect(run.stdout).not.toContain('The automated diagnosis failed to run');
  }, 60_000);

  it('REFUSES a load that resolved but exported the wrong shape', () => {
    // `requireEvidenceDeps` tests for the HOLDER, not its members, so a renamed
    // upstream export would leave it defined-but-hollow — and the failure would
    // then surface as `undefined` callables inside the classifier, whose own
    // catch reports "the evidence could not be read" for EVERY property. That
    // reads as a legitimate could-not-determine verdict, which is silence
    // exactly where this module promises a refusal.
    const root = makeCorpus();
    stubHelpers(
      root,
      'export const typedSdkMember = 42;\nexport const providerWiresProperty = () => undefined;\n'
    );

    const run = spawnSync(process.execPath, ['scripts/diagnose-schema-refresh.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('did not export typedSdkMember');
    expect(run.stdout).not.toContain('The automated diagnosis failed to run');
  }, 60_000);

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
