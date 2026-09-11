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
  symlinkSync,
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
 * SIX assignments, because one is not a comparison. `Real -> Declared` proves
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
 * BOUND. Measured over ~45 drifts of the declaration, the fence is blind to
 * exactly two PROPERTIES, and they are stated as properties rather than as a
 * list of drifts — an earlier revision enumerated "seven red, one passes" from
 * a matrix run over TWO of the three members, and read as exhaustive:
 *
 *   1. Any TRAILING-OPTIONAL ARITY difference, in either direction — an added
 *      optional parameter or a dropped one, and an added optional MEMBER of a
 *      return shape. TS compares those arity-tolerantly both ways, so no
 *      assignment-shaped fence sees them; `Parameters<…>` tuple comparison is
 *      the tool if it ever matters. (Not uniform across members, which is why
 *      the property and not the drift is what is stated: an added optional
 *      parameter DOES red on `publishedSdkInterfaces`, whose real signature
 *      already declares two optionals for it to collide with.)
 *   2. `any` anywhere — `(...args: any[]) => any` is assignable in both
 *      directions by definition, so it defeats every type-level fence, not
 *      just this one.
 *
 * Everything else measured reds: a changed parameter type, a narrowed or
 * widened return, an added or deleted member, a member dropped from a return
 * shape, a narrowed parameter, and a member turned optional — each on every
 * one of the three helpers.
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

