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
import { describe, it, expect, afterEach } from 'vite-plus/test';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
 * copy with nothing comparing it drifts silently.
 *
 * FOUR assignments, because one is not a comparison. `Real -> Declared` proves
 * only that the real helpers SATISFY the declaration, so every drift making the
 * declaration LOOSER passes it. The inverse closes that direction, `keyof`
 * closes a deleted member, and `Required` closes a member turned OPTIONAL —
 * which neither of the other two can see.
 *
 * The inverse is `Pick`ed to the two helpers declared verbatim: a full inverse
 * reds at baseline, because `publishedSdkInterfaces` is deliberately declared
 * `ReadonlyMap<…, unknown>` against the real `Map<…, SdkMemberType>` — the
 * declaration file cannot name `SdkMemberType` without importing a `.ts` module.
 * That exclusion is why the member gets its OWN two-directional comparison
 * against a locally written expectation below: without it, the one member the
 * inverse cannot cover was the one member nothing covered.
 *
 * BOUND, measured against these four assignments over eleven drifts of the
 * declaration. RED: a changed parameter type, a narrowed return, a widened
 * return, an extra member, a deleted member, a member dropped from a return
 * shape, a narrowed parameter, and — on `publishedSdkInterfaces` specifically —
 * a widened return and an optional member. The two that PASS:
 *
 *   1. an EXTRA TRAILING OPTIONAL parameter on any helper. TS compares function
 *      parameters by arity-tolerant assignability in BOTH directions, so no
 *      assignment-shaped fence can see it; `Parameters<…>` tuple comparison is
 *      the tool if it ever matters. Least damaging of the eleven — the
 *      parameter is optional, so every real call still typechecks.
 *   2. `(...args: any[]) => any`. `any` is assignable in both directions by
 *      definition, so it defeats every type-level fence, not just this one.
 *
 * State the bound rather than the fence's strength: an earlier revision of this
 * comment generalized a measurement taken over TWO of the three members and read
 * as exhaustive. It was not.
 *
 * TYPE-ONLY on purpose: a value import would pull `typescript-v6` and the whole
 * SDK-model graph into a file whose entire subject is running WITHOUT them.
 */
type RealEvidenceDeps = {
  typedSdkMember: typeof import('../../../scripts/offline-property-evidence.ts').typedSdkMember;
  providerWiresProperty: typeof import('../../../scripts/offline-property-evidence.ts').providerWiresProperty;
  publishedSdkInterfaces: typeof import('../../../scripts/published-sdk-typings.ts').publishedSdkInterfaces;
};
/** What the declaration is ALLOWED to say about the one excluded member. */
type ExpectedPublishedSdkInterfaces = (
  client: string,
  version: string
) => ReadonlyMap<string, ReadonlyMap<string, unknown>> | undefined;

const _evidenceDepsAcceptsTheHelpers: EvidenceDeps = null as unknown as RealEvidenceDeps;
const _evidenceDepsIsNotLooser: Pick<
  RealEvidenceDeps,
  'typedSdkMember' | 'providerWiresProperty'
> = null as unknown as Pick<EvidenceDeps, 'typedSdkMember' | 'providerWiresProperty'>;
const _evidenceDepsDeclaresEveryMember: keyof EvidenceDeps =
  null as unknown as keyof RealEvidenceDeps;
const _evidenceDepsDeclaresNothingOptional: Required<EvidenceDeps> =
  null as unknown as EvidenceDeps;
const _publishedSdkInterfacesIsExact: ExpectedPublishedSdkInterfaces =
  null as unknown as EvidenceDeps['publishedSdkInterfaces'];
const _publishedSdkInterfacesIsNotLooser: EvidenceDeps['publishedSdkInterfaces'] =
  null as unknown as ExpectedPublishedSdkInterfaces;

/** The shape guard the workflow itself applies to the rendered file. */
const WORKFLOW_SHAPE = /^- \[ \] |^_No remaining silent-drop properties/m;

/**
 * A corpus carrying what the mode READS and nothing else — no `node_modules`,
 * no `package.json`, so a resolution of any bare specifier must fail.
 */
/**
 * Every corpus this file creates, removed in `afterEach`.
 *
 * `makeCorpus` copies the whole ~2 MB `scripts/` tree and is called once per
 * case, so without this the file leaks ~8 MB of tmpdirs per run — the sibling
 * `diagnose-schema-refresh.test.ts` removes each of its ~12 scratch roots and
 * this one did not.
 */
const corpora: string[] = [];

afterEach(() => {
  while (corpora.length > 0) rmSync(corpora.pop()!, { recursive: true, force: true });
});

