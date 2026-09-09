#!/usr/bin/env node
// @ts-check

/**
 * Explain, in the refresh pull request itself, what a maintainer has to decide.
 *
 * `.github/workflows/cfn-schema-refresh.yml` opens a PR whose CI may be RED by
 * design: the bot runs only the mechanical regeneration, so a property AWS
 * REMOVED and a nested key AWS ADDED both land as a failing check that no
 * amount of re-running clears. Before this script the PR said only that such a
 * class exists; finding out WHICH property, on which type, declared where, meant
 * opening the CI log and reading two different checkers' output.
 *
 * That digging is entirely mechanical, so it is done here. What is NOT done
 * here is the decision — see {@link renderDiagnosis}'s note and
 * `docs/schema-refresh-runbook.md`.
 *
 * Two facts are contributed that neither checker has.
 *
 * 1. Whether a bogus declaration is bogus because **AWS removed the property in
 *    this refresh**, or was already bogus before it (an SDK-only field name,
 *    the long-standing `bogusTolerated` class). The checkers see only the
 *    current fixture; this compares the committed fixture against the refreshed
 *    one, so the answer is derived rather than guessed.
 *
 * 2. Whether the **AWS SDK still models a member of that name**. This is the
 *    evidence the decision actually turns on: a property gone from the CFn
 *    schema but still present in the SDK is one the API very likely still
 *    accepts (keep sending it), while one absent from BOTH models is one both
 *    of AWS's own descriptions have dropped. It is reported as EVIDENCE, never
 *    as a verdict — the CFn property name and the SDK member name are not
 *    always the same string, which is exactly why this repo carries
 *    hand-maintained rename maps, so a name-level miss can mean "renamed" as
 *    easily as "removed".
 *
 * Usage (from the repo root, AFTER the refresh has written the fixtures):
 *
 *   node scripts/diagnose-schema-refresh.mjs \
 *     [--nested-key-log <file>] [--nested-key-rc <status>] \
 *     [--failed-checks <a,b>] [--skipped-log <file>] [--fixtures-dir <dir>] \
 *     [--decision-count-out <file>] [--auto-tolerated <file>] > body.md
 *
 * And, as separate modes taking no other flag:
 *
 *   node scripts/diagnose-schema-refresh.mjs --umbrella-checklist > checklist.md
 *
 *   node scripts/diagnose-schema-refresh.mjs --write-auto-tolerated <file>
 *
 * `--nested-key-log` is the captured output of
 * `vp run audit:nested-key-coverage:check` and `--nested-key-rc` its exit
 * status. The status is what tells a checker that FAILED silently from one that
 * found nothing, so the workflow always passes it; omitted, it is assumed to be
 * 0, which is the right default for a by-hand run against a checker you just
 * watched succeed. `--failed-checks` is the comma-separated list of CI checks
 * that came back red — every one of them fixture-driven, and every one reached
 * by an ordinary schema ADDITION. `--skipped-log` is the tail of the refresh's
 * own output, listing the types the public bundle does not carry.
 *
 * `--write-auto-tolerated` is the WRITE mode: it classifies every removed-but-
 * declared property, writes a `bogusTolerated` entry for the ones two structural
 * facts settle (the type's own SDK client declares a member of the name, and the
 * provider wires it — with no rename candidate on the type), and records what it
 * settled and what it refused into the named file. It runs as its own workflow
 * step BEFORE the checks, so the PR arrives green on properties nothing was
 * going to decide differently. `--auto-tolerated` hands that record back to the
 * report, which lists the automatic writes in their own section and leaves them
 * out of the decision count.
 *
 * `--decision-count-out` names a file to write the number of things needing a
 * decision into, as a side effect of the same run that renders the report. The
 * workflow marks the PR from it — a label, a title suffix, an assignee — and
 * clears the marking when it reaches 0. It is a side effect rather than a
 * second mode on purpose: a second invocation would re-read `--failed-checks`
 * and `--nested-key-log` from its own argv, so a workflow passing one of them
 * to the report and not to the count would mark a PR as needing nothing over a
 * report listing several.
 *
 * `--umbrella-checklist` is a SEPARATE MODE: it renders the remaining
 * silent-drop properties from the coverage module as a Markdown checklist and
 * exits, taking no other flag. `.github/workflows/backfill-umbrella-sync.yml`
 * splices that block into the backfill umbrella between its markers whenever
 * `main`'s coverage map moves — not the scheduled refresh job, which would be
 * describing its own unmerged workspace. It REGENERATES rather than appends: an
 * appended list cannot express a type that was ticked off and later regained a
 * property.
 *
 * A failure in this mode EXITS NON-ZERO rather than printing the fallback
 * sentence, because the consumer is a workflow that cannot read one — see the
 * catch at the bottom of this file.
 *
 * `--fixtures-dir` is a TEST SEAM — it points the comparison at a scratch
 * directory so the empty-listing refusal is reachable from a test, the same
 * shape `gen-nested-key-coverage.ts` uses for `--providers-dir=`. Documented
 * rather than hidden because the synopsis and the accepted flag set are fenced
 * EQUAL, and an undocumented flag is exactly how that fence goes stale.
 *
 * Emits Markdown on stdout and always exits 0 — a diagnosis that fails must
 * not take down the PR it is describing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * The two evidence helpers, loaded ON DEMAND rather than imported at the top.
 *
 * `--umbrella-checklist` renders from one committed file and calls neither, but
 * ESM resolves a module's WHOLE graph before any of its code runs — so a static
 * import made the mode die at load time on `Cannot find package 'typescript-v6'`
 * (reached through `offline-property-evidence.ts`, and again through
 * `published-sdk-typings.ts` -> `gen-nested-key-coverage.ts`). That is why
 * `.github/workflows/backfill-umbrella-sync.yml` — which deliberately runs
 * WITHOUT `vp install`, so its token-less render step cannot fail on dependency
 * resolution — failed on both of the only two runs it has ever had, from the
 * day it landed (issue [#2858](https://github.com/go-to-k/cdkd/issues/2858)).
 * The workflow's comment asserting the mode needs no dependencies was a true
 * statement about what the mode CALLS and a false one about what it LOADS.
 *
 * Kept as an explicit loader rather than an `await import()` at each use site
 * because both consumers are synchronous exported functions with their own
 * injection seams, and making them async would ripple through `main()` and
 * every caller for no gain.
 *
 * @type {{ typedSdkMember: typeof import('./offline-property-evidence.ts').typedSdkMember,
 *          providerWiresProperty: typeof import('./offline-property-evidence.ts').providerWiresProperty,
 *          publishedSdkInterfaces: typeof import('./published-sdk-typings.ts').publishedSdkInterfaces } | undefined}
 */
let evidenceDeps;

/** Load the evidence helpers. Idempotent; call before any mode that needs them. */
export async function loadEvidenceDeps() {
  if (evidenceDeps !== undefined) return evidenceDeps;
  const [evidence, published] = await Promise.all([
    import('./offline-property-evidence.ts'),
    import('./published-sdk-typings.ts'),
  ]);
  const loaded = {
    typedSdkMember: evidence.typedSdkMember,
    providerWiresProperty: evidence.providerWiresProperty,
    publishedSdkInterfaces: published.publishedSdkInterfaces,
  };
  // VALIDATED before it is stored. The message names only EXPORT-level causes on
  // purpose: the `Promise.all` above has already resolved, so a module that
  // moved or was renamed failed there with `Cannot find module` and never
  // reaches this line — naming it here would point a maintainer at the wrong
  // file. A renamed upstream export leaves the object
  // defined but hollow, which `requireEvidenceDeps` cannot see — and the
  // failure would then surface as `undefined` callables inside the classifier,
  // whose own catch reports "the evidence could not be read" for EVERY
  // property. That is silence where this module promises a refusal, and it
  // reads as a legitimate could-not-determine verdict.
  const missing = Object.entries(loaded)
    .filter(([, fn]) => typeof fn !== 'function')
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `the evidence helpers did not export ${missing.join(', ')} AS A FUNCTION — the export ` +
        'was removed, renamed, or is no longer a function, and continuing would report every ' +
        'property as unreadable rather than saying so.'
    );
  }
  evidenceDeps = loaded;
  return evidenceDeps;
}

/**
 * REFUSES rather than defaulting. A caller reaching this without having loaded
 * is running a mode whose evidence is missing, and the one outcome that must
 * not be reached on a guess is an allow-list entry — so it must not silently
 * behave as though the evidence answered nothing.
 */
function requireEvidenceDeps() {
  if (evidenceDeps === undefined) {
    throw new Error(
      'the evidence helpers are not loaded — call `await loadEvidenceDeps()` before a mode ' +
        'that reads the SDK typings or the provider sources, or pass the helpers explicitly.'
    );
  }
  return evidenceDeps;
}

/**
 * Distinguishes "this fixture is not in HEAD" (nothing to compare — a brand-new
 * capture) from "reading it FAILED". Both used to be `undefined`, and the
 * second is a fact the report must state rather than skip.
 */
export const UNREADABLE = Symbol('unreadable');

/**
 * @typedef {import('./diagnose-schema-refresh.d.mts').NestedKeyDivergence} NestedKeyDivergence
 * @typedef {import('./diagnose-schema-refresh.d.mts').SdkLagRow} SdkLagRow
 * @typedef {import('./diagnose-schema-refresh.d.mts').DiagnosisInput} DiagnosisInput
 * @typedef {import('./diagnose-schema-refresh.d.mts').SdkEvidence} SdkEvidence
 * @typedef {import('./diagnose-schema-refresh.d.mts').RemovedEntry} RemovedEntry
 * @typedef {import('./diagnose-schema-refresh.d.mts').AddedEntry} AddedEntry
 */

/**
 * Every way `gen-nested-key-coverage.ts --check` announces a failure.
 *
 * Both spellings are load-bearing: `FAIL` prefixes its four blocking verdicts
 * (divergences, and the three stale-list refusals) and `failed` prefixes the
 * crash path. A run that says either of these and yields no parsed finding must
 * never render as clean. Fenced against the producer by
 * `tests/unit/scripts/diagnose-schema-refresh.test.ts`, which greps both
 * spellings out of `gen-nested-key-coverage.ts` — nothing else joins the two
 * files, and a reword there would otherwise make this pattern silently inert.
 */
export const NESTED_KEY_FAILURE_RE = /nested-key-coverage:\s*(FAIL|failed)\b/;
const FIXTURES_DIR = join(REPO_ROOT, 'tests/fixtures/cfn-schemas');
const PROVIDERS_DIR = join(REPO_ROOT, 'src/provisioning/providers');

/**
 * Compare one type's committed fixture against its refreshed self.
 *
 * Both sides are parsed as JSON rather than read out of a `git diff`, because a
 * removed line in a diff carries no indication of WHICH array it left — and
 * `properties`, `readOnlyProperties`, `createOnlyProperties` and
 * `primaryIdentifier` all hold bare strings. Parsing makes the answer exact.
 *
 * @param {string} committedJson
 * @param {string} refreshedJson
 * @returns {{removed: string[], added: string[], writableAdded: string[]}}
 */
export function comparePropertySets(committedJson, refreshedJson) {
  const before = JSON.parse(committedJson);
  const after = JSON.parse(refreshedJson);
  const beforeProps = Array.isArray(before.properties) ? before.properties : [];
  const afterProps = Array.isArray(after.properties) ? after.properties : [];
  const afterReadOnly = new Set(
    Array.isArray(after.readOnlyProperties) ? after.readOnlyProperties : []
  );
  const removed = beforeProps.filter((/** @type {string} */ p) => !afterProps.includes(p));
  const added = afterProps.filter((/** @type {string} */ p) => !beforeProps.includes(p));
  return {
    removed,
    added,
    // Read-only additions can never become a silent drop — the coverage
    // generator skips them — so they are separated out rather than reported as
    // work.
    writableAdded: added.filter((/** @type {string} */ p) => !afterReadOnly.has(p)),
  };
}

/**
 * Blocking divergences from `audit:nested-key-coverage:check`'s output.
 *
 * The checker's own lines are the source of truth and are quoted verbatim into
 * the report; only the type and the bucket are pulled out, for grouping. Lines
 * it does not recognise are ignored rather than guessed at.
 *
 * **A FAILING checker never renders as clean.** The finding-line format lives in
 * another file and nothing joins the two, so a wording change there would make
 * this parser return `[]` and the pull request would render "nothing needs a
 * decision" over a red check — the silent-empty class this whole job exists to
 * prevent, one level up. The checker also has three other FAIL modes (stale
 * allow-list / segmentRenames / terminalRenames) plus a crash path that
 * legitimately print no finding line, and refusing on THOSE discarded the whole
 * diagnosis — losing the removal and addition sections too — while blaming a
 * format change that had not happened. So a failure with no parsed finding is
 * reported as `unparsed`: the caller renders a section naming it rather than
 * either throwing the diagnosis away or claiming the refresh is clean.
 *
 * The EXIT CODE is the other half, and text alone was not enough: an empty log,
 * a `task not found`, and an OOM kill all carry no announcement, so all three
 * rendered "Nothing in this refresh needs a decision — additions only" over a
 * checker that never ran.
 *
 * @param {string} checkOutput
 * @param {number} [exitCode] the checker's own status; non-zero with nothing
 *   parsed is a failure however it worded itself
 * @returns {{divergences: NestedKeyDivergence[], unparsedFailure: boolean}}
 */
export function parseNestedKeyDivergences(checkOutput, exitCode = 0) {
  /** @type {NestedKeyDivergence[]} */
  const divergences = [];
  for (const raw of checkOutput.split('\n')) {
    const line = raw.trim();
    // Captured field by field rather than quoted whole: `nestedKey` comes from
    // the un-checksummable bundle by way of the fixtures, so the report must
    // render it through the same guard every other bundle-derived name takes.
    const m = /^(AWS::[A-Za-z0-9]+::[A-Za-z0-9]+):\s+(\S+)\s+\[([a-z-]+)\](?:\s+\((.*)\))?$/.exec(
      line
    );
    if (!m) continue;
    divergences.push({
      resourceType: m[1],
      nestedKey: m[2],
      bucket: m[3],
      detail: m[4] ?? '',
    });
  }
  // A SHORTFALL, not only zero — the same correction `parseDeclaredProperties`
  // needed one round earlier, in the sibling parser, for the same reason: with
  // the flag gated on `divergences.length === 0`, a producer change touching
  // SOME lines drops them silently and the report renders the survivors in a
  // confident tone. Measured on a five-finding log with three deviating rows:
  // two parsed, three dropped, no warning.
  //
  // The loose count is deliberately looser than the strict one — it asks "was
  // this line TRYING to be a finding", which is what makes a shortfall visible
  // at all. A line the loose pattern also misses is invisible to both, and that
  // residual is what `--nested-key-rc` covers from the other side.
  const looksLikeFinding = checkOutput
    .split('\n')
    .filter((raw) => /^AWS::\S+:/.test(raw.trim())).length;
  const unparsedFailure =
    divergences.length < looksLikeFinding ||
    (divergences.length === 0 && (exitCode !== 0 || NESTED_KEY_FAILURE_RE.test(checkOutput)));
  return { divergences, unparsedFailure };
}