/**
 * A corpus carrying what the mode READS and nothing else — no `node_modules`,
 * no `package.json`, so a resolution of any bare specifier must fail.
 */
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

  it('renders the SUB-ISSUE plan in the same corpus — every render-only mode, not one', () => {
    // The mode the sync workflow actually consumes since go-to-k/cdkd#2949.
    // Asserted as its OWN spawn rather than trusted to the sibling above: they
    // share a parser but not an entry-point arm, and the no-dependency property
    // is about what the process LOADS before either arm runs — so a mode added
    // to `RENDER_ONLY_FLAGS` without being reachable bare would pass a fence
    // that only ever spawns the first one.
    const root = makeCorpus();
    expect(existsSync(join(root, 'node_modules'))).toBe(false);

    const run = spawnSync(
      process.execPath,
      ['scripts/diagnose-schema-refresh.mjs', '--umbrella-subissues'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(run.stderr).toBe('');
    expect(run.status).toBe(0);
    const plan = JSON.parse(run.stdout) as { types: Array<{ type: string; body: string }> };
    expect(Array.isArray(plan.types)).toBe(true);
    expect(plan.types.length, 'the fixture corpus rendered no types').toBeGreaterThan(0);
    // The body carries the marker the reconciler keys on — the one field whose
    // absence would make every run mint duplicates.
    expect(plan.types[0]!.body).toContain(`<!-- backfill-type: ${plan.types[0]!.type} -->`);
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
    expect(run.stderr).not.toContain('could not load the evidence helpers');
    expect(run.stderr).toBe('');
    // Exit 0 is the REPORT mode's contract — a broken diagnosis must not take
    // down the PR it describes — and pinning it here is what keeps this case
    // from passing in a world where the typo starts exiting non-zero for some
    // unrelated reason.
    expect(run.status).toBe(0);
  }, 60_000);

  it('reports a NON-DASH typo as a flag error too', () => {
    // The first pre-check tested only dash-leading tokens, so this spelling —
    // the one `main()`'s own guard comment calls load-bearing — still reported
    // "could not load the evidence helpers" and named the wrong file. Both
    // spellings now go through the SAME classifier `main()` uses.
    const root = makeCorpus();
    const run = spawnSync(
      process.execPath,
      ['scripts/diagnose-schema-refresh.mjs', 'failed-checks', 'property-coverage'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(run.stdout).toContain('unrecognized flag(s): failed-checks, property-coverage');
    expect(run.stderr).not.toContain('could not load the evidence helpers');
    expect(run.status).toBe(0);
  }, 60_000);

  it('REFUSES a positional swallowed by the one boolean flag', () => {
    // `--umbrella-checklist` takes no value, and the shared classifier used to
    // consume a following token as one — so this invocation rendered a full
    // checklist for a command nobody wrote.
    const root = makeCorpus();
    const run = spawnSync(
      process.execPath,
      ['scripts/diagnose-schema-refresh.mjs', '--umbrella-checklist', 'extra-positional'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('unrecognized flag(s): extra-positional');
    expect(run.stdout).not.toMatch(WORKFLOW_SHAPE);
  }, 60_000);

  it('reports a REPEATED flag as a flag error, not as a failed load', () => {
    // The pre-check has THREE arms — unknown, repeated, and the mode test — and
    // only the first two were fenced. Deleting `|| repeated.length > 0` red
    // nothing while changing what a user sees on the no-install runner: the
    // "given more than once" refusal became "could not load the evidence
    // helpers", which is the wrong-file misreport the other cases fence.
    const root = makeCorpus();
    const run = spawnSync(
      process.execPath,
      ['scripts/diagnose-schema-refresh.mjs', '--nested-key-rc', '0', '--nested-key-rc', '3'],
      { cwd: root, encoding: 'utf8' }
    );
    expect(run.stdout).toContain('flag(s) given more than once: --nested-key-rc');
    expect(run.stderr).not.toContain('could not load the evidence helpers');
    expect(run.status).toBe(0);
  }, 60_000);

  it('REFUSES a glued value on the flag that takes none', () => {
    // `knownFlagFor` matches the `=` prefix, so `--umbrella-checklist=x` read as
    // VALID — while `main()` selects the mode with an exact `includes`, which
    // that spelling misses, so it fell through to the full refresh-report path:
    // on the no-install runner a dependency error naming the wrong file.
    //
    // NOT also a splice hazard, though an earlier version of this comment said
    // so: the workflow guards on SHAPE (`grep -qE '^- \[ \] |^_No remaining…'`)
    // and only `renderUmbrellaChecklist` emits those rows, so a refresh report
    // fails that step under `set -euo pipefail` rather than reaching the
    // umbrella. Its own comment says as much.
    const root = makeCorpus();
    const run = spawnSync(
      process.execPath,
      ['scripts/diagnose-schema-refresh.mjs', '--umbrella-checklist=x'],
      { cwd: root, encoding: 'utf8' }
    );
    // Its OWN message, not "unrecognized": that arm listed the flag as known in
    // the same sentence and left the reader to spot the `=x`.
    //
    // Channel AND exit code, because this mode is consumed by a workflow that
    // redirects stdout: its refusals belong on stderr at exit 1, or the
    // redirect captures an error sentence as the rendered checklist.
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('--umbrella-checklist takes no value');
    expect(run.stdout).toBe('');
  }, 60_000);

  it('partitions KNOWN_FLAGS against what the READERS actually consume', async () => {
    // `VALUELESS_FLAGS` is a second copy of a `KNOWN_FLAGS` fact and nothing
    // compared them: a boolean flag left out of it swallows the next token as a
    // value, which is the bug the sibling case above fences for the one flag
    // that has it today.
    //
    // The comparison has to be against a THIRD fact, not against the two
    // constants. A first cut asserted `classifyArgs` consumes a value exactly
    // when the flag is not in `VALUELESS_FLAGS` — which is what `classifyArgs`
    // is written to do, so it was tautological and a new unlisted boolean flag
    // passed it (measured). The third fact is the READER: a flag takes a value
    // iff `main()` reads one for it.
    const { KNOWN_FLAGS, VALUELESS_FLAGS } = await import(
      '../../../scripts/diagnose-schema-refresh.mjs'
    );
    // COMMENT-STRIPPED, with the SIBLING critic's stripper
    // (`integ-secret-fixture-sweep.test.ts`) rather than one written here.
    //
    // Scanning the raw text was DEFEATED — demonstrated, not imagined: a boolean
    // flag added to `KNOWN_FLAGS` plus ONE comment mentioning `rawArg('--x')`
    // made every assertion pass while the shipped script swallowed the next
    // token. The first fix stripped FULL-LINE `//` comments only, and a
    // TRAILING one defeated it identically — measured, and that shape is
    // idiomatic in the file being scanned. Hence the borrowed form: writing a
    // third stripper is how this hole gets reopened a third time. The
    // `(^|[^:])` guard is what keeps it from eating a `https://` inside a
    // string.
    const source = readFileSync(join(repoRoot, 'scripts/diagnose-schema-refresh.mjs'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const READERS = ['rawArg', 'readArg', 'readArgValue', 'readNumArg'];
    const readsAValueFor = (flag: string): boolean =>
      READERS.some((reader) => source.includes(`${reader}('${flag}')`));

    const declaredValueless = [...VALUELESS_FLAGS].sort();
    const withoutAReader = KNOWN_FLAGS.filter((f) => !readsAValueFor(f)).sort();
    expect(withoutAReader).toEqual(declaredValueless);

    // Non-vacuity, and the FIRST cut of it was DEAD: asserting the
    // reader-matched count equals `KNOWN_FLAGS.length - VALUELESS_FLAGS.size` is
    // algebraically implied by the equality above, so it could never red alone.
    // What is independent is that the scan's SUBJECT survived the comment strip
    // — a stripper that ate the whole file leaves every flag unmatched, and only
    // then would the equality be comparing two lists a dead scan produced.
    expect(source).toContain("rawArg('--fixtures-dir')");
    expect(VALUELESS_FLAGS.size).toBeGreaterThan(0);
  });

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
    expect(syncJob).toContain('node scripts/diagnose-schema-refresh.mjs --umbrella-subissues');
    // The SECOND no-dependency consumer in the same job (go-to-k/cdkd#2949).
    // It runs under the same `run-install: false`, so the no-`node_modules`
    // guarantee this file measures has to cover it too — and it is the one that
    // WRITES, across ~44 public issues, so a load-time crash there is not a
    // missing checklist but a half-applied reconciliation.
    expect(syncJob).toContain('node scripts/sync-backfill-subissues.ts');
  });

  it('the reconciler imports nothing outside node: builtins either', () => {
    // Cheaper than a spawn and aimed at the same property, because the spawn
    // cases above can only reach a mode that takes no token. ESM resolves a
    // module's WHOLE graph before any code runs, so the check that matters is
    // static: every import specifier is either `node:`-prefixed or a relative
    // path INSIDE scripts/ that is itself covered by the spawns above.
    const src = readFileSync(join(repoRoot, 'scripts/sync-backfill-subissues.ts'), 'utf8');
    const specifiers = [...src.matchAll(/^import\s[\s\S]*?from\s+'([^']+)';$/gm)].map((m) => m[1]!);
    expect(specifiers.length, 'no imports were found — the scan is looking at nothing').toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(
        spec.startsWith('node:') || spec.startsWith('./'),
        `${spec} is a package import; the sync job installs none`
      ).toBe(true);
    }
    // And the one relative import is the module the spawn cases already prove
    // loads bare. Named, so a new relative import does not ride in on this.
    expect(specifiers.filter((s) => s.startsWith('./'))).toEqual(['./diagnose-schema-refresh.mjs']);
  });
});

describe('the evidence-helper seam', () => {
  it('USES the injected helpers — an AUTO verdict is unreachable without them', async () => {
    // The 4th parameter is the seam the six type assignments above fence.
    //
    // The first cut of this case was VACUOUS, and in the way that keeps
    // recurring: it passed `AWS::Fake::Thing` with an empty `providerFiles`, so
    // `classifyRemovedProperty` returned "could not determine this type's own
    // SDK client" BEFORE reading either helper — the doubles were never
    // invoked, and passing `{}` produced a byte-identical verdict. It pinned
    // that the parameter bypasses `requireEvidenceDeps`, nothing more.
    //
    // So the outcome asserted here is one ONLY the doubles can produce: a real
    // type whose SDK client resolves, a property name no real SDK declares, and
    // doubles that report it typed AND wired. The real helpers answer
    // `undefined` for such a name and the property ESCALATES; the doubles make
    // it `written`. Both helpers are recorded, so "used" is asserted rather
    // than inferred from the verdict.
    const { writeAutoTolerated } = await import('../../../scripts/diagnose-schema-refresh.mjs');
    const root = mkdtempSync(join(tmpdir(), 'cdkd-deps-seam-'));
    corpora.push(root);
    mkdirSync(join(root, 'tests/fixtures/cfn-schemas'), { recursive: true });
    writeFileSync(join(root, 'tests/fixtures/cfn-schemas/_todo-backfill.json'), '{}\n');
    // The client is derived by reading the PROVIDER SOURCE for its
    // `@aws-sdk/client-*` imports and checking that package is installed, so the
    // scratch root needs both: a provider file naming the client, and the real
    // `node_modules` to resolve it against. Without the first, `client` is
    // `undefined` and the classifier returns before reading either helper —
    // which is exactly how the first cut of this case came out vacuous.
    mkdirSync(join(root, 'src/provisioning/providers'), { recursive: true });
    writeFileSync(
      join(root, 'src/provisioning/providers/sqs-queue-provider.ts'),
      "import { SQSClient } from '@aws-sdk/client-sqs';\n"
    );
    symlinkSync(join(repoRoot, 'node_modules'), join(root, 'node_modules'));

    const typedCalls: string[] = [];
    const wiresCalls: string[] = [];
    const result = writeAutoTolerated(
      [{ resourceType: 'AWS::SQS::Queue', properties: ['NoSuchSdkMember'] }] as never,
      new Map([['AWS::SQS::Queue', 'src/provisioning/providers/sqs-queue-provider.ts']]),
      root,
      {
        typedSdkMember: (property: string, client: string) => {
          typedCalls.push(`${property}@${client}`);
          return { client, spelling: 'exact', interfaces: ['SendMessageRequest'] };
        },
        providerWiresProperty: (property: string) => {
          wiresCalls.push(property);
          return { sites: ['src/provisioning/providers/sqs-queue-provider.ts:42'] };
        },
        publishedSdkInterfaces: () => undefined,
      } as never
    );

    // Both helpers were consulted, with the property and the resolved client.
    expect(typedCalls).toEqual(['NoSuchSdkMember@@aws-sdk/client-sqs']);
    expect(wiresCalls).toEqual(['NoSuchSdkMember']);
    // And their answer DECIDED the verdict: nothing else in this file can make
    // a name the SDK does not declare come out as settled.
    expect(result.written.map((w) => w.property)).toEqual(['NoSuchSdkMember']);
    expect(result.escalated).toEqual([]);
  });

});
