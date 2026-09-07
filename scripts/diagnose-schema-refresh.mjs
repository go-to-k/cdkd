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
 *     [--coverage-log <file>] [--nested-key-log <file>] > body.md
 *
 * Emits Markdown on stdout and always exits 0 — a diagnosis that fails must
 * not take down the PR it is describing.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

/**
 * @typedef {import('./diagnose-schema-refresh.d.mts').NestedKeyDivergence} NestedKeyDivergence
 * @typedef {import('./diagnose-schema-refresh.d.mts').SdkLagRow} SdkLagRow
 * @typedef {{client: string, modelled: boolean, version?: string, consulted?: string[]}} SdkEvidence
 * @typedef {{resourceType: string, properties: string[], candidates: Record<string, string[]>, sdk?: Record<string, SdkEvidence | undefined>, renameCandidates?: Record<string, string[]>, providerPath?: string}} RemovedEntry
 * @typedef {{resourceType: string, properties: string[]}} AddedEntry
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
 * @returns {{divergences: Array<{resourceType: string, nestedKey: string, bucket: string, detail: string}>, unparsedFailure: boolean}}
 */
export function parseNestedKeyDivergences(checkOutput, exitCode = 0) {
  /** @type {Array<{resourceType: string, nestedKey: string, bucket: string, detail: string}>} */
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
 * @returns {{client: string, modelled: boolean, version?: string, consulted?: string[]} | undefined}
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
 * correctness claim.
 *
 * @param {string} resourceType
 * @param {Array<{client: string, version: string}>} rows
 * @returns {Array<{client: string, version: string}>}
 */
export function clientsForType(resourceType, rows) {
  const service = (resourceType.split('::')[1] ?? '').toLowerCase();
  if (!service) return rows;
  const matched = rows.filter(
    (r) => r.client.replace('@aws-sdk/client-', '').replace(/-/g, '') === service
  );
  return matched.length > 0 ? matched : rows;
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
 * uncertainty converges on it — disabling the very check that caught the
 * problem, silently. Evidence shortens the human's work; it does not change who
 * accepts that risk.
 *
 * @param {object} input
 * @param {RemovedEntry[]} input.removed
 * @param {AddedEntry[]} input.writableAdded
 * @param {number} [input.readOnlyAddedCount]
 * @param {SdkLagRow[]} [input.sdkLag]
 * @param {boolean} [input.nestedKeyUnparsed]
 * @param {NestedKeyDivergence[]} input.divergences
 * @param {string[]} input.skipped
 * @returns {string}
 */
export function renderDiagnosis({
  removed,
  writableAdded,
  readOnlyAddedCount = 0,
  divergences,
  nestedKeyUnparsed = false,
  skipped,
  sdkLag,
}) {
  const lines = ['## What changed, and what needs a decision', ''];

  // `nestedKeyUnparsed` is part of the condition, not just a section below it:
  // a checker that FAILED in a mode this report cannot read is the one state
  // where "additions only" is a confident wrong answer rather than a gap.
  if (removed.length === 0 && divergences.length === 0 && !nestedKeyUnparsed) {
    lines.push('Nothing in this refresh needs a decision — additions only.', '');
  }

  if (removed.length > 0) {
    lines.push(
      '### Properties AWS removed — a decision is needed',
      '',
      'Each was in the previous snapshot, is not in this one, AND is declared by',
      'the provider — so the declaration is now bogus. Removals nothing declares',
      'are not listed: they change nothing.',
      ''
    );
    for (const entry of removed) {
      lines.push(`- ${renderName(entry.resourceType)}`);
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
              'name-similarity guess, not a finding — confirm it against the live ' +
              'registry below before repointing the declaration.'
          );
        }

        const sdk = entry.sdk?.[property];
        if (sdk === undefined) {
          lines.push('    - SDK evidence: none — could not determine the client to consult');
        } else if (sdk.modelled) {
          lines.push(
            `    - SDK evidence: \`${sdk.client}\`${
              sdk.version ? ` (${sdk.version})` : ''
            } **still models this name** (case-insensitively), so the API likely ` +
              'still accepts it — leans toward keeping it (`bogusTolerated`)'
          );
        } else {
          lines.push(
            `    - SDK evidence: \`${sdk.client}\`${
              sdk.version ? ` (${sdk.version})` : ''
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

  if (divergences.length > 0) {
    lines.push(
      '### Nested-key divergences — a decision is needed',
      '',
      'Reported by the nested-key check, which reports divergences rather than',
      'staleness, so regenerating will not clear these.',
      ''
    );
    for (const d of divergences) {
      const detail = d.detail ? ` — ${renderDetail(d.detail)}` : '';
      lines.push(
        `- ${renderName(d.resourceType)}: ${renderKey(d.nestedKey)} [${d.bucket}]${detail}`
      );
    }
    lines.push('', ...divergenceProcedure(divergences, sdkLag), '');
  }

  if (nestedKeyUnparsed) {
    // The checker said it failed and this report could not read a finding out
    // of it. Neither throwing the diagnosis away nor calling the refresh clean
    // is honest — both were tried, and the second is the exact silent-clean
    // verdict the whole job exists to prevent.
    lines.push(
      '### The nested-key check FAILED in a mode this report cannot read',
      '',
      'It reported a failure and printed no finding line this parser recognises.',
      'That is one of its non-divergence refusals (a stale `NESTED_KEY_ALLOW_LIST`,',
      '`segmentRenames` or `terminalRenames` entry — each a real decision, and each',
      'exactly what a schema refresh causes), a crash, or a change to its output',
      'format. **Read the failing job log before merging**; the sections below are',
      'still accurate for everything other than nested keys.',
      '',
      '```bash',
      'vp run audit:nested-key-coverage:check',
      '```',
      ''
    );
  }

  if (writableAdded.length > 0) {
    const count = writableAdded.reduce((n, e) => n + e.properties.length, 0);
    lines.push(
      `### Writable properties AWS added (${count}) — no decision needed`,
      '',
      'These route through Cloud Control automatically once this merges. They are',
      'posted to the standing backfill issue too; wiring them into an SDK provider',
      'is separate work.',
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
      `### Read-only properties AWS added (${readOnlyAddedCount}) — nothing to do`,
      '',
      'Visible in the fixture diff, but AWS computes and returns these; there is',
      'nothing for a provider to send, so they can never be a dropped value.',
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
    '_The choice itself is deliberately not made here: both options in each case',
    'turn CI green and mean opposite things for a user’s template, and the',
    'silencing one always works — so anything choosing automatically under',
    'uncertainty converges on disabling the check. See the_',
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
 * The literal form of a name for a paste-able SHELL command.
 *
 * Same character class as {@link renderName} and for the same reason, but the
 * consequence differs: these go inside single quotes in a `bash` block the
 * runbook tells the maintainer to paste, so a `'` in a bundle-derived name is
 * command injection into the maintainer's own terminal rather than a broken
 * Markdown span. The class excludes it. A rejected name yields a placeholder
 * that cannot be pasted by accident.
 *
 * @param {string} name
 * @returns {string}
 */
export function renderLiteral(name) {
  return /^[A-Za-z0-9.:]+$/.test(name) ? name : 'NAME_REJECTED_UNEXPECTED_CHARACTERS';
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
    '2. Confirm against the live registry — this is the API AWS serves,',
    '   not the published bundle:',
    '',
    '   ```bash',
    `   aws cloudformation describe-type --type RESOURCE --type-name '${renderLiteral(type)}' \\`,
    "     --query Schema --output text | jq -r '.properties | keys[]' | grep -i " +
      `'${renderLiteral(property)}'`,
    '   ```',
    '',
    '3. If the SDK evidence says the name is gone AND step 2 finds nothing, the',
    '   property is genuinely retired — delete the declaration from the provider.',
    '4. If either still knows the name, keep sending it: add the property to',
    '   `bogusTolerated` in `tests/fixtures/cfn-schemas/_todo-backfill.json` with a',
    '   one-line reason (why the CFn schema no longer lists it, and why cdkd still',
    '   sends it).',
    '5. Re-run `vp test run property-coverage` — it names any entry still bogus.',
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
 * @returns {string[]}
 */
function divergenceProcedure(divergences, sdkLag) {
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
    lagLines.push('', '**Installed vs published, for the divergent types above:**', '');
    for (const l of lags) {
      // `clientsForType` falls back to every imported client when none matches
      // the type's service, so a row can name a client that does not serve the
      // type at all. Saying "ruled out here" over `@aws-sdk/client-sts` would
      // attribute a verdict to the wrong service.
      const own = l.client.replace('@aws-sdk/client-', '').replace(/-/g, '') ===
        (l.resourceType.split('::')[1] ?? '').toLowerCase();
      const scope = own ? 'here' : "for that client, which is not the type's own";
      lagLines.push(
        l.behind
          ? `- ${renderName(l.resourceType)} — \`${l.client}\` is ${l.installed}, npm ` +
            `publishes ${l.latest}. The SDK-lag reading is LIVE ${scope}: bump and re-check ` +
            'before allow-listing anything.'
          : `- ${renderName(l.resourceType)} — \`${l.client}\` is ${l.installed}, which is ` +
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
          '2. For `no-sdk-member` / `definition-member-missing`, first rule out the',
          '   installed SDK simply lagging the service:',
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
 * Read a type's committed fixture from git, or `undefined` when it is new.
 *
 * @param {string} relPath
 * @returns {string | undefined}
 */
function committedVersion(relPath) {
  try {
    return execFileSync('git', ['show', `HEAD:${relPath}`], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch {
    return undefined;
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
 * @returns {Array<{resourceType: string, client: string, installed: string, latest: string, behind: boolean}>}
 */
export function buildSdkLag(divergences, clientsFor, versionLag = sdkVersionLag) {
  /** @type {Array<{resourceType: string, client: string, installed: string, latest: string, behind: boolean}>} */
  const out = [];
  /** @type {Map<string, {installed: string, latest: string, behind: boolean} | undefined>} */
  const byClient = new Map();
  const emitted = new Set();
  for (const d of divergences) {
    // A case divergence needs no judgement — the SDK models the key under
    // another capitalisation — so it never justifies a network call.
    if (d.bucket === 'case-divergence') continue;
    for (const { client, version } of clientsForType(d.resourceType, clientsFor(d.resourceType))) {
      if (!byClient.has(client)) byClient.set(client, versionLag(client, version));
      const lag = byClient.get(client);
      // One row per (type, client): several divergences routinely land on the
      // same type, and repeating its row reads as several findings.
      const key = `${d.resourceType}\u0000${client}`;
      if (lag && !emitted.has(key)) {
        emitted.add(key);
        out.push({ resourceType: d.resourceType, client, ...lag });
      }
    }
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const readArg = (/** @type {string} */ flag) => {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) return '';
    const path = args[i + 1];
    return existsSync(path) ? readFileSync(path, 'utf8') : '';
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
  const declared = parseDeclaredProperties(
    existsSync(join(REPO_ROOT, 'src/provisioning/property-coverage.generated.ts'))
      ? readFileSync(join(REPO_ROOT, 'src/provisioning/property-coverage.generated.ts'), 'utf8')
      : ''
  );

  /** @type {RemovedEntry[]} */
  const removed = [];
  /** @type {AddedEntry[]} */
  const writableAdded = [];
  let readOnlyAddedCount = 0;

  for (const file of readdirSync(FIXTURES_DIR).filter(
    (f) => f.endsWith('.json') && !f.startsWith('_')
  )) {
    const relPath = `tests/fixtures/cfn-schemas/${file}`;
    const committed = committedVersion(relPath);
    if (committed === undefined) continue; // Brand-new fixture: nothing to compare.
    let delta;
    let resourceType;
    try {
      delta = comparePropertySets(committed, readFileSync(join(FIXTURES_DIR, file), 'utf8'));
      resourceType = JSON.parse(committed).resourceType ?? file;
    } catch {
      continue; // An unparseable side is the refresh's problem, not the report's.
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
        candidates[property] = findDeclarationCandidates(property, providerRelPath, resourceType);
        sdk[property] = sdkModelsMember(property, providerRelPath);
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

  const readNumArg = (/** @type {string} */ flag) => {
    const i = args.indexOf(flag);
    if (i === -1 || i + 1 >= args.length) return 0;
    const n = Number(args[i + 1]);
    return Number.isFinite(n) ? n : 0;
  };
  const nestedKey = parseNestedKeyDivergences(
    readArg('--nested-key-log'),
    readNumArg('--nested-key-rc')
  );
  const divergences = nestedKey.divergences;
  const skipped = readArg('--skipped-log')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^AWS::/.test(l));

  // Version lag is asked only when a divergence needs it — never on the happy
  // path — and for EVERY divergent type's clients rather than the first one's
  // first import. Each distinct client is asked once; the failure of any single
  // lookup is silent by construction and shows up as an absent row, which the
  // rendered section names as UNKNOWN rather than ruled out.
  const sdkLag = buildSdkLag(divergences, (t) => sdkClientVersions(providerFiles.get(t)));

  process.stdout.write(
    renderDiagnosis({
      removed,
      writableAdded,
      readOnlyAddedCount,
      divergences,
      nestedKeyUnparsed: nestedKey.unparsedFailure,
      skipped,
      sdkLag,
    }) + '\n'
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    // A broken diagnosis must never take down the PR it describes.
    process.stdout.write(
      `_The automated diagnosis failed to run (${
        err instanceof Error ? err.message : String(err)
      }). Read the CI log for the failing checks._\n`
    );
  }
}