function makeCorpus(): string {
  const root = mkdtempSync(join(tmpdir(), 'cdkd-umbrella-nodeps-'));
  corpora.push(root);
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
 * `Cannot find package 'typescript-v6' imported from <root>/scripts/
 * gen-nested-key-coverage.ts` (an absolute path at runtime), reached through
 * `published-sdk-typings.ts`'s import of `collectSdkInterfaces` — so the case
 * would have asserted on a failure it did not inject. With both stubbed it needs
 * no `node_modules` either.
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

  it('reports a MISTYPED flag as a flag error, not as a failed load', () => {
    // The load runs before `main()`'s own guard, so without the argv pre-check
    // a typo on the no-install runner reported "could not load the evidence
    // helpers" — naming the wrong file, which is what the loader's own comment
    // argues against.
    const root = makeCorpus();
    const run = spawnSync(
      process.execPath,
      ['scripts/diagnose-schema-refresh.mjs', '--umbrella-checklists'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(run.stdout).toContain('unrecognized flag(s): --umbrella-checklists');
    expect(run.stdout).not.toContain('could not load the evidence helpers');
    expect(run.stderr).toBe('');
  }, 60_000);

  it('names EVERY hollow member, not just the first', () => {
    // `missing.join(', ')` is only exercised at length 1 by the case above, and
    // only for `typedSdkMember`. A one-name report would read as "the rest are
    // fine" while nothing checked them.
    const root = makeCorpus();
    stubHelpers(root, 'export const typedSdkMember = 42;\nexport const providerWiresProperty = 7;\n');
    writeFileSync(
      join(root, 'scripts/published-sdk-typings.ts'),
      'export const publishedSdkInterfaces = null;\n'
    );

    const run = spawnSync(process.execPath, ['scripts/diagnose-schema-refresh.mjs'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(
      'did not export typedSdkMember, providerWiresProperty, publishedSdkInterfaces AS A FUNCTION'
    );
  }, 60_000);

  it('is a fence for the workflow as it is actually written', () => {
    // The premise this file rests on lives in the workflow: if a later change
    // installs dependencies there, this fence is still true but no longer
    // load-bearing, and the reader should be told rather than left guessing.
    const workflow = readFileSync(
      join(repoRoot, '.github/workflows/backfill-umbrella-sync.yml'),
      'utf8'
    );
    // Bound to the SAME job, not merely to the file: `toContain` on the whole
    // document would still pass if a second job appeared that installs and a
    // third that renders. One job (`sync`) exists today, so this is a fence
    // against the file GROWING, which is when a whole-file match stops meaning
    // anything.
    const jobs = workflow.slice(workflow.indexOf('\njobs:'));
    expect(jobs.match(/^ {2}[\w-]+:$/gm)).toEqual(['  sync:']);
    const syncJob = jobs.slice(jobs.indexOf('\n  sync:'));
    expect(syncJob).toContain('run-install: false');
    expect(syncJob).toContain('node scripts/diagnose-schema-refresh.mjs --umbrella-checklist');
  });
});

describe('the evidence-helper seam', () => {
  it('accepts INJECTED helpers, so a caller need not load anything', async () => {
    // The 4th parameter is the seam the three type assignments above fence, and
    // until now nothing passed it — the source comment "tests that inject
    // doubles never reach the loader" described a test that did not exist.
    const { writeAutoTolerated } = await import('../../../scripts/diagnose-schema-refresh.mjs');
    const root = mkdtempSync(join(tmpdir(), 'cdkd-deps-seam-'));
    corpora.push(root);
    mkdirSync(join(root, 'tests/fixtures/cfn-schemas'), { recursive: true });
    writeFileSync(join(root, 'tests/fixtures/cfn-schemas/_todo-backfill.json'), '{}\n');

    const result = writeAutoTolerated(
      [{ resourceType: 'AWS::Fake::Thing', properties: ['Gone'] }] as never,
      new Map<string, string>(),
      root,
      // Doubles: no load has happened in this module instance, so reaching the
      // loader at all would throw the refusal instead.
      {
        typedSdkMember: () => undefined,
        providerWiresProperty: () => undefined,
        publishedSdkInterfaces: () => undefined,
      } as never
    );
    // The verdict itself belongs to `classifyRemovedProperty`'s own suite; what
    // this pins is that the injected helpers were USED — with no load, any
    // other path throws.
    expect(result.escalated.map((e) => e.property)).toEqual(['Gone']);
    expect(result.written).toEqual([]);
  });

  it('loads once — a second call returns the same helpers', async () => {
    // Asserted in the loader's docblock and by nothing else: deleting the
    // memoization guard reds no case, and a second import of a module that
    // THREW would re-throw rather than re-run.
    const mod = await import('../../../scripts/diagnose-schema-refresh.mjs');
    const first = await mod.loadEvidenceDeps();
    const second = await mod.loadEvidenceDeps();
    expect(second).toBe(first);
  });
});