/**
 * Map each registered resource type to the provider FILE that serves it.
 *
 * Parsed from `register-providers.ts`, which is the only place that binding
 * exists: a type is registered either with a fresh instance
 * (`registry.register('AWS::X::Y', new FooProvider())`) or with a shared local
 * (`const p = new FooProvider(); registry.register('AWS::X::Y', p)`), and both
 * resolve back to the class, which the file's own imports resolve to a path.
 *
 * Without this the diagnosis grepped every provider for the property NAME, and
 * for a common one the result was worse than useless — measured on real drift,
 * `Id` matched 50+ lines across 20 files, and the SDK client was then read off
 * whichever file sorted first, so `AWS::CodeCommit::Repository.Id` was reported
 * against `@aws-sdk/client-cloudfront`. A confident wrong answer is the one
 * outcome this report must not produce.
 *
 * @param {string} source `register-providers.ts` contents
 * @returns {Map<string, string>} resource type -> repo-relative provider path
 */
export function mapTypesToProviderFiles(source) {
  /** @type {Map<string, string>} */
  const classToPath = new Map();
  for (const m of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*'\.\/(providers\/[a-z0-9-]+)\.js'/g)) {
    for (const name of m[1].split(',').map((n) => n.trim()).filter(Boolean)) {
      classToPath.set(name, `src/provisioning/${m[2]}.ts`);
    }
  }
  /** @type {Map<string, string>} */
  const localToClass = new Map();
  for (const m of source.matchAll(/const\s+([A-Za-z0-9_]+)\s*=\s*new\s+([A-Za-z0-9_]+)\(/g)) {
    localToClass.set(m[1], m[2]);
  }
  /** @type {Map<string, string>} */
  const out = new Map();
  for (const m of source.matchAll(
    /registry\.register\(\s*'([A-Z][\w:]+)'\s*,\s*(?:new\s+([A-Za-z0-9_]+)\(|([A-Za-z0-9_]+))/g
  )) {
    const cls = m[2] ?? localToClass.get(m[3] ?? '');
    const path = cls ? classToPath.get(cls) : undefined;
    if (path) out.set(m[1], path);
  }
  return out;
}

/**
 * Lines in the provider file that mention a property name, scoped to the block
 * declaring THIS resource type.
 *
 * The scoping matters because a provider file routinely serves several types —
 * measured, 17 of 78 do, and `ec2-provider.ts` serves 15. Without it, asking
 * about `Tags` on `AWS::Glue::Connection` returns every `'Tags'` in
 * `glue-provider.ts`, including the declarations belonging to Glue::Job and
 * Glue::Table. Not a false claim (they are labelled candidates) but noise that
 * points the reader at the wrong lines.
 *
 * The block is delimited by the type's own literal and the next `'AWS::`
 * literal in the file, which is the shape `handledProperties` /
 * `unhandledByDesign` maps take. That is a heuristic, not a parse — so when the
 * type's literal is absent the whole file is searched rather than returning
 * nothing, and the caller says "candidates" either way.
 *
 * @param {string} property
 * @param {string | undefined} providerRelPath
 * @param {string} [resourceType]
 * @param {string} [repoRoot]
 * @returns {string[]} `file:line` strings
 */
export function findDeclarationCandidates(
  property,
  providerRelPath,
  resourceType,
  repoRoot = REPO_ROOT
) {
  if (!providerRelPath) return [];
  const abs = join(repoRoot, providerRelPath);
  if (!existsSync(abs)) return [];
  const lines = readFileSync(abs, 'utf8').split('\n');

  let from = 0;
  let to = lines.length;
  if (resourceType) {
    const start = lines.findIndex((l) => l.includes(`'${resourceType}'`));
    if (start !== -1) {
      from = start;
      const next = lines.findIndex(
        (l, i) => i > start && /'AWS::[A-Za-z0-9]+::[A-Za-z0-9]+'/.test(l)
      );
      to = next === -1 ? lines.length : next;
    }
  }

  /** @type {string[]} */
  const hits = [];
  for (let i = from; i < to; i++) {
    if (lines[i].includes(`'${property}'`) || lines[i].includes(`"${property}"`)) {
      hits.push(`${providerRelPath}:${i + 1}`);
    }
  }
  return hits;
}

/**
 * Whether any AWS SDK client this type's provider uses still models a member of
 * this name, case-insensitively.
 *
 * **Case-insensitive is load-bearing, not tidiness.** AWS SDK v3 wire models are
 * camelCase for several services: `@aws-sdk/client-api-gateway` spells
 * `restApiId` and carries no PascalCase spelling anywhere in `dist-types/models`,
 * so a case-sensitive scan reported `RestApiId` as "no longer modelled" — a
 * false claim whose lean is toward DELETING a live declaration, the one
 * direction this evidence must never push. The repo's own nested-key machinery
 * has a `case-divergence` bucket precisely because CFn and SDK capitalisation
 * routinely differ.
 *
 * **Every imported client is consulted, not the first.** 14 provider files
 * import two to four clients, and reading the first one is the "confident wrong
 * answer" defect this report already had once (a repo-wide name lookup
 * attributed CodeCommit evidence to `@aws-sdk/client-cloudfront`). Today each
 * file happens to list its primary client first, so a first-import rule is only
 * coincidentally right and an import reformat would flip it silently.
 * Consulting all of them biases toward "still modelled" — i.e. toward NOT
 * encouraging a deletion, which is the safe direction for this question.
 *
 * A property name carrying anything but letters and digits returns `undefined`
 * rather than a scrubbed needle: silently rewriting the thing being searched
 * for is how a lookup answers a question nobody asked.
 *
 * This is a NAME-PRESENCE scan, not the typed interface walk
 * `gen-nested-key-coverage.ts` performs — the right strength for "has AWS's
 * other description of this service dropped the name too?", and the wrong tool
 * for deciding anything, which is why the caller renders it as evidence.
 *
 * @param {string} property
 * @param {string | undefined} providerRelPath
 * @param {string} [repoRoot]
 * @returns {SdkEvidence | undefined}
 *   `undefined` when no client could be determined — the honest answer, not a guess
 */
export function sdkModelsMember(property, providerRelPath, repoRoot = REPO_ROOT) {
  if (!providerRelPath) return undefined;
  if (!/^[A-Za-z0-9]+$/.test(property)) return undefined;
  const abs = join(repoRoot, providerRelPath);
  if (!existsSync(abs)) return undefined;
  const clients = [
    ...new Set(
      [...readFileSync(abs, 'utf8').matchAll(/from '(@aws-sdk\/client-[a-z0-9-]+)'/g)].map(
        (m) => m[1]
      )
    ),
  ];
  if (clients.length === 0) return undefined;

  const needle = new RegExp(`\\b${property}\\b`, 'i');
  /** @type {Record<string, string | undefined>} */
  const versions = {};
  /** @type {string[]} */
  const consulted = [];
  for (const client of clients) {
    const modelsDir = join(repoRoot, 'node_modules', client, 'dist-types/models');
    if (!existsSync(modelsDir)) continue;
    consulted.push(client);
    let version;
    try {
      version = JSON.parse(
        readFileSync(join(repoRoot, 'node_modules', client, 'package.json'), 'utf8')
      ).version;
    } catch {
      version = undefined;
    }
    versions[client] = version;
    for (const file of readdirSync(modelsDir).filter((f) => f.endsWith('.d.ts'))) {
      if (needle.test(readFileSync(join(modelsDir, file), 'utf8'))) {
        return { client, modelled: true, version, consulted };
      }
    }
  }
  if (consulted.length === 0) return undefined;
  // The version reported belongs to the client reported. Falling back to a
  // "first version seen" would pair one client's name with another's number —
  // the same misattribution class as the cross-service lookup this function was
  // rewritten to close.
  return { client: consulted[0], modelled: false, version: versions[consulted[0]], consulted };
}

/**
 * The imported clients that plausibly serve a resource type, best-effort.
 *
 * A provider imports more than the service it provisions — `@aws-sdk/client-sts`
 * is in most of them — and reporting an unrelated client's version lag beside a
 * Glue key divergence is a confident answer to a question nobody asked. The
 * type's own service segment, case-folded and stripped of separators, is
 * matched against the client's suffix.
 *
 * Falls back to EVERY row rather than to none when nothing matches: the caller
 * renders an absent type as "UNKNOWN, not ruled out", and a silently empty
 * answer would read as ruled out. The narrowing is a noise reduction, not a
 * correctness claim — which is why `matched` is REPORTED rather than left for a
 * caller to re-derive. A caller that re-derived it read the suffix test as
 * proof and told the reader to discount a live, applicable lag on the 13
 * registered types whose client is not named after their service segment
 * (`AWS::Events::Rule` is served by `@aws-sdk/client-eventbridge`,
 * `AWS::Logs::LogGroup` by `@aws-sdk/client-cloudwatch-logs`). `false` here
 * means "this narrowing found nothing to go on", never "wrong client".
 *
 * @param {string} resourceType
 * @param {Array<{client: string, version: string}>} rows
 * @returns {Array<{client: string, version: string, matched: boolean}>}
 */
export function clientsForType(resourceType, rows) {
  const service = (resourceType.split('::')[1] ?? '').toLowerCase();
  const matched = service
    ? rows.filter((r) => r.client.replace('@aws-sdk/client-', '').replace(/-/g, '') === service)
    : [];
  if (matched.length > 0) return matched.map((r) => ({ ...r, matched: true }));
  // A provider importing exactly ONE client leaves nothing for the name test to
  // disambiguate — that client IS the type's own, whatever it is called. This
  // arm is what keeps the hedge off the services whose client is named
  // differently: of the 134 registered types, 2 reach no client at all and of
  // the remaining 132 the name test matches 119, this arm settles 10 more
  // (`AWS::Events::Rule` / `@aws-sdk/client-eventbridge` among them, all 10
  // verified to be the service's own), and 3 are genuinely ambiguous — a
  // provider importing several clients, none named for the service.
  //
  // `service` empty means the type name did not parse, and one row must NOT be
  // asserted to match it: unreachable from a divergence line today, but the
  // arm would be claiming a match it never tested.
  return rows.map((r) => ({ ...r, matched: service !== '' && rows.length === 1 }));
}

/**
 * Every AWS SDK client a provider imports, with its installed version.
 *
 * Split out of {@link sdkModelsMember} because the version-lag question has no
 * member to look up: the caller wants "which clients could this type's provider
 * be lagging on", and asking `sdkModelsMember` with a name that matches nothing
 * answered with `consulted[0]` — the FIRST import, which is right only by
 * coincidence on a provider importing several (17 of 78 serve more than one
 * type, and `ec2-provider.ts` imports several clients).
 *
 * @param {string | undefined} providerRelPath
 * @param {string} [repoRoot]
 * @returns {Array<{client: string, version: string}>}
 */
export function sdkClientVersions(providerRelPath, repoRoot = REPO_ROOT) {
  if (!providerRelPath) return [];
  const abs = join(repoRoot, providerRelPath);
  if (!existsSync(abs)) return [];
  /** @type {Array<{client: string, version: string}>} */
  const out = [];
  const clients = [
    ...new Set(
      [...readFileSync(abs, 'utf8').matchAll(/from '(@aws-sdk\/client-[a-z0-9-]+)'/g)].map(
        (m) => m[1]
      )
    ),
  ];
  for (const client of clients) {
    if (!existsSync(join(repoRoot, 'node_modules', client, 'dist-types/models'))) continue;
    try {
      const version = JSON.parse(
        readFileSync(join(repoRoot, 'node_modules', client, 'package.json'), 'utf8')
      ).version;
      if (typeof version === 'string' && version) out.push({ client, version });
    } catch {
      // An unreadable manifest is not a lag finding.
    }
  }
  return out;
}

/**
 * Whether the installed SDK client is behind what npm publishes.
 *
 * This settles ONE branch of the divergence decision outright: if the installed
 * client is already the latest, "the SDK merely lags the service" is eliminated
 * and the remaining reading is that the service genuinely lacks the member.
 * When it IS behind, the honest answer is "bump and re-check" — NOT "bumping
 * would fix it", which cannot be answered by a name lookup. Measured while
 * building this: the four live `AWS::Glue::Connection` divergences carry names
 * that ARE present in both the installed and the latest client, because the
 * checker's finding is about a specific INTERFACE's members, not about the name
 * existing somewhere. A grep-level "the newer SDK has it" would have
 * contradicted the checker and been wrong.
 *
 * Network-dependent by nature, so every failure degrades to `undefined` and the
 * caller simply says nothing — a diagnosis must never fail the job it describes.
 *
 * @param {string} client
 * @param {string | undefined} installed
 * @param {(pkg: string) => string} [viewLatest] injectable for tests
 * @returns {{installed: string, latest: string, behind: boolean} | undefined}
 */
export function sdkVersionLag(client, installed, viewLatest = defaultViewLatest) {
  if (!installed) return undefined;
  let latest;
  try {
    latest = viewLatest(client).trim();
  } catch {
    return undefined;
  }
  if (!/^\d+\.\d+\.\d+[\w.+-]*$/.test(latest)) return undefined;
  return { installed, latest, behind: latest !== installed };
}

/** @param {string} pkg @returns {string} */
function defaultViewLatest(pkg) {
  return execFileSync('npm', ['view', pkg, 'version'], {
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * Each type's DECLARED property set, read from the generated coverage module.
 *
 * `gen-property-coverage.ts` writes `handled` VERBATIM from the provider's
 * declaration and does not intersect it with the fixture, so a property AWS has
 * just removed is still listed — which is exactly the "this declaration is now
 * bogus" condition the caller filters on.
 *
 * **Returns an empty map only for empty input, and throws on a parse that finds
 * nothing in a non-empty module.** A silent empty here would filter EVERY
 * removal away and render "nothing needs a decision" over a PR that does — the
 * failure direction this whole job exists to prevent, one level up. It was live
 * for one revision: the module writes `new Set<string>([`, the pattern expected
 * `new Set([`, and the report came back clean against real drift carrying a
 * known-bogus declaration.
 *
 * @param {string} generatedSource
 * @returns {Map<string, Set<string>>}
 */
export function parseDeclaredProperties(generatedSource) {
  /** @type {Map<string, Set<string>>} */
  const declared = new Map();
  if (generatedSource.trim() === '') return declared;

  // Entries are located FIRST, then `handled:` is matched inside each one.
  // A single pattern spanning both cannot work: a type whose set is empty is
  // written `new Set<string>()` with no `[`, so a lazy `[\s\S]*?` skips past it
  // and credits the NEXT type's properties. Measured against the real module:
  // 134 entries, 131 parsed, three swallowed and two mis-credited — including
  // `AWS::CloudFormation::WaitConditionHandle` inheriting CloudFront's. The
  // consequence is the silent-empty class at PER-TYPE granularity: a removal on
  // a swallowed type renders "nothing needs a decision" over a red check, and
  // the whole-map refusal below cannot see it.
  const boundaries = [...generatedSource.matchAll(/\[\s*'([A-Z][\w:]+)'\s*,\s*\{/g)];
  let recognised = 0;
  for (let i = 0; i < boundaries.length; i++) {
    const slice = generatedSource.slice(
      boundaries[i].index,
      i + 1 < boundaries.length ? boundaries[i + 1].index : undefined
    );
    const handled = /handled:\s*new Set(?:<[^>]*>)?\(\s*\[([\s\S]*?)\]\s*\)/.exec(slice);
    const empty = /handled:\s*new Set(?:<[^>]*>)?\(\s*\)/.test(slice);
    if (handled || empty) recognised++;
    declared.set(
      boundaries[i][1],
      new Set(handled ? [...handled[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [])
    );
  }

  // Refuses on a SHORTFALL of RECOGNISED entries, which is not the same as a
  // shortfall of MAP KEYS: `declared.set` runs once per boundary, so comparing
  // `declared.size` against `boundaries.length` could only ever fire on a
  // duplicate type name. Measured — renaming the `handled` member emptied all
  // 134 sets with no refusal, filtering every removal away and rendering
  // "nothing needs a decision" over a red check. Both shapes count: a populated
  // `new Set([...])` and the empty `new Set<string>()` a type with nothing
  // declared is written as.
  if (recognised !== boundaries.length) {
    throw new Error(
      `property-coverage.generated.ts: recognised the declaration shape in ${recognised} of ` +
        `${boundaries.length} type entries — the shape changed. Refusing to report from a ` +
        'partial parse.'
    );
  }
  if (declared.size === 0) {
    throw new Error(
      'property-coverage.generated.ts parsed to zero types — the shape changed. ' +
        'Refusing to report "nothing needs a decision" from a parse that found nothing.'
    );
  }
  return declared;
}

/**
 * What to do about each CI check a schema refresh can turn red.
 *
 * Keyed by the name the workflow's `run_check` reports, so the two sides name
 * the same thing — the `vp run` task for the audits, a bare `property-coverage`
 * for the vitest filter.
 *
 * Every entry READS `tests/fixtures/cfn-schemas/` and hard-fails CI, and every
 * one of them is reddened by a pure schema ADDITION — the shape a reader is
 * most likely to wave through, which is what makes the silence expensive.
 *
 * A check absent from this table still gets a section — naming it and saying
 * there is no guidance beats the silence that shipped for six rounds.
 *
 * @type {Record<string, string[]>}
 */
export const CHECK_GUIDANCE = {
  'property-coverage': [
    'Most often AWS RE-ADDED a property a provider had written off with a',
    '`bogusTolerated` rationale in `tests/fixtures/cfn-schemas/_todo-backfill.json`.',
    'The rationale said the schema no longer lists it; it does again, so the',
    'rationale is now wrong and retiring it is a judgement.',
    '',
    '```bash',
    'vp test run property-coverage',
    '```',
    '',
    'Delete the stale entry and account for the property normally —',
    '`handledProperties` if the provider wires it, `unhandledByDesign` with a',
    'reason if it does not.',
  ],
  'audit:sdk-attr-coverage:check': [
    'A new READ-ONLY `*Arn` or `*Url` attribute on a type that had none. A',
    'cross-resource `Fn::GetAtt` reads the cached attribute, so an uncached one',
    'hard-fails the resolver rather than falling back.',
    '',
    '```bash',
    'vp run audit:sdk-attr-coverage:check',
    '```',
    '',
    'Cache the attribute in the provider under its CFn name, or — if the type',
    'is Cloud-Control-routed — check whether its `primaryIdentifier` already',
    'covers it.',
  ],
  'fixture-consumer-tests': [
    'A unit test that reads the schema fixtures directly and asserts something',
    'about their contents. Most assert that a type has NO silently dropped',
    'property — zero headroom, so one writable property AWS adds to that type',
    'reds CI while the coverage check absorbs the same addition. The rest assert',
    'a specific rule or subfield list still matches the capture.',
    '',
    '```bash',
    'vp test run \\',
    '  mutually-exclusive-properties \\',
    '  ecs-deployment-configuration-subfield \\',
    '  apigatewayv2-integration-props \\',
    '  apigatewayv2-stage-route-props \\',
    '  appsync-graphqlapi-config-props \\',
    '  appsync-resolver-datasource-props \\',
    '  ecs-service-config-props',
    '```',
    '',
    'Read what it names and decide whether the rule or the assertion is what AWS',
    'just invalidated. That command is the workflow\'s own filter list, fenced',
    'equal to it line by line — a narrower one comes back GREEN over a real red,',
    'which is how this row was wrong for a round, twice.',
  ],
  'audit:enrichment-coverage:check': [
    'A new computed attribute on a pure Cloud-Control type that',
    '`enrichResourceAttributes` does not populate — the silent-drop class on the',
    'READ side.',
    '',
    '```bash',
    'vp run audit:enrichment-coverage:check',
    '```',
    '',
    'Add the attribute to that type\'s `case` in',
    '`src/provisioning/cloud-control-provider.ts`, or allow-list it with a',
    'rationale if AWS does not return it.',
  ],
};


/**
 * How many things in this refresh need a human decision.
 *
 * This is the SAME predicate the report's "additions only" line is written
 * from — `renderDiagnosis` calls it rather than restating the condition — so
 * the count a PR is marked with and the prose inside that PR cannot disagree.
 * The pair had to be one function rather than two agreeing ones: the condition
 * has five terms and two of them (`nestedKeyUnparsed`, `unreadable`) are the
 * ones a second copy forgets, since neither renders a `### … a decision is
 * needed` heading of its own — an unparsed checker log and an unreadable
 * fixture are decisions with no section to remind a reader they exist.
 *
 * The unit is ITEMS OF WORK, not properties: `removed` is per-TYPE, so a type
 * losing three properties counts once, because it is settled by one judgement.
 *
 * Both checker verdicts are part of the condition, not just the sections below
 * it: a checker that failed is the one state where "additions only" is a
 * confident WRONG answer rather than a gap. `propertyCoverageFailed` was the
 * sibling left out — its status was discarded by the workflow, so a red
 * `property-coverage` rendered as clean, on the ordinary refresh shape.
 *
 * @param {Pick<DiagnosisInput, 'removed' | 'divergences'> &
 *   Partial<Pick<DiagnosisInput, 'nestedKeyUnparsed' | 'failedChecks' | 'unreadable'>>} input
 * @returns {number}
 */
export function countDecisions({
  removed,
  divergences,
  nestedKeyUnparsed = false,
  failedChecks = [],
  unreadable = [],
  pendingSdkBump = [],
}) {
  return (
    removed.length +
    divergences.length +
    // Counted per BUMP, not per divergence: `partitionPendingSdkBump` moves a
    // finding here only once the published client is known to declare the
    // member, so what is left to do is merge one dependency bump however many
    // findings ride on it. Several findings CAN share one client — go-to-k/cdkd#2784
    // carried four on `@aws-sdk/client-glue` — and how often that happens is
    // not measured here, so do not write a frequency word into this comment.
    pendingBumpGroups(pendingSdkBump).length +
    (nestedKeyUnparsed ? 1 : 0) +
    failedChecks.length +
    unreadable.length
  );
}

/**
 * Apply {@link classifyRemovedProperty} to every removed-but-declared property,
 * writing the settled ones into `_todo-backfill.json`'s `bogusTolerated` block
 * and returning what happened for the report to render.
 *
 * The file is rewritten in place with `JSON.stringify(…, null, 2)`, which is the
 * shape the generator already writes, so a cycle that settles nothing produces a
 * byte-identical file and no commit noise.
 *
 * Existing entries are NEVER overwritten. A rationale already there was written
 * by a human about the same property, and the automatic one would replace a
 * considered sentence with a template — the fold that the umbrella campaign's
 * own history is a warning about.
 *
 * @param {import('./diagnose-schema-refresh.d.mts').RemovedEntry[]} removed
 * @param {Map<string, string>} providerFiles
 * @param {string} [repoRoot]
 * @returns {{ written: Array<{ resourceType: string, property: string, rationale: string }>,
 *   escalated: Array<{ resourceType: string, property: string, reason: string }> }}
 * @param {unknown} [deps] The evidence helpers. Defaults to the loaded ones and
 *   REFUSES when nothing loaded them; tests inject doubles here instead.
 */
export function writeAutoTolerated(
  removed,
  providerFiles,
  repoRoot = REPO_ROOT,
  // Resolved at CALL time, not at module load: see `loadEvidenceDeps`. Tests
  // that inject doubles never reach the loader; the CLI loads before `main()`.
  deps = requireEvidenceDeps()
) {
  const written = [];
  const escalated = [];
  /** The type's properties as the refreshed fixture now lists them. */
  const currentSchemaProperties = (resourceType) => {
    const file = join(
      repoRoot,
      'tests/fixtures/cfn-schemas',
      `${resourceType.replace(/::/g, '-')}.json`
    );
    if (!existsSync(file)) return [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      return Array.isArray(parsed.properties) ? parsed.properties : [];
    } catch {
      return [];
    }
  };
  const path = join(repoRoot, 'tests/fixtures/cfn-schemas/_todo-backfill.json');
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  doc.bogusTolerated ??= {};

  for (const entry of removed) {
    for (const property of entry.properties) {
      const already = doc.bogusTolerated[entry.resourceType]?.[property];
      if (already !== undefined) continue;
      // A broken provider or a malformed fixture must not take down the refresh
      // it is describing — the same rule `sdkVersionLag` states for itself. An
      // unclassifiable property escalates, which is where it would have gone.
      let verdict;
      try {
        // Resolved INSIDE the try. Hoisted out of it, this `readFileSync` on the
        // provider path threw uncaught for an unreadable provider — aborting the
        // refresh AFTER the fixtures had already been rewritten, which is the
        // one outcome the catch exists to prevent.
        const client = clientsForType(
          entry.resourceType,
          sdkClientVersions(providerFiles.get(entry.resourceType), repoRoot)
        ).find((r) => r.matched)?.client;
        verdict = classifyRemovedProperty({
          property,
          client,
          providerRelPath: providerFiles.get(entry.resourceType),
          renameCandidates: entry.renameCandidates?.[property] ?? [],
          // The cross-cycle half: names the type's CURRENT schema already
          // carries that pair with this one. A rename split across two days
          // leaves no addition in this delta at all.
          schemaRenameCandidates: pairRenames(
            property,
            currentSchemaProperties(entry.resourceType)
          ),
          typedMember: deps.typedSdkMember,
          wires: deps.providerWiresProperty,
          repoRoot,
        });
      } catch (err) {
        verdict = {
          auto: false,
          reason: `the evidence could not be read (${
            err instanceof Error ? err.message : String(err)
          }), so nothing is concluded about this property`,
        };
      }
      if (!verdict.auto) {
        escalated.push({ resourceType: entry.resourceType, property, reason: verdict.reason });
        continue;
      }
      doc.bogusTolerated[entry.resourceType] ??= {};
      doc.bogusTolerated[entry.resourceType][property] = verdict.rationale;
      written.push({ resourceType: entry.resourceType, property, rationale: verdict.rationale });
    }
  }

  if (written.length > 0) writeFileSync(path, `${JSON.stringify(doc, null, 2)}\n`);
  return { written, escalated };
}

/**
 * Whether the refresh job may settle a removed-but-declared property itself, or
 * must hand it to a human.
 *
 * The default is the HUMAN, and every clause below only narrows what escapes
 * that. This file's own reasoning at `renderDiagnosis` is why: the silencing
 * option is always available and always turns CI green, so a rule choosing
 * automatically under uncertainty converges on it and disables the check that
 * caught the problem. What makes an automatic answer defensible here is that it
 * is not a judgement under uncertainty at all — it is two structural facts, both
 * read from the checkout:
 *
 * - the type's OWN service client declares a member of that name, so the SDK
 *   call cdkd makes still carries the field; and
 * - the provider actually reads it off the template or writes it onto a request,
 *   so deleting the declaration would make the coverage checker under-report a
 *   property cdkd genuinely sends.
 *
 * When both hold, "keep sending it" is the only answer either fact permits, and
 * the human was being asked to restate them. When either fails the remedy is a
 * behaviour change — deleting provider wiring — and that stays a human's.
 *
 * **A rename candidate escapes the rule entirely, however strong the evidence.**
 * A rename appears as a removal plus an addition on the same type, and the SDK
 * keeps the OLD name for backward compatibility — so both facts above hold for
 * a property whose correct fix is repointing the declaration at the new name.
 * Tolerating it would mark the PR "no decision needed" and bury the new name in
 * the backfill list. `AWS::AutoScaling::AutoScalingGroup.DefaultCooldown` is the
 * live example: its type's schema already carries `Cooldown`, and a hand-written
 * note on the tolerance file says CFn spells the same field that way. The
 * pairing is found against the CURRENT schema as well as this delta, because
 * that rename landed across two cycles and `pairRenames` alone sees only one.
 *
 * @param {object} input
 * @param {string} input.property
 * @param {string | undefined} input.client the type's own SDK client package
 * @param {string | undefined} input.providerRelPath
 * @param {readonly string[]} input.renameCandidates additions on the same type
 *   whose spelling extends or is extended by this name
 * @param {readonly string[]} [input.schemaRenameCandidates] names ALREADY in the
 *   type's current schema that pair with this one — the cross-cycle half, which
 *   `renameCandidates` alone cannot see
 * @param {typeof import('./offline-property-evidence.ts').typedSdkMember} input.typedMember
 * @param {typeof import('./offline-property-evidence.ts').providerWiresProperty} input.wires
 * @param {string} [input.repoRoot]
 * @returns {{ auto: false, reason: string } | { auto: true, rationale: string }}
 */
export function classifyRemovedProperty({
  property,
  client,
  providerRelPath,
  renameCandidates,
  schemaRenameCandidates = [],
  typedMember,
  wires,
  repoRoot,
}) {
  // Rename candidates from THIS delta and from the type's CURRENT schema, and
  // the second source is not belt-and-braces. `pairRenames` sees only what the
  // same refresh added, so a rename split across two cycles escapes it — and
  // the commit that first shipped this rule cited an example that is exactly
  // that shape: `AWS::AutoScaling::AutoScalingGroup` already carries `Cooldown`
  // in the committed fixture while `DefaultCooldown` is the removal, so the
  // addition landed on an earlier day. At a daily cadence a split rename is the
  // NORMAL case, not the corner one, and `property-coverage`'s staleness check
  // cannot clear it later: that fires when AWS re-adds the SAME name.
  const allCandidates = [...new Set([...renameCandidates, ...schemaRenameCandidates])];
  if (allCandidates.length > 0) {
    return {
      auto: false,
      reason:
        `${allCandidates.map(renderName).join(', ')} on the same type ${
          allCandidates.length === 1 ? 'extends or is extended by' : 'extend or are extended by'
        } this name, so this may be a RENAME — and the SDK keeps the old name either way, which ` +
        'is exactly why the evidence cannot settle it',
    };
  }
  if (client === undefined) {
    return {
      auto: false,
      reason: "could not determine this type's own SDK client, so there is nothing to ask",
    };
  }
  const typed = typedMember(property, client, repoRoot);
  if (typed === undefined) {
    return {
      auto: false,
      reason:
        `\`${client}\` declares no member of this name, so the SDK call cdkd makes no longer ` +
        'carries the field — retiring the declaration is a behaviour change and stays yours',
    };
  }
  const wired = wires(property, providerRelPath, repoRoot);
  if (wired === undefined) {
    return {
      auto: false,
      reason:
        'no `properties[...]` read of this name was found, which means the evidence COULD NOT ' +
        'DETERMINE whether the provider sends it — not that it does not. Table-driven wiring ' +
        '(a shorthand key in a lookup map, indexed by a loop variable) is invisible to this ' +
        'check, and `AWS::SQS::Queue` delivers `DelaySeconds` exactly that way. Look before ' +
        'deleting anything',
    };
  }
  const where = typed.interfaces.slice(0, 3).join(', ');
  // The EARLIEST site by line, not `sites[0]`: they are `path:line` strings, so
  // a plain sort puts `:1123` before `:987` and the rationale quotes an
  // arbitrary one.
  const site = [...wired.sites].sort(
    (a, b) => Number(a.split(':').pop()) - Number(b.split(':').pop())
  )[0];
  return {
    auto: true,
    rationale:
      `AWS removed this from the CFn schema, but \`${client}\` still declares it as a member ` +
      `of ${where}${typed.spelling === 'lowerFirst' ? ' (under its lower-initial spelling, which several services use)' : ''}, ` +
      `and the provider wires it at ${site}. cdkd calls the SDK directly, so the value still ` +
      `reaches AWS; deleting the declaration would only make the coverage checker under-report ` +
      `a property cdkd sends. Written automatically by the schema refresh job.`,
  };
}

/**
 * Render the Markdown appended to the pull-request body.
 *
 * It NAMES what fired, where, and what the SDK says about it — then stops.
 *
 * The stopping point is narrower than it first looks, and the earlier framing
 * of it here was wrong: "the tiebreaker is in neither model" ignored that AWS
 * publishes a THIRD description, the SDK, which this repo already reads. So the
 * research IS largely mechanical and is now done above; what is left to a human
 * is confirmation plus the cases the evidence cannot separate — a rename looks
 * exactly like a removal at the name level (hence this repo's hand-maintained
 * rename maps), and `no-sdk-member` cannot tell "unsupported" from "the
 * installed SDK lags the service".
 *
 * The reason to stop there is the asymmetry rather than the ambiguity: the
 * silencing option (`bogusTolerated`, `NESTED_KEY_ALLOW_LIST`) is always
 * available and always turns CI green, so anything choosing automatically under
 * UNCERTAINTY converges on it — disabling the very check that caught the
 * problem, silently.
 *
 * That argument is about uncertainty, and it is why the job now settles exactly
 * the cases that have none. {@link classifyRemovedProperty} writes a
 * `bogusTolerated` entry only when two structural facts hold together — the
 * type's own SDK client declares a member of the name, and the provider wires
 * the property rather than merely listing it — and refuses outright when the
 * same refresh added a name that could be a rename, where both facts hold and
 * still settle nothing. Where a judgement remains, the evidence shortens the
 * human's work and does not change who accepts the risk.
 *
 * The input shape lives in the sibling `.d.mts` and is named here rather than
 * restated field by field: the per-field `@param` list was a second copy, and
 * it went stale twice — silently, since nothing in CI type-checks `scripts/**`.
 *
 * @param {DiagnosisInput} input
 * @returns {string}
 */
export function renderDiagnosis(input) {
  const {
    removed,
    writableAdded,
    readOnlyAddedCount = 0,
    divergences,
    nestedKeyUnparsed = false,
    failedChecks = [],
    unreadable = [],
    autoTolerated = [],
    autoEscalated = [],
    pendingSdkBump = [],
    unresolvedSdkLag = [],
    skipped,
    sdkLag,
  } = input;
  const lines = ['## What changed, and what needs a decision', ''];

  const decisionTotal = countDecisions({
    removed,
    divergences,
    nestedKeyUnparsed,
    failedChecks,
    unreadable,
    pendingSdkBump,
  });
  if (decisionTotal === 0) {
    lines.push('Nothing in this refresh needs a decision — additions only.', '');
  } else {
    lines.push(
      `**${decisionTotal} ${decisionTotal === 1 ? 'decision needs' : 'decisions need'} your ` +
        `call**, labelled **D1**\u2013**D${decisionTotal}** below. They are spread across ` +
        'sections because they arrive from different checks; the labels run straight through ' +
        'so the count in the title can be reached from the body.',
      ''
    );
  }

  // One running label per decision, ACROSS sections. Per-section numbering
  // restarts and cannot be counted up to the total in the title, which is the
  // only number a reader sees first — the PR that motivated this said
  // "5 decisions needed" over four divergences and one failed check in two
  // differently-shaped sections, and nothing in the body let a reader reach 5.
  //
  // Incremented at exactly the sites `countDecisions` counts, and the suite
  // pins the last label against that total: a section that stops labelling, or
  // one that labels something the count does not include, is a body that
  // disagrees with its own title.
  let decisionSeq = 0;
  const D = () => `**D${++decisionSeq}.** `;

  if (autoTolerated.length > 0) {
    lines.push(
      `### Properties AWS removed that the job SETTLED itself (${autoTolerated.length}) — no decision needed`,
      '',
      'Each was removed from the CFn schema while the provider still declared it, and two',
      'structural facts settled it without a judgement: the type\'s own SDK client still',
      'declares a member of that name, and the provider actually wires the property rather',
      'than only listing it. cdkd calls the SDK directly, so the value still reaches AWS.',
      '',
      'They are listed here rather than folded into the diff silently — an automatic write',
      'to a tolerance file is the thing most worth auditing, and it is reversible: delete the',
      'entry and the next cycle reports the property as needing a decision again.',
      ''
    );
    for (const w of autoTolerated) {
      lines.push(`- ${renderName(w.resourceType)}: ${renderName(w.property)}`);
      lines.push(`  - ${renderDetail(w.rationale)}`);
    }
    lines.push('');
  }

  if (autoEscalated.length > 0) {
    lines.push(
      `### Why the job did NOT settle these (${autoEscalated.length})`,
      '',
      'The evidence is stated so you can disagree with it. Each line says which of',
      'the three tests failed, and none of them concludes anything about the',
      'property — "no wiring found" in particular means the check could not see it,',
      'not that the provider does not send it.',
      ''
    );
    for (const e of autoEscalated) {
      lines.push(`- ${renderName(e.resourceType)}: ${renderName(e.property)}`);
      lines.push(`  - ${renderDetail(e.reason)}`);
    }
    lines.push('');
  }

  if (removed.length > 0) {
    lines.push(
      `### Properties AWS removed (${removed.length}) — a decision is needed`,
      '',
      'Each was in the previous snapshot, is not in this one, AND is declared by',
      'the provider — so the declaration is now bogus. Removals nothing declares',
      'are not listed: they change nothing.',
      ''
    );
    for (const entry of removed) {
      // One decision per TYPE, which is the unit `countDecisions` uses: a type
      // losing three properties is settled by one judgement.
      lines.push(`- ${D()}${renderName(entry.resourceType)}`);
      for (const property of entry.properties) {
        const candidates = entry.candidates[property] ?? [];
        const where =
          candidates.length > 0
            ? `declared near ${candidates.map((c) => `\`${c}\``).join(', ')}`
            : entry.providerPath
              ? `not found in \`${entry.providerPath}\` — the declaration may sit outside ` +
                'the block scanned for this type'
              : 'the provider serving this type could not be determined';
        lines.push(`  - ${renderName(property)} — ${where}`);

        // A RENAME shows up as a removal and an addition on the SAME type in
        // the SAME refresh, and both sides are in hand — so say so rather than
        // leaving the reader to spot it. This is the single most decisive
        // signal in the report when it fires.
        //
        // Re-checked against `writableAdded` HERE rather than trusted from the
        // caller: a declaration cannot be pointed at a READ-ONLY property, so a
        // rename claim naming one is advice that cannot be followed. The caller
        // already filters, and that filter had no pin — swapping its argument
        // for the unfiltered `added` list left every case green. Checking it
        // where both sides are in hand closes the class whatever the caller
        // passes.
        const settableHere = new Set(
          writableAdded.find((w) => w.resourceType === entry.resourceType)?.properties ?? []
        );
        const renames = (entry.renameCandidates?.[property] ?? []).filter((r) =>
          settableHere.has(r)
        );
        if (renames.length > 0) {
          lines.push(
            `    - **Possibly a RENAME**: this refresh also ADDED ` +
              `${renames.map(renderName).join(', ')} to the same type. That is a ` +
              'name-similarity guess, not a finding. The job refuses to settle ' +
              'anything on this type while it stands, and repointing the ' +
              'declaration is a decision only you can make.'
          );
        }

        const sdk = entry.sdk?.[property];
        if (sdk === undefined) {
          lines.push('    - SDK evidence: none — could not determine the client to consult');
        } else if (sdk.modelled) {
          lines.push(
            `    - SDK evidence: \`${sdk.client}\`${
              sdk.version ? ` (${renderKey(sdk.version)})` : ''
            } **still models this name** (case-insensitively), so the API likely ` +
              'still accepts it — leans toward keeping it (`bogusTolerated`)'
          );
        } else {
          lines.push(
            `    - SDK evidence: \`${sdk.client}\`${
              sdk.version ? ` (${renderKey(sdk.version)})` : ''
            } **no longer models this name**, searched case-insensitively across ` +
              `${(sdk.consulted ?? [sdk.client]).length} client(s) — both of AWS's ` +
              'descriptions have dropped it, which leans toward retiring the ' +
              'declaration. A rename would look identical here.'
          );
        }
      }
    }
    lines.push('', ...removedProcedure(removed), '');
  }

  if (pendingSdkBump.length > 0) {
    const groups = pendingBumpGroups(pendingSdkBump);
    lines.push(
      `### SDK bumps that resolve nested-key divergences (${groups.length}) — a decision is needed`,
      '',
      'The nested-key check asks whether a specific SDK INTERFACE declares a',
      'member. For each divergence below the answer is NO in the client installed',
      'here and YES in the one npm publishes today, so the finding is a lockfile',
      'lag rather than a field the service dropped.',
      '',
      '**An action rather than a judgement — but still counted, and still worth',
      'doing promptly.** Until the bump lands the installed client has no member',
      'to carry the value, so the template key does not reach AWS: the live',
      'silent-drop class this job watches. What the job removes is the',
      'INVESTIGATION, not the action, so each bump below is counted once however',
      'many divergences ride on it.',
      ''
    );
    for (const group of groups) {
      const rows = pendingSdkBump.filter(
        (p) => p.client === group.client && p.latest === group.latest
      );
      // Same split as `divergenceProcedure`'s lag lines, and for the same
      // reason: `client` and `latest` are shape-fenced upstream, a version read
      // out of a dependency's own `package.json` is not — `installed` is taken
      // on nothing but `typeof === 'string'` and `sdkModelsMember`'s
      // `sdk.version` on nothing at all — so every one of them goes through
      // `renderKey`. There are FIVE such emission sites, not two: this heading,
      // `divergenceProcedure`'s two lag lines, and the removed-property
      // evidence's two arms. Guarding a subset is a guard that looks present
      // and is not, which is how the first cut of this shipped.
      //
      // `renderKey` is the guard for BUNDLE-derived names and it rejects a
      // scoped package outright (`@` and `/`), which is why the client name is
      // not routed through it while the interface and member names below are.
      // It also rejects `+`, which matters only for the values it is applied to
      // — `installed` here and `sdk.version` in the removed-property evidence.
      // Those never reach `published-sdk-typings.ts`'s version guard, so a `+`
      // arrives here unfiltered and renders as rejected. `group.latest` is the
      // opposite case and is emitted bare for that reason: a group exists only
      // because `publishedModelsDir` accepted that exact string, so it has
      // already passed a shape test — including the `+` this one would refuse.
      // Inert either way today; no AWS SDK release carries build metadata.
      lines.push(
        `#### ${D()}Bump \`${group.client}\` from ${renderKey(group.installed)} to \`${group.latest}\``,
        '',
        `Resolves ${rows.length} ${rows.length === 1 ? 'divergence' : 'divergences'}:`,
        ''
      );
      for (const r of rows) {
        lines.push(
          `- ${renderName(r.resourceType)}: ${renderKey(r.nestedKey)} — ` +
            `${renderKey(r.definition)} declares ${renderKey(r.member)} at \`${group.latest}\``
        );
      }
      lines.push('');
    }
    lines.push(
      '<details><summary>How this was determined</summary>',
      '',
      "The job downloads the published tarball's `dist-types/models` and rebuilds",
      'the same `interface -> members` index the checker itself uses, then re-asks',
      "the checker's own question at the published version.",
      '',
      '**It is not a name search, and that distinction is the mechanism.** The',
      'four `AWS::Glue::Connection` names that motivated this are present in BOTH',
      'the installed and the published client — the finding is about one',
      "INTERFACE's members — so a grep-level \"the newer SDK has it\" would have",
      'contradicted the checker and been wrong.',
      '',
      'Nothing is installed, `--ignore-scripts` is passed, and no fetched file is',
      'executed or imported. A fetch that fails leaves the divergence in the',
      'section below, unsettled.',
      '',
      '</details>',
      ''
    );
  }

  if (divergences.length > 0) {
    lines.push(
      `### Nested-key divergences (${divergences.length}) — a decision is needed`,
      '',
      'Reported by the nested-key check, which reports divergences rather than',
      'staleness, so regenerating will not clear these.',
      ''
    );
    for (const d of divergences) {
      const detail = d.detail ? ` — ${renderDetail(d.detail)}` : '';
      lines.push(
        `- ${D()}${renderName(d.resourceType)}: ${renderKey(d.nestedKey)} [${d.bucket}]${detail}`
      );
    }
    lines.push('', ...divergenceProcedure(divergences, sdkLag, unresolvedSdkLag), '');
  }

  if (nestedKeyUnparsed) {
    // The checker said it failed and this report could not read a finding out
    // of it. Neither throwing the diagnosis away nor calling the refresh clean
    // is honest — both were tried, and the second is the exact silent-clean
    // verdict the whole job exists to prevent.
    lines.push(
      `### ${D()}The nested-key check reported something this report could not read`,
      '',
      'It failed, or dropped findings, without printing lines this parser could',
      'read. That is one of its non-divergence refusals (a stale',
      '`NESTED_KEY_ALLOW_LIST`, `segmentRenames` or `terminalRenames` entry — each a',
      'real decision, and each exactly what a schema refresh causes), a change to',
      'its output format, or a checker that never ran at all (a missing task, a',
      'crash, an OOM kill — the case its exit code is the only evidence of).',
      '**Read that job\u2019s log before merging.** Any nested-key divergences listed',
      'above are the ones that DID parse, so treat that list as incomplete; every',
      'other section is unaffected.',
      '',
      '```bash',
      'vp run audit:nested-key-coverage:check',
      '```',
      ''
    );
  }

  if (failedChecks.length > 0) {
    // A LIST rather than a flag per check, because the flag-per-check shape
    // recurred once per review round: `property-coverage`'s red was discarded
    // for six of them, and closing that left `sdk-attr-coverage` and
    // `enrichment-coverage` — both fixture-driven, both CI-blocking, both
    // reachable by an ordinary schema ADDITION — reporting nothing. The next
    // one is a row in `CHECK_GUIDANCE` and a line in the workflow.
    lines.push(`### CI checks that FAILED (${failedChecks.length}) — a decision is needed`, '');
    for (const check of failedChecks) {
      // `Object.hasOwn`, not a bare lookup: a plain object literal answers for
      // `constructor` / `toString` / `valueOf` with a FUNCTION, which the
      // spread below cannot iterate — collapsing the whole diagnosis to the
      // generic failure line rather than rendering an unknown check.
      const guidance = Object.hasOwn(CHECK_GUIDANCE, check) ? CHECK_GUIDANCE[check] : undefined;
      // `renderKey`, not `renderName`: a task name carries hyphens and
      // `renderName`'s class excludes them, so every heading rendered as the
      // rejection placeholder — the section that exists to say WHICH check
      // failed naming none of them. Identical to the defect one section down,
      // one round earlier. `renderKey` adds its own backticks.
      lines.push(`#### ${D()}${renderKey(check)}`, '');
      lines.push(
        ...(guidance ?? [
          'This report carries no guidance for that check — read its job log.',
          'Whatever it names is NOT covered by the sections below.',
        ]),
        ''
      );
    }
    lines.push(
      '**Anything those checks name is NOT covered by the sections below**,',
      'whichever section it appears in.',
      ''
    );
  }

  if (writableAdded.length > 0) {
    const count = writableAdded.reduce((n, e) => n + e.properties.length, 0);
    lines.push(
      `### Writable properties AWS added (${count}) — no decision needed`,
      '',
      'These route through Cloud Control automatically once this merges. They',
      'reach the standing backfill issue WHEN THIS MERGES, not now — that list is',
      'regenerated from `main`, so closing this PR leaves it untouched. Wiring',
      'them into an SDK provider is separate work.',
      ''
    );
    for (const entry of writableAdded) {
      lines.push(
        `- ${renderName(entry.resourceType)}: ${entry.properties.map(renderName).join(', ')}`
      );
    }
    lines.push('');
  }

  if (readOnlyAddedCount > 0) {
    // Named even though there is nothing to do, because they ARE visible in the
    // fixture diff and an unexplained change invites a reader to go looking.
    lines.push(
      `### Read-only properties AWS added (${readOnlyAddedCount}) — usually nothing to do`,
      '',
      'AWS computes and returns these, so there is nothing for a provider to send',
      'and they can never be a dropped value. One case is not a no-op, and it is',
      'reachable only this way: a new read-only `*Arn` or `*Url` attribute on a',
      'type that had none makes `audit:sdk-attr-coverage:check` fail, because a',
      'cross-resource `Fn::GetAtt` would find no cached attribute to read. If that',
      'check is red on this PR, the cause is in this list.',
      ''
    );
  }

  if (unreadable.length > 0) {
    // Distinct from "not refreshed": the bundle DID carry these, and this
    // report could not read one side of the comparison. A type in here is
    // absent from the removal and the addition accounting alike, so the
    // sections above are silent about it rather than clean.
    lines.push(
      `### Fixtures this report could not read (${unreadable.length})`,
      '',
      'Neither their removals nor their additions are accounted for above. The',
      'refresh itself is the place to look — a fixture it half-wrote reads like',
      'this here.',
      '',
      // `refresh-cfn-schemas.mjs` writes `AWS::S3::Bucket` as `AWS-S3-Bucket.json`,
      // and `renderName`'s class excludes `-` — so rendering the raw stem put
      // all 134 possible names through the rejection placeholder and the
      // maintainer got a count with no types. Restored to the type spelling,
      // which is also what every other section renders.
      ...unreadable.map(
        (/** @type {string} */ f) =>
          `- ${D()}${renderName(f.replace(/\.json$/, '').replace(/-/g, '::'))}`
      ),
      ''
    );
  }

  if (skipped.length > 0) {
    lines.push(
      '### Not refreshed',
      '',
      'No entry in the public bundle; these keep the authenticated path as their',
      'only refresh route and were left untouched.',
      '',
      ...skipped.map((t) => `- ${renderName(t)}`),
      ''
    );
  }

  lines.push(
    '_What is left here is chosen by you on purpose. Both options in each case turn',
    'CI green and mean opposite things for a user’s template, and the silencing one',
    'always works — so a rule choosing under UNCERTAINTY converges on disabling the',
    'check that caught the problem. What the job settles, it settles on evidence that',
    'leaves one answer: the name is a member of a shape reachable from an operation',
    'INPUT in this type’s own client, the provider READS it off the template, and no',
    'name on the type pairs with it as a possible rename. Absent evidence is never',
    'read as absence — “no wiring found” escalates rather than concluding. See the_',
    '_[CFn schema refresh runbook](https://github.com/go-to-k/cdkd/blob/main/docs/schema-refresh-runbook.md)._'
  );
  return lines.join('\n');
}

/**
 * The writable additions that plausibly ARE this property under a new name.
 *
 * Extracted so the pairing is testable on its own: with it inline in `main()`
 * the only tests possible hand-fed the RESULT to the renderer, which meant
 * reverting the rule to "every addition is a rename" left the whole suite
 * green — the defect the suite claimed to close.
 *
 * Name similarity, deliberately, not equality: a rename is a guess here and the
 * report says so. Read-only additions never reach this function, because a
 * declaration cannot target one.
 *
 * @param {string} property
 * @param {readonly string[]} writableAdded
 * @returns {string[]}
 */
export function pairRenames(property, writableAdded) {
  // PREFIX or SUFFIX, case-sensitively — not substring containment. A short
  // name substring-matches almost anything: `Id` is inside
  // `CapacityProviderConfiguration` (via "Prov-id-er"), so containment told the
  // maintainer an unrelated addition was `Id` renamed. PascalCase makes the
  // ends the meaningful boundaries: `RepositoryId` ends with `Id`,
  // `GeoProximityLocationV2` starts with `GeoProximityLocation`.
  // An empty name matches every addition through `endsWith('')`. Unreachable
  // from a real fixture, and refused rather than left to the caller.
  if (!property) return [];
  return writableAdded.filter(
    (a) =>
      a !== property &&
      (a.startsWith(property) ||
        a.endsWith(property) ||
        property.startsWith(a) ||
        property.endsWith(a))
  );
}

/**
 * A property or type name rendered into Markdown, or a visible refusal.
 *
 * Property names come from the schema bundle, which this job documents as
 * un-checksummable and TLS-trusted only. Interpolated raw into backticks they
 * are Markdown: a crafted key closing the span and opening a heading can forge
 * a "Nothing in this refresh needs a decision" verdict in the PR body AND in
 * the umbrella issue comment — which attacks the human-review half of the very
 * residual the workflow header accepts. Anything outside the character class a
 * real CFn property uses is replaced by a loud marker rather than dropped
 * silently, so a poisoned name is visible instead of merely absent.
 *
 * @param {string} name
 * @returns {string}
 */
export function renderName(name) {
  // `:` is in the class because this renders resource TYPES as well as property
  // names, and `AWS::Service::Type` is the ordinary shape — omitting it
  // rejected every legitimate type in the "Not refreshed" list.
  return /^[A-Za-z0-9.:]+$/.test(name)
    ? `\`${name}\``
    : '**[name rejected: unexpected characters]**';
}


/**
 * A nested key PATH, which is dotted and may carry the `#top` sentinel.
 *
 * Wider than {@link renderName}'s class by exactly the characters a path needs,
 * and no wider: the point is refusing the ones that end a Markdown span or open
 * a link (a backtick, `[`, `]`, `<`, `>`, whitespace).
 *
 * @param {string} key
 * @returns {string}
 */
export function renderKey(key) {
  return /^[A-Za-z0-9._:#-]+$/.test(key)
    ? `\`${key}\``
    : '**[key rejected: unexpected characters]**';
}

/**
 * Free-form checker prose, stripped rather than rejected.
 *
 * Unlike a name this has no shape to validate against, and it is repo-derived
 * (SDK model member names) rather than bundle-derived — so the treatment is to
 * remove the characters that could break out of the line, not to refuse the
 * whole string. It already arrives carrying backticks the checker wrote.
 *
 * @param {string} text
 * @returns {string}
 */
export function renderDetail(text) {
  return text.replace(/[`<>[\]()|\\\r\n]/g, '').trim();
}

/**
 * The steps that actually settle a removed-property case.
 *
 * Written as commands rather than as advice: a report that classifies without
 * saying what to run has not handed the work over, it has handed over a
 * question. Each line is something the reader can paste.
 *
 * @param {RemovedEntry[]} removed
 * @returns {string[]}
 */
function removedProcedure(removed) {
  const first = removed[0];
  const type = first?.resourceType ?? 'AWS::Service::Type';
  const property = first?.properties[0] ?? 'PropertyName';
  return [
    '<details><summary>How to settle these</summary>',
    '',
    '1. If a **RENAME** is flagged above it is a NAME-SIMILARITY guess, not a',
    '   finding — confirm with step 2 before repointing the declaration.',
    '2. The question is whether the SDK CALL still carries the field, because',
    '   that is what cdkd makes — a removal reaching this section is about an SDK',
    "   Provider's declaration, not about Cloud Control. The evidence above",
    '   already answers it: this job reads the SDK typings and the provider',
    '   source, which is why it settles the clear cases itself and only the',
    '   unclear ones reach you.',
    '3. If the SDK no longer declares the name, the property is genuinely',
    '   retired — delete the declaration AND its wiring from the provider. That',
    '   is a behaviour change, which is why it is yours.',
    '4. If the SDK still declares it and the provider still wires it, keep',
    '   sending it: add the property to `bogusTolerated` in',
    '   `tests/fixtures/cfn-schemas/_todo-backfill.json` with a one-line reason.',
    '   (Reaching this step means something blocked the automatic write — a',
    '   possible rename is the usual one, and it is named above.)',
    '5. Re-run `vp test run property-coverage` — it names any entry still bogus,',
    '   and any tolerance AWS has since made stale.',
    '',
    '   `aws cloudformation describe-type` is available if you want corroboration,',
    '   but it is not the authority here and it adds no independent information:',
    "   this workflow's header records the measurement that the public bundle it",
    '   already read was byte-identical to the authenticated capture on every',
    '   type probed. It is also unavailable to the job itself, which holds no AWS',
    '   credentials by design.',
    '',
    '</details>',
  ];
}

/**
 * The steps that settle a nested-key divergence, including the one question the
 * evidence cannot answer on its own: whether the installed SDK simply lags.
 *
 * @param {NestedKeyDivergence[]} divergences
 * @param {SdkLagRow[]} [sdkLag]
 * @param {NestedKeyDivergence[]} [unresolved] the ones whose SDK-lag reading the
 *   published client did not settle, named so the step does not claim a check
 *   it did not make
 * @returns {string[]}
 */
function divergenceProcedure(divergences, sdkLag, unresolved = []) {
  const hasMissing = divergences.some((d) => d.bucket !== 'case-divergence');
  /** @type {string[]} */
  const lagLines = [];
  const lags = sdkLag ?? [];
  if (hasMissing) {
    // One line per (type, client) rather than one line for the whole section.
    // A single line covering "the first divergent type" left every other
    // divergence's SDK-lag reading unstated while reading like a verdict, and
    // the client it named came from the provider's FIRST import.
    // Emitted even when EVERY lookup failed (npm unreachable from CI is the
    // ordinary way that happens). Gating the whole block on having rows meant
    // the report went silent about SDK lag exactly when it knew least, and a
    // report that says nothing reads as ruled out.
    // "for the divergent types" rather than "the types above": `sdkLag` is built
    // from every divergence the checker reported, and a type whose findings all
    // moved to the pending-bump section is no longer listed above this block.
    lagLines.push('', '**Installed vs published, for the divergent types:**', '');
    for (const l of lags) {
      // Read, never re-derived. `clientsForType` falls back to every imported
      // client when none matches the type's service, so a row CAN name a client
      // that does not serve the type — but re-computing that test here turned a
      // noise-reduction heuristic into a correctness claim and told the reader
      // to discount a live lag on the 13 types whose client is not named after
      // their service (`AWS::Events::Rule` / `@aws-sdk/client-eventbridge`).
      // A false flag means the narrowing found nothing to go on, so the
      // qualifier hedges rather than denies.
      const scope = l.matched === false ? 'for that client, which may not be the type’s own' : 'here';
      // `installed` through `renderKey`, `client` and `latest` interpolated.
      // The first is whatever a dependency's own `package.json` `version` says,
      // taken on nothing but `typeof === 'string'`, and it lands here as BARE
      // markdown rather than inside a code span — so a crafted value could
      // render a fabricated section into the bot's PR body. The other two are
      // shape-fenced upstream (`sdkClientVersions`' capture and
      // `sdkVersionLag`'s version test), and `renderKey` would reject the
      // scoped package name outright.
      lagLines.push(
        l.behind
          ? `- ${renderName(l.resourceType)} — \`${l.client}\` is ${renderKey(l.installed)}, npm ` +
            `publishes ${l.latest}. The SDK-lag reading is LIVE ${scope}: bump and re-check ` +
            'before allow-listing anything.'
          : `- ${renderName(l.resourceType)} — \`${l.client}\` is ${renderKey(l.installed)}, which is ` +
            `current, so the SDK-lag reading is ruled out ${scope}.`
      );
    }
    if (lags.length === 0) lagLines.push('- Nothing could be read.');
    lagLines.push(
      '',
      'A type absent from that list is one whose client could not be read — its',
      'SDK-lag reading is UNKNOWN, not ruled out.',
      ''
    );
  }
  return [
    '<details><summary>How to settle these</summary>',
    '',
    '1. A `case-divergence` means the SDK models the key under a different',
    '   capitalisation — rename it in the provider. There is no judgement here.',
    ...lagLines,
    ...(hasMissing
      ? [
          '2. For `no-sdk-member` / `definition-member-missing`, rule out the',
          '   installed SDK simply lagging the service.',
          '',
          '   For a `definition-member-missing` the job re-asks that finding’s own',
          '   interface-scoped question in the PUBLISHED client, so one reaching',
          '   this section is one the published client does not resolve either —',
          '   EXCEPT where the published client did not settle it, which is named',
          '   below whenever it happens. A finding the bump DOES resolve is listed',
          '   in its own section above instead.',
          ...(unresolved.length > 0
            ? [
                '',
                '   **The published client could not settle these, so their SDK-lag',
                '   reading is UNKNOWN, not ruled out.** The version list above splits',
                '   them two ways and no further:',
                '',
                '   - The type is ABSENT from it. The PUBLISHED version could not be',
                '     established — npm was unreachable, npm answered with something',
                '     that is not a version, the type resolved to no client, or the',
                '     client’s own manifest could not be read — and this report cannot',
                '     tell which. Do NOT read that as “there is nothing to bump”: under',
                '     an unreachable npm the bump is precisely what went unchecked.',
                '   - The type IS in it, marked LIVE. A lagging client was named, and',
                '     either its published tarball could not be downloaded or read, or',
                '     it was read and declared no such interface. Those two are also',
                '     indistinguishable from here.',
                '',
                '   **No rendering of this report is ever rewritten in place.** The',
                '   reading is recomputed every cycle, but the day-one one sits in the',
                '   pull-request body and each later publishing cycle posts its own as',
                '   a new comment. So the newest comment holds the newest reading POSTED',
                '   — not necessarily the newest one taken, since a cycle that publishes',
                '   nothing still recomputes and discards it. If there is no comment, the',
                '   body is all there is. Either way, settle it where you are rather than',
                '   waiting, before allow-listing anything:',
                '',
                '   ```bash',
                '   node -p "require(\'@aws-sdk/client-<service>/package.json\').version"',
                '   npm view @aws-sdk/client-<service> version',
                '   # then, if it is behind, bump and re-run:',
                '   vp run audit:nested-key-coverage:check',
                '   ```',
                '',
                '   The findings:',
                '',
                ...unresolved.map(
                  (d) => `   - ${renderName(d.resourceType)}: ${renderKey(d.nestedKey)}`
                ),
              ]
            : []),
          '',
          '   A `no-sdk-member` carries no interface to re-ask — it is a',
          '   member-index question over the whole client — so check it by hand:',
          '',
          '   ```bash',
          '   # Compare what is installed against what npm publishes today.',
          '   node -p "require(\'@aws-sdk/client-<service>/package.json\').version"',
          '   npm view @aws-sdk/client-<service> version',
          '   ```',
          '',
          '   If a newer version exists, bump it and re-run',
          '   `vp run audit:nested-key-coverage:check` before deciding — an',
          '   allow-list entry added over an SDK lag hides a real dropped value.',
          '3. If the SDK is current and still lacks the member, confirm the service',
          '   API genuinely has no such field (its API reference), then add a',
          '   `NESTED_KEY_ALLOW_LIST` entry in',
          '   `scripts/gen-nested-key-coverage.ts` with a one-line reason.',
        ]
      : []),
    '',
    '</details>',
  ];
}

/**
 * Whether a failed `git show HEAD:<path>` means "brand-new fixture" or "could
 * not read".
 *
 * Exported because the distinction is the whole point and it was wrong: the
 * first cut also matched `unknown revision` and `invalid object`, which are
 * whole-REVISION failures — an unborn HEAD reports
 * `fatal: invalid object name 'HEAD'` — so a broken repository made every
 * fixture look brand-new and the whole refresh look clean. Neither pattern can
 * match a genuine path-not-in-HEAD, which says `does not exist in 'HEAD'`.
 *
 * @param {string} stderr
 * @returns {undefined | typeof UNREADABLE} `undefined` = not in HEAD
 */
export function classifyGitShowFailure(stderr) {
  return /does not exist|exists on disk, but not in/i.test(stderr) ? undefined : UNREADABLE;
}

/**
 * Read a type's committed fixture from git, or `undefined` when it is new.
 *
 * @param {string} relPath
 * @returns {string | undefined | typeof UNREADABLE}
 */
function committedVersion(relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (/** @type {any} */ error) {
    // "not in HEAD" is a brand-new fixture and means nothing to compare. Any
    // OTHER failure — git absent, a broken repo, the 32 MB buffer exceeded — is
    // this report failing to read, and collapsing the two made every fixture
    // look new and the whole refresh look clean. Measured: every file
    // undefined yields the clean verdict, over a step that only runs when
    // drift exists.
    //
    // Only the PATH-shaped failures mean "brand-new fixture". `unknown
    // revision` and `invalid object` are whole-REVISION failures — an unborn
    // HEAD reports `fatal: invalid object name 'HEAD'` — and matching them made
    // every fixture look new and the whole refresh look clean, which is the
    // exact fail-open this function was changed to close. Measured: neither can
    // ever match a genuine path-not-in-HEAD, which says
    // `does not exist in 'HEAD'`.
    return classifyGitShowFailure(String(error?.stderr ?? ''));
  }
}

/**
 * The version-lag rows for a set of divergences, one per (type, client).
 *
 * Extracted from `main()` because everything here was reachable only through
 * it, and `main()` has no unit coverage: the composition of
 * {@link clientsForType} with {@link sdkClientVersions}, the per-client memo,
 * the de-duplication, and the `case-divergence` skip were all unfalsifiable
 * while each PIECE was pinned. Two review rounds found real defects in exactly
 * this code (the first-import client, then an unrelated `client-sts` row), both
 * by running the script rather than by a test.
 *
 * Both collaborators are injected so a test needs no network: `npm view` is the
 * only outbound call in this file and it lives behind `versionLag`.
 *
 * @param {Array<{resourceType: string, bucket: string}>} divergences
 * @param {(resourceType: string) => Array<{client: string, version: string}>} clientsFor
 * @param {(client: string, installed: string) => {installed: string, latest: string, behind: boolean} | undefined} [versionLag]
 * @returns {SdkLagRow[]}
 */
export function buildSdkLag(divergences, clientsFor, versionLag = sdkVersionLag) {
  /** @type {SdkLagRow[]} */
  const out = [];
  /** @type {Map<string, {installed: string, latest: string, behind: boolean} | undefined>} */
  const byClient = new Map();
  const emitted = new Set();
  for (const d of divergences) {
    // A case divergence needs no judgement — the SDK models the key under
    // another capitalisation — so it never justifies a network call.
    if (d.bucket === 'case-divergence') continue;
    for (const { client, version, matched } of clientsForType(
      d.resourceType,
      clientsFor(d.resourceType)
    )) {
      if (!byClient.has(client)) byClient.set(client, versionLag(client, version));
      const lag = byClient.get(client);
      // One row per (type, client): several divergences routinely land on the
      // same type, and repeating its row reads as several findings.
      const key = `${d.resourceType}\u0000${client}`;
      if (lag && !emitted.has(key)) {
        emitted.add(key);
        out.push({ resourceType: d.resourceType, client, matched, ...lag });
      }
    }
  }
  return out;
}

/**
 * The interface and member a `definition-member-missing` finding is ABOUT.
 *
 * The producer writes exactly one shape
 * (`gen-nested-key-coverage.ts`'s definition sub-pass):
 *
 *     SDK interface `AuthenticationConfiguration` has no `BasicAuthenticationCredentials` member
 *
 * Anchored end to end and matched against the WHOLE detail, so a producer that
 * reworded or extended the sentence yields `undefined` — the divergence then
 * stays a decision, which is the direction a parse failure has to take. A loose
 * match would let a reworded detail bind the wrong two identifiers and settle a
 * finding from a question nobody asked.
 *
 * @param {string} detail the divergence's parenthesised detail, backticks and all
 * @returns {{definition: string, member: string} | undefined}
 */
export function parseDefinitionMemberMissing(detail) {
  const m = /^SDK interface `([A-Za-z0-9_$]+)` has no `([A-Za-z0-9_$]+)` member$/.exec(detail);
  return m ? { definition: m[1], member: m[2] } : undefined;
}

/**
 * Group the pending bumps by the dependency that resolves them.
 *
 * The unit of ACTION is a client bump, not a divergence: four
 * `AWS::Glue::Connection` findings against one lagging `@aws-sdk/client-glue`
 * are one thing to do. `countDecisions` and the rendered section both count
 * through here so the title's number and the body's labels cannot disagree.
 *
 * Returns the bumps THEMSELVES rather than encoded keys the caller splits back
 * apart. An encoded key is a round-trip that can silently fail — the first cut
 * joined on a separator the renderer then split on, and every group resolved to
 * an empty row set — while an object cannot be mis-parsed because it is never
 * parsed.
 *
 * @param {import('./diagnose-schema-refresh.d.mts').PendingSdkBump[]} pending
 * @returns {Array<{client: string, installed: string, latest: string}>} sorted
 */
export function pendingBumpGroups(pending) {
  /** @type {Map<string, {client: string, installed: string, latest: string}>} */
  const groups = new Map();
  for (const p of pending) {
    // Keyed on the PAIR: one client at two published versions is two bumps, and
    // keying on the client alone would silently merge them into one action.
    const key = `${p.client}@${p.latest}`;
    if (!groups.has(key)) {
      groups.set(key, { client: p.client, installed: p.installed, latest: p.latest });
    }
  }
  return [...groups.values()].sort((a, b) =>
    a.client === b.client ? a.latest.localeCompare(b.latest) : a.client.localeCompare(b.client)
  );
}

/**
 * Split the divergences a pending SDK bump already resolves out of the ones that
 * need a judgement, by re-asking each finding's OWN question at the version npm
 * publishes today (issue [#2819](https://github.com/go-to-k/cdkd/issues/2819)).
 *
 * **This is not a name lookup, and the distinction is the whole mechanism.**
 * `sdkVersionLag`'s comment records the measurement: the four live
 * `AWS::Glue::Connection` divergences carry names present in BOTH the installed
 * and the published client, because the finding is about a specific INTERFACE's
 * members. So the re-ask goes through the checker's own
 * `collectSdkInterfaces` index and asks the interface-scoped question verbatim —
 * `interfaces.get(definition).has(member)`.
 *
 * **What lands here is still a DECISION, deliberately.** Until the bump lands,
 * the installed SDK genuinely has no member to carry the value, so the template
 * key does not reach AWS — the live silent-drop class this whole job watches.
 * Moving these out of the count entirely would hide that for as long as the bump
 * stayed unmerged, and go-to-k/cdkd#2541 sat open for weeks. What the split
 * removes is the INVESTIGATION (four `npm view` / bump / re-check loops), not
 * the action: they collapse into one decision per lagging client.
 *
 * Scoped to `definition-member-missing` on purpose. A `no-sdk-member` finding
 * carries no detail — it is a member-index question over the whole client, not
 * an interface-scoped one — so there is no question to re-ask and it escalates
 * unchanged.
 *
 * Rows are tried MATCHED-first, and a client whose published index does not
 * declare the interface at all is skipped rather than read as "the member is
 * gone": `clientsForType` falls back to every imported client, so the row need
 * not name the type's own service. Every fetch failure degrades to escalation.
 *
 * @param {{
 *   divergences: NestedKeyDivergence[],
 *   sdkLag?: SdkLagRow[],
 *   publishedInterfaces?: (client: string, version: string) =>
 *     ReadonlyMap<string, ReadonlyMap<string, unknown>> | undefined,
 * }} input
 * @returns {{divergences: NestedKeyDivergence[],
 *   pendingSdkBump: import('./diagnose-schema-refresh.d.mts').PendingSdkBump[],
 *   unresolved: NestedKeyDivergence[]}} `unresolved` is the subset of
 *   `divergences` the published client did not SETTLE either way, so their
 *   SDK-lag reading is UNKNOWN rather than ruled out. Three routes reach it —
 *   no version row for the type, a lagging row whose published index could not
 *   be read, and lagging rows read fine that declare no such interface — and
 *   the report can separate only the FIRST from the other two, because that is
 *   all the version list distinguishes. It says so rather than enumerating
 *   causes it cannot attribute. Reporting any of them as ruled out would say
 *   the bump had been checked when nothing was, and the step it feeds ends in
 *   an allow-list entry, the one outcome that must not be reached on a guess.
 */
export function partitionPendingSdkBump({
  divergences,
  sdkLag = [],
  publishedInterfaces = requireEvidenceDeps().publishedSdkInterfaces,
}) {
  /** @type {import('./diagnose-schema-refresh.d.mts').PendingSdkBump[]} */
  const pendingSdkBump = [];
  /** @type {NestedKeyDivergence[]} */
  const remaining = [];
  /** @type {NestedKeyDivergence[]} */
  const unresolved = [];
  /** One download per client@version, however many divergences ride on it. */
  const fetched = new Map();
  const interfacesFor = (client, latest) => {
    const key = `${client} ${latest}`;
    if (!fetched.has(key)) fetched.set(key, publishedInterfaces(client, latest));
    return fetched.get(key);
  };

  for (const d of divergences) {
    const asked = d.bucket === 'definition-member-missing' ? parseDefinitionMemberMissing(d.detail) : undefined;
    if (asked === undefined) {
      remaining.push(d);
      continue;
    }
    // Kept SEPARATE from `rows` on purpose. An absent row means one of two
    // opposite things — `sdkVersionLag` could not reach npm, or it did and the
    // client is CURRENT — and only the second is an answer. Deciding off the
    // `behind`-filtered list alone conflated them, so with npm unreachable
    // (which the rendered text calls the ordinary case) EVERY type lost its
    // row, nothing was reported unknown, and the procedure went on asserting a
    // check that never ran. That is the exact failure this whole return value
    // was added for, and it survived the first cut of it.
    const typeRows = sdkLag.filter((l) => l.resourceType === d.resourceType);
    const rows = typeRows
      .filter((l) => l.behind)
      .sort((a, b) => Number(b.matched) - Number(a.matched));
    /** @type {import('./diagnose-schema-refresh.d.mts').PendingSdkBump | undefined} */
    let settled;
    /** Whether any client's published index actually declared the interface. */
    let answered = false;
    for (const row of rows) {
      const index = interfacesFor(row.client, row.latest);
      // COULD NOT READ is not the same as "this client does not declare it",
      // and collapsing the two delegates the question to a fallback client
      // `clientsForType` itself calls "may not be the type's own" — which, if
      // that one happens to declare a same-spelled interface carrying the name,
      // settles a real divergence from a client the checker never asked. Stop
      // instead, and let the finding be reported as UNKNOWN.
      if (index === undefined) break;
      const members = index.get(asked.definition);
      // Not this client's interface — keep looking rather than concluding the
      // member is absent from a client that never declared the shape.
      if (members === undefined) continue;
      answered = true;
      if (members.has(asked.member)) {
        settled = {
          ...d,
          client: row.client,
          installed: row.installed,
          latest: row.latest,
          definition: asked.definition,
          member: asked.member,
        };
      }
      // The declaring client has been found either way: a missing member here
      // IS the finding, and a further client could only confirm it.
      break;
    }
    if (settled) {
      pendingSdkBump.push(settled);
      continue;
    }
    remaining.push(d);
    // The ONE state that is a real answer without a published lookup: a row
    // exists for this type and none of them is behind, so the installed client
    // IS the latest and the checker's own verdict already stands. Reporting
    // that as unknown would send the maintainer to bump a current client.
    //
    // TWO states are real answers and neither is unknown: this one, and the
    // `answered` case above — a published index that declared the interface and
    // did not carry the member, which is the finding CONFIRMED and is this
    // module's own motivating measurement (the four Glue divergences in the
    // header).
    //
    // Everything else is unknown, by THREE routes: no row for the type at all;
    // a lagging row whose published index could not be downloaded or read,
    // which breaks out of the loop above; and lagging rows read fine that
    // declare no such interface, which exhausts it. (The first route has
    // several upstream causes — npm unreachable, npm answering with a string
    // that is not a version, no client resolved, an unreadable manifest — and
    // this function cannot tell them apart, which is why the rendered line does
    // not claim to either.)
    //
    // Nor are the second and third cleanly disjoint: a run that reads one row
    // without the interface and then fails to read the next satisfies neither
    // description alone. That is the reason the rendered line groups them and
    // says they are indistinguishable, rather than enumerating.
    const clientIsCurrent = typeRows.length > 0 && rows.length === 0;
    if (!answered && !clientIsCurrent) unresolved.push(d);
  }
  return { divergences: remaining, pendingSdkBump, unresolved };
}

/**
 * Walk the refreshed fixtures and split them into what needs a decision.
 *
 * Extracted from `main()` for the reason `buildSdkLag` was: everything here was
 * reachable only through it, `main()` has no unit coverage, and the one branch
 * that mattered — a fixture whose comparison THREW — could be deleted with the
 * whole suite green. That branch is not decoration: a type that throws vanishes
 * from the removal AND the addition accounting at once, so the residue reads as
 * "additions only" rather than as silent. It cannot be reached through a
 * directory seam either, since `committedOf` reads git HEAD and a scratch
 * fixture has no committed side to compare against.
 *
 * The readers are injected; nothing here touches the filesystem.
 *
 * @param {{
 *   files: string[],
 *   committedOf: (file: string) => string | undefined | typeof UNREADABLE,
 *   currentOf: (file: string) => string,
 *   providerFiles: Map<string, string>,
 *   declared: Map<string, Set<string>>,
 *   declarationCandidates?: typeof findDeclarationCandidates,
 *   sdkEvidence?: typeof sdkModelsMember,
 * }} input
 * @returns {{removed: RemovedEntry[], writableAdded: AddedEntry[], readOnlyAddedCount: number, unreadable: string[]}}
 */
export function collectFixtureDeltas({
  files,
  committedOf,
  currentOf,
  providerFiles,
  declared,
  declarationCandidates = findDeclarationCandidates,
  sdkEvidence = sdkModelsMember,
}) {
  /** @type {RemovedEntry[]} */
  const removed = [];
  /** @type {AddedEntry[]} */
  const writableAdded = [];
  /** @type {string[]} */
  const unreadable = [];
  let readOnlyAddedCount = 0;

  for (const file of files) {
    const committed = committedOf(file);
    if (committed === UNREADABLE) {
      unreadable.push(file);
      continue;
    }
    if (committed === undefined) continue; // Brand-new fixture: nothing to compare.
    let delta;
    let resourceType;
    try {
      delta = comparePropertySets(committed, currentOf(file));
      // The filename stem converted back, never the raw stem: it is hyphenated
      // and `renderName` rejects hyphens, so the fallback rendered
      // `**[name rejected]**` as the heading — the same shape as the two render
      // sites rounds 8 and 9 fixed. The declared-property lookup misses either
      // way, but a legible heading says which type it missed for.
      resourceType =
        JSON.parse(committed).resourceType ?? file.replace(/\.json$/, '').replace(/-/g, '::');
    } catch {
      // An unparseable side is the refresh's problem, not the report's — but it
      // is COUNTED, because a type that vanishes here vanishes from the removal
      // AND the addition accounting, and the residue can be "additions only".
      // The other two parsers grew shortfall counters in earlier rounds; this
      // one was the last silent skip.
      unreadable.push(file);
      continue;
    }

    readOnlyAddedCount += delta.added.length - delta.writableAdded.length;

    const providerRelPath = providerFiles.get(resourceType);
    const declaredHere = declared.get(resourceType) ?? new Set();
    const actionable = delta.removed.filter((/** @type {string} */ p) => declaredHere.has(p));
    if (actionable.length > 0) {
      /** @type {Record<string, string[]>} */
      const candidates = {};
      /** @type {Record<string, SdkEvidence | undefined>} */
      const sdk = {};
      /** @type {Record<string, string[]>} */
      const renameCandidates = {};
      for (const property of actionable) {
        candidates[property] = declarationCandidates(property, providerRelPath, resourceType);
        sdk[property] = sdkEvidence(property, providerRelPath);
        // Writable additions that plausibly ARE this property renamed —
        // one name containing the other. Unconditional pairing asserted a
        // rename for every unrelated addition, and with two removals and one
        // addition it claimed both, of which at most one can be true.
        // Read-only additions are excluded outright: a declaration cannot
        // target one, so "point the declaration at the new name" would just
        // produce the next bogus entry.
        renameCandidates[property] = pairRenames(property, delta.writableAdded);
      }
      removed.push({
        resourceType,
        properties: actionable,
        candidates,
        sdk,
        renameCandidates,
        providerPath: providerRelPath,
      });
    }
    if (delta.writableAdded.length > 0) {
      writableAdded.push({ resourceType, properties: delta.writableAdded });
    }
  }

  return { removed, writableAdded, readOnlyAddedCount, unreadable };
}

/**
 * The coverage table, refusing a MISSING module rather than reading it as empty.
 *
 * `parseDeclaredProperties('')` returns an empty map without throwing — the
 * by-hand case — so the caller's `existsSync(...) ? read : ''` turned an absent
 * file into "no provider declares anything", which filters every removal away
 * and renders the clean verdict. Measured on a real
 * `AWS::Route53::RecordSet.GeoProximityLocation` removal.
 *
 * Split out of `main()` so the refusal is reachable from a test; every other
 * refusal in this file already was.
 *
 * @param {string} [repoRoot]
 * @returns {Map<string, Set<string>>}
 */
export function loadDeclaredPropertiesSource(repoRoot = REPO_ROOT) {
  const generatedPath = join(repoRoot, 'src/provisioning/property-coverage.generated.ts');
  if (!existsSync(generatedPath)) {
    throw new Error(
      `${generatedPath} is missing — refusing to report from a coverage table that was ` +
        'never read.'
    );
  }
  return readFileSync(generatedPath, 'utf8');
}

export function loadDeclaredProperties(repoRoot = REPO_ROOT) {
  const generatedPath = join(repoRoot, 'src/provisioning/property-coverage.generated.ts');
  if (!existsSync(generatedPath)) {
    throw new Error(
      `${generatedPath} is missing — refusing to report which removals need a decision ` +
        'from a coverage table that was never read.'
    );
  }
  return parseDeclaredProperties(readFileSync(generatedPath, 'utf8'));
}

/**
 * Every flag this script accepts. Fenced as a SET against the synopsis — the
 * order here is for reading, not a checked property.
 *
 * EXPORTED so the header docblock and the argument readers cannot drift apart:
 * the synopsis documented `--property-coverage-rc` for two rounds after
 * `--failed-checks` replaced it, and with no unknown-flag guard, following the
 * script's own documented usage produced
 * "Nothing in this refresh needs a decision — additions only" over a red
 * `property-coverage` — the verdict six rounds went into closing, reached
 * through the documentation.
 */
export const KNOWN_FLAGS = [
  '--nested-key-log',
  '--nested-key-rc',
  '--failed-checks',
  '--skipped-log',
  '--umbrella-checklist',
  '--decision-count-out',
  '--write-auto-tolerated',
  '--auto-tolerated',
  // Test seam; see its use below.
  '--fixtures-dir',
];

/**
 * The flag a token names, or `undefined`.
 *
 * Shared with the entry point so it can tell a MISTYPED flag from a real mode
 * before loading anything: the load runs ahead of `main()`'s own guard, so on
 * the no-install runner `--umbrella-checklists` used to report "could not load
 * the evidence helpers" — pointing at the wrong file, which is exactly what the
 * loader's own comment argues against.
 *
 * @param {string} arg
 */
export function knownFlagFor(arg) {
  return KNOWN_FLAGS.find((f) => arg === f || arg.startsWith(`${f}=`));
}

/**
 * Refuse a fixture listing too small to have been produced by a real refresh.
 *
 * The LAST input in this file without a floor, and the same class as every
 * other one: `parseDeclaredProperties` throws on zero types and on a
 * recognised-entry shortfall, `loadDeclaredProperties` refuses a missing
 * module, `parseNestedKeyDivergences` counts a shortfall, the per-fixture
 * `catch` counts `unreadable` — while the directory listing went straight in.
 * An empty one yields empty removals AND empty additions, which renders as
 * "additions only".
 *
 * The bound is the DECLARED type count rather than a constant: the two move
 * together (134 and 134 today), a hand-picked number goes stale, and the
 * producer never deletes a fixture. Half is slack for a genuine mid-refresh
 * state, not a target.
 *
 * @param {number} fixtureCount
 * @param {number} declaredCount
 */
export function assertFixtureFloor(fixtureCount, declaredCount) {
  if (fixtureCount === 0) {
    throw new Error(
      'no schema fixtures found — refusing to report "nothing needs a decision" from a ' +
        'directory this run never read.'
    );
  }
  // No `declaredCount > 0` guard: `fixtureCount * 2 < 0` is unreachable for a
  // non-negative count, so it was dead code whose case could not fail.
  if (fixtureCount * 2 < declaredCount) {
    throw new Error(
      `only ${fixtureCount} schema fixtures against ${declaredCount} declared types — ` +
        'refusing to report from a listing this far short of the coverage table.'
    );
  }
}

/**
 * What `--umbrella-checklist` emits when the campaign is FINISHED.
 *
 * A zero-row render and a broken one are both "no rows", and the consuming
 * workflow has to tell them apart: it accepts rows-or-this and refuses
 * anything else, so a parse that produced nothing cannot be spliced in as
 * "the campaign is over". Exported because that workflow's fence pins the two
 * spellings against each other.
 */
export const UMBRELLA_EMPTY_SENTINEL =
  '_No remaining silent-drop properties — every declared type is fully covered._';

/**
 * The remaining silent-drop properties, as a checklist the umbrella issue owns.
 *
 * REGENERATED each cycle rather than appended to, and that is the whole point.
 * An append-only list cannot express a type that was ticked off and later
 * regained a property: the `[x]` row stays checked and a second row appears for
 * the same type, so the reader sees one entry saying "done" and another saying
 * "not". Dedup does not fix that — it is the append model that is wrong.
 *
 * The generated coverage map is the source of truth for what remains (the
 * umbrella's own completion criterion says so), so this renders FROM it. A type
 * that regains a property simply reappears, and one that is finished disappears,
 * with no state to maintain by hand and nothing to go stale.
 *
 * Human-written provenance — which pull request closed which slice — is NOT in
 * here. It cannot be recomputed, so it lives outside the generated block and is
 * never touched.
 *
 * @param {string} generatedSource
 * @returns {string[]} one `- [ ] \`Type\`: \`Prop\`` row per remaining property
 */
export function renderUmbrellaChecklist(generatedSource) {
  const boundaries = [...generatedSource.matchAll(/\[\s*'([A-Z][\w:]+)'\s*,\s*\{/g)];
  if (boundaries.length === 0) {
    throw new Error(
      'property-coverage.generated.ts parsed to zero types — refusing to render an empty ' +
        'checklist over a module the parser could not read.'
    );
  }
  /** @type {string[]} */
  const rows = [];
  for (let i = 0; i < boundaries.length; i++) {
    const slice = generatedSource.slice(
      boundaries[i].index,
      i + 1 < boundaries.length ? boundaries[i + 1].index : undefined
    );
    const type = boundaries[i][1];
    // Only the populated shape carries rows; `new Map<string, string>()` is a
    // finished type and contributes nothing.
    const drop = /silentDrop:\s*new Map<[^>]*>\(\s*\[([\s\S]*?)\]\s*\)/.exec(slice);
    if (!drop) continue;
    for (const m of drop[1].matchAll(/\[\s*'([^']+)'\s*,/g)) {
      rows.push(`- [ ] ${renderName(type)}: ${renderName(m[1])}`);
    }
  }
  return rows;
}

/**
 * The whole document `--umbrella-checklist` writes: the rows, or the
 * finished-campaign sentinel when there are none.
 *
 * Split out of `main()` because the empty arm is otherwise UNREACHABLE from a
 * test — the real coverage map always has rows, so a mutation deleting the
 * sentinel survived every case (measured). The consuming workflow accepts rows
 * OR this sentinel and refuses anything else, so the branch that chooses
 * between them is exactly what has to be pinned.
 *
 * @param {string} generatedSource
 * @returns {string}
 */
export function renderUmbrellaDocument(generatedSource) {
  const rows = renderUmbrellaChecklist(generatedSource);
  return rows.length > 0 ? rows.join('\n') : UMBRELLA_EMPTY_SENTINEL;
}

function main() {
  const args = process.argv.slice(2);

  // An unrecognised flag must NOT silently fall through: every reader's
  // absent-flag arm is the permissive one (`''` for the logs, "nothing failed"
  // for the check list), so a typo, a retired flag or a single-dash spelling
  // all render as clean. Same guard, and the same reasoning, as the sibling
  // producer `refresh-cfn-schemas.mjs` carries.
  // EVERY unrecognised argument, not just the dash-leading ones: this script
  // takes no positionals, and `failed-checks property-coverage` — one spelling
  // over from the `-failed-checks` the first guard caught — fell straight
  // through to the permissive arms and rendered the clean verdict. A guard
  // covering fewer spellings than its subject accepts is the shape this whole
  // file kept producing.
  /** @type {string[]} */
  const unknown = [];
  /** @type {string[]} */
  const repeated = [];
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // One classification per token, so the glued and space spellings take the
    // SAME path — an earlier revision `continue`d on the glued form before the
    // repeat check and `--nested-key-rc=0 --nested-key-rc=3` still rendered
    // clean.
    const flag = knownFlagFor(a);
    if (flag === undefined) {
      unknown.push(a);
      continue;
    }
    // A REPEAT is not a valid invocation: `rawArg` reads exactly ONE of them and
    // WHICH one depends on the spelling — it looks for the glued form before
    // the space form, so `--nested-key-rc 0 --nested-key-rc=3` reads 3 while
    // the other three orderings read 0. Either way a value is silently
    // discarded, which rendered the clean verdict over a failing checker: the
    // last argv shape that still reached a confident answer.
    if (seen.has(flag)) repeated.push(flag);
    seen.add(flag);
    if (a === flag) {
      // Its value is consumed only if it could BE one. A dash-leading token is
      // not a value here — the same rule `rawArg` applies — so consuming it
      // blindly would let `--failed-checks --skipped-log <path>` swallow the
      // second flag and report the PATH as the unknown argument.
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) i += 1;
    }
  }
  if (repeated.length > 0) {
    throw new Error(
      `flag(s) given more than once: ${[...new Set(repeated)].join(', ')} — only one would ` +
        'have been read, and which one depends on the spelling. Refusing to report from an ' +
        'invocation this script did not understand.'
    );
  }
  if (unknown.length > 0) {
    throw new Error(
      `unrecognized flag(s): ${unknown.join(', ')} — known flags are ${KNOWN_FLAGS.join(', ')}. ` +
        'Refusing to report from an invocation this script did not understand.'
    );
  }

  // `--umbrella-checklist` renders the generated block and exits; it shares this
  // script only because the coverage-module parser already lives here.
  //
  // It returns HERE, before any of the refresh-report setup, and that position
  // is load-bearing rather than tidy. The mode reads one file —
  // `property-coverage.generated.ts` — but sitting further down it first ran
  // `loadDeclaredProperties`, `readdirSync` over the fixtures,
  // `assertFixtureFloor` and `collectFixtureDeltas`, the last of which shells
  // out to `git show` once per fixture to fetch the committed version. None of
  // that feeds the checklist, and all of it can FAIL: the umbrella sync
  // workflow (go-to-k/cdkd#2774) runs this mode from a plain `main` checkout
  // with no refresh in front of it, so a floor tuned for the refresh's
  // population, or a git object the sync's shallow clone lacks, would abort a
  // render whose own input was sitting there readable.
  if (args.includes('--umbrella-checklist')) {
    process.stdout.write(renderUmbrellaDocument(loadDeclaredPropertiesSource()) + '\n');
    return;
  }
  // The third reader, and it was the last one still silent on both counts: a
  // flag with no value AND a path that does not exist both returned `''`.
  // `--nested-key-log` is rescued by its `--nested-key-rc` companion, but
  // `--skipped-log` has none and the section is omitted when empty — so an
  // unread log was byte-identical to "everything was refreshed".
  /**
   * The raw value of a flag, in either spelling, or `undefined` when absent.
   *
   * `--flag=value` was invisible to all three readers: `args.indexOf(flag)`
   * returns -1, so a mistyped invocation fell through to each reader's
   * absent-flag arm — `''` for the log readers and 0 ("the checker succeeded")
   * for the status one. Only the workflow's space form held it shut, and the
   * fence for THAT accepted `--skipped-log=...` too.
   *
   * A value that is itself a flag is no value at all, in either dash spelling:
   * the guard covered `--x` only, so `--failed-checks -property-coverage`
   * fabricated a failed check named `-property-coverage`.
   */
  const rawArg = (/** @type {string} */ flag) => {
    // BOTH spellings take the dash test. The glued branch returned early and
    // skipped it, so `--failed-checks=-property-coverage` fabricated exactly
    // the check the space-form guard was written to kill — the two halves were
    // added to this function in the same round and never crossed.
    const glued = args.find((a) => a.startsWith(`${flag}=`));
    if (glued !== undefined) {
      const value = glued.slice(flag.length + 1);
      return /^-/.test(value) ? null : value;
    }
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const value = args[i + 1];
    return value === undefined || /^-/.test(value) ? null : value;
  };

  const readArg = (/** @type {string} */ flag) => {
    const path = rawArg(flag);
    if (path === undefined) return '';
    if (path === null || path === '') {
      throw new Error(`${flag} was given with no value — refusing to report from an unread file.`);
    }
    if (!existsSync(path)) {
      throw new Error(
        `${flag} names ${path}, which does not exist — refusing to report from an unread file.`
      );
    }
    if (statSync(path).isDirectory()) {
      throw new Error(
        `${flag} names ${path}, which is a directory — refusing to report from an unread file.`
      );
    }
    return readFileSync(path, 'utf8');
  };

  const providerFiles = mapTypesToProviderFiles(
    readFileSync(join(REPO_ROOT, 'src/provisioning/register-providers.ts'), 'utf8')
  );

  // Which properties each provider DECLARES. A removal only needs a decision
  // when something declares the property — otherwise the property leaving the
  // schema changes nothing and reporting it is pure noise. Measured on real
  // drift before this filter: 5 removals reported, of which 4 were `Id` on
  // types no provider declares it for.
  //
  // Read from the generated coverage module rather than re-parsing providers:
  // `gen-property-coverage.ts` writes `handled` VERBATIM from the declaration
  // and does not intersect it with the fixture, so a property AWS just removed
  // is still listed there — which is exactly the "now bogus" condition.
  const declared = loadDeclaredProperties();

  // `--fixtures-dir=` is a TEST SEAM, the same shape `gen-nested-key-coverage.ts`
  // uses for `--providers-dir=`. It exists because the floor's call site was
  // otherwise unreachable and got covered by a source-shape assertion instead —
  // and that assertion could not see the call wrapped in `try {} catch {}`,
  // which measured as printing the exact clean verdict the floor exists to
  // prevent. A seam that makes the real path testable beats a fence over its
  // spelling.
  const fixturesDir = rawArg('--fixtures-dir') || FIXTURES_DIR;
  const fixtureFiles = readdirSync(fixturesDir).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  );
  assertFixtureFloor(fixtureFiles.length, declared.size);
  const { removed, writableAdded, readOnlyAddedCount, unreadable } = collectFixtureDeltas({
    files: fixtureFiles,
    // Follows the seam too. Leaving this hard-coded while `currentOf` moved is
    // harmless for the empty directory the test uses, and wrong for any other:
    // it would diff scratch content against the real committed fixtures.
    committedOf: (file) => committedVersion(`${relative(REPO_ROOT, fixturesDir)}/${file}`),
    currentOf: (file) => readFileSync(join(fixturesDir, file), 'utf8'),
    providerFiles,
    declared,
  });

  // The WRITE mode, and it returns here — before the report, the checkers and
  // the nested-key log are even read. It runs as its own workflow step, BEFORE
  // the checks, because the whole point is that `property-coverage` should be
  // green by the time it runs on a property nothing was ever going to decide
  // differently.
  const autoOut = rawArg('--write-auto-tolerated');
  if (autoOut === null || autoOut === '') {
    throw new Error(
      '--write-auto-tolerated was given with no value — there is nowhere to record which ' +
        'properties were settled automatically, and the report renders that file.'
    );
  }
  if (autoOut !== undefined) {
    writeFileSync(
      autoOut,
      `${JSON.stringify(writeAutoTolerated(removed, providerFiles), null, 2)}\n`
    );
    return;
  }

  // An UNREADABLE status is not a successful one: a mistyped value used to
  // return 0 — "the checker succeeded" — silently restoring the behaviour where
  // a checker that never ran renders as "additions only".
  //
  // An ABSENT flag is different and stays 0: this script is also run by hand
  // (the runbook's `vp run audit:nested-key-coverage:check` loop), and refusing
  // every manual invocation is not a safety property. The risk the absent arm
  // carries — the WORKFLOW dropping the flag — is guarded where the evidence
  // still exists, by the workflow test asserting it passes the variable.
  // A flag PRESENT with no value is unreadable, not empty — the same
  // distinction `readNumArg` draws, and its twin here fails open the same way:
  // an empty list reads as "nothing failed".
  const readArgValue = (/** @type {string} */ flag) => {
    const raw = rawArg(flag);
    if (raw === undefined) return '';
    if (raw === null) {
      throw new Error(`${flag} was given with no value — refusing to report from an unread list.`);
    }
    return raw;
  };
  const readNumArg = (/** @type {string} */ flag) => {
    const raw = rawArg(flag);
    if (raw === undefined) return 0;
    if (raw === null || raw.trim() === '') return 1;
    const n = Number(raw);
    return Number.isFinite(n) ? n : 1;
  };
  const nestedKey = parseNestedKeyDivergences(
    readArg('--nested-key-log'),
    readNumArg('--nested-key-rc')
  );
  // Properties the WRITE step already settled, subtracted from `removed` so
  // they are not also reported as needing a decision. They keep their own
  // section below: an automatic write is exactly the thing a reader should be
  // able to audit, and burying it would make the job's own silence the only
  // evidence it happened.
  const autoRecord = readArg('--auto-tolerated');
  /** @type {Array<{resourceType: string, property: string, rationale: string}>} */
  let autoTolerated = [];
  /** @type {Array<{resourceType: string, property: string, reason: string}>} */
  let autoEscalated = [];
  if (autoRecord !== '') {
    const parsed = JSON.parse(autoRecord);
    autoTolerated = Array.isArray(parsed.written) ? parsed.written : [];
    autoEscalated = Array.isArray(parsed.escalated) ? parsed.escalated : [];
  }
  // The record's own claim, checked against the FILE. `written` says the run
  // meant to write an entry; only the tolerance file says one is there, and the
  // list is what suppresses a decision and lowers the count. A stale record
  // from an earlier run — or one naming a property this cycle did not settle —
  // would otherwise hide a live decision behind a write that is not on the
  // branch.
  const tolerancePath = join(REPO_ROOT, 'tests/fixtures/cfn-schemas/_todo-backfill.json');
  if (autoTolerated.length > 0 && existsSync(tolerancePath)) {
    const live = JSON.parse(readFileSync(tolerancePath, 'utf8')).bogusTolerated ?? {};
    autoTolerated = autoTolerated.filter((w) => live[w.resourceType]?.[w.property] !== undefined);
  }
  const settled = new Set(autoTolerated.map((w) => `${w.resourceType}\u0000${w.property}`));
  const removedForReport = removed
    .map((e) => ({
      ...e,
      properties: e.properties.filter((p) => !settled.has(`${e.resourceType}\u0000${p}`)),
    }))
    .filter((e) => e.properties.length > 0);

  const failedChecks = readArgValue('--failed-checks')
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c !== '');
  const allDivergences = nestedKey.divergences;
  const skipped = readArg('--skipped-log')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^AWS::/.test(l));

  // Version lag is asked only when a divergence needs it — never on the happy
  // path — and for EVERY divergent type's clients rather than the first one's
  // first import. Each distinct client is asked once; the failure of any single
  // lookup is silent by construction and shows up as an absent row, which the
  // rendered section names as UNKNOWN rather than ruled out.
  const sdkLag = buildSdkLag(allDivergences, (t) => sdkClientVersions(providerFiles.get(t)));

  // Runs AFTER `buildSdkLag` because it consumes its rows, and BEFORE anything
  // reads `divergences`: the report and the count must both see the narrowed
  // list, or the body would label a finding the title does not count. Only a
  // client already known to be BEHIND is ever downloaded, so a refresh with no
  // lagging client makes no request at all.
  const {
    divergences,
    pendingSdkBump,
    unresolved: unresolvedSdkLag,
  } = partitionPendingSdkBump({
    divergences: allDivergences,
    sdkLag,
  });

  // Written as a SIDE EFFECT of the same invocation that renders the report,
  // rather than exposed as a second mode the workflow runs again. A second run
  // would re-read `--nested-key-log` and `--failed-checks` from its own argv,
  // so a workflow that passed one of them to the report and not to the count
  // would mark a PR "no decisions needed" over a report listing several —
  // exactly the shape `--failed-checks` already produced once, and the shape
  // this file's argv guards exist to refuse. One invocation cannot disagree
  // with itself.
  const countOut = rawArg('--decision-count-out');
  if (countOut === null || countOut === '') {
    throw new Error(
      '--decision-count-out was given with no value — there is no file to write the count to, ' +
        'and an unwritten count is what the marking step refuses to re-mark from.'
    );
  }
  // The REPORT goes out first, and a failure to write the count does not stop
  // it. This ordering is load-bearing, and getting it backwards reversed the
  // job's own stated priority: `--decision-count-out` rides on the SAME
  // invocation that renders the PR body, so a throw here failed the Diagnose
  // step, and Publish and Mark carry plain `if:` conditions — which GitHub
  // ANDs with an implicit `success()` — so the drift went uncommitted and NO
  // PR opened at all. The workflow comment two steps up says exactly why that
  // is the wrong trade: the PR is how the human finds out.
  //
  // Nothing is lost by being forgiving here, because the marking step refuses
  // an absent or empty count file rather than reading it as zero. The failure
  // is still LOUD — it reddens that step — but it reddens it beside a PR that
  // exists.
  process.stdout.write(
    renderDiagnosis({
      removed: removedForReport,
      autoTolerated,
      autoEscalated,
      writableAdded,
      readOnlyAddedCount,
      divergences,
      pendingSdkBump,
      unresolvedSdkLag,
      nestedKeyUnparsed: nestedKey.unparsedFailure,
      failedChecks,
      unreadable,
      skipped,
      sdkLag,
    }) + '\n'
  );

  if (countOut !== undefined) {
    try {
      writeFileSync(
        countOut,
        `${countDecisions({ removed: removedForReport, divergences, pendingSdkBump, nestedKeyUnparsed: nestedKey.unparsedFailure, failedChecks, unreadable })}\n`
      );
    } catch (err) {
      process.stderr.write(
        `diagnose-schema-refresh: could not write the decision count to ${countOut} ` +
          `(${err instanceof Error ? err.message : String(err)}). The marking step will refuse ` +
          'to re-mark from a missing count.\n'
      );
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // The one mode that must run with NO dependencies installed keeps its graph to
  // `node:` builtins; every other mode loads the evidence helpers first. Written
  // as a positive test of THIS mode rather than a list of the others, so a mode
  // added later loads them by default — the safe direction, since the cost is an
  // install the workflow already performs and the alternative is a mode that
  // silently reaches `requireEvidenceDeps`'s refusal.
  //
  // OUTSIDE the swallow below, deliberately. A failure HERE is not a failed
  // diagnosis — it is the run never having had its inputs — and the swallow's
  // justification ("a broken diagnosis must not take down the PR it describes")
  // does not carry: rendering the could-not-run sentence at exit 0 would report
  // a missing dependency as a report cdkd chose to write, which is the same
  // misread the lazy import removes one layer down.
  let inputsReady = true;
  // A MISTYPED flag must reach `main()`'s own guard rather than the loader: the
  // load runs first, so without this a typo on the no-install runner reports a
  // missing dependency and names the wrong file.
  const argv = process.argv.slice(2);
  const mistyped = argv.some((a) => a.startsWith('-') && knownFlagFor(a) === undefined);
  if (!argv.includes('--umbrella-checklist') && !mistyped) {
    try {
      await loadEvidenceDeps();
    } catch (err) {
      process.stderr.write(
        `diagnose-schema-refresh: could not load the evidence helpers ` +
          `(${err instanceof Error ? err.message : String(err)}). This run read nothing; ` +
          'do not treat its output as a diagnosis.\n'
      );
      process.exitCode = 1;
      inputsReady = false;
    }
  }
  // The `try` wraps nothing when the load failed, which is deliberate rather
  // than dead: hoisting `main()` into an `else` on the arm above would need a
  // second copy of this catch, and the two copies are exactly what drifts.
  try {
    if (inputsReady) main();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A broken diagnosis must never take down the PR it describes — but that
    // reasoning is about the HUMAN-READABLE report, and it does not carry to
    // the two modes a workflow CONSUMES.
    //
    // `--umbrella-checklist`: swallowing wrote one error sentence to stdout at
    // exit 0, so the sync workflow's redirect produced a non-empty file and its
    // size guard passed — splicing that sentence into the umbrella in place of
    // the entire checklist, on a green run.
    //
    // `--decision-count-out` is deliberately NOT in this set, and the reason is
    // the whole shape of the trade. It rides on the invocation that renders the
    // PR BODY, so exiting non-zero for it fails the Diagnose step and — through
    // the implicit `success()` on the steps below — stops the PR from opening
    // at all. Its unwritten count is caught one step later instead, where the
    // marking step refuses an absent file rather than reading it as zero. The
    // write itself is wrapped where it happens, above.
    const consumedByAWorkflow = process.argv.slice(2).some((a) => a === '--umbrella-checklist');
    if (consumedByAWorkflow) {
      // `process.exitCode`, and no `return`: this catch sits at MODULE top
      // level, not inside a function, so a `return` here is a SyntaxError that
      // makes the whole file unparseable — which reads, from a shell, exactly
      // like the runtime failure being handled.
      process.stderr.write(`diagnose-schema-refresh: ${message}\n`);
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `_The automated diagnosis failed to run (${message}). Read the CI log for the failing checks._\n`
      );
    }
  }
}
