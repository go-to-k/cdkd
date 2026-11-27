/**
 * go-to-k/cdkd#7061: every write of a resource record to the state bucket goes
 * through the redaction choke point, or is classified as one that writes no
 * new value.
 *
 * THE POPULATION. Every reference, anywhere under `src/`, to a function that
 * writes a record bag (`properties`, `attributes`, `observedProperties`,
 * `outputs`) to S3: `saveState` (`state.json`), the rollback-journal writers
 * (`appendRollbackJournalSegment`, `setRollbackJournalFailedOperations`,
 * `rewriteRollbackJournalFailedOperations`), `putRawObject`, the raw put the
 * journal and the sidecars go through, and the exports index's writers
 * (`updateForStack`, `patchEntry`), which hold each export's value. Found by a real parser
 * (`_choke-point-sites.ts`), so a comment or a string is never a site. Each
 * site is keyed `<file>#<enclosing function>#<the value it writes>`, and each
 * key is classified in {@link SITES} with its count. A new writer, a moved one
 * or a second one in the same function fails here until it is classified; so
 * does an entry nothing matches any more.
 *
 * THE CLASSES, and what is checked mechanically for each:
 * - `redacted`: the written value is built by the engine's choke point,
 *   `withParentInfo` (which runs `redactStateForPersist`, and so
 *   `scrubResourceRecord` on every record) or `redactStateForPersist` itself.
 *   Checked on the AST: the written expression IS that call. An exports
 *   index write is `redacted` when its outputs bag is `redactOutputs`'s result.
 * - `scrubbed`: a writer outside the engine that puts NEW values into a bag
 *   (an AWS readback, an import, a replayed create). Each `via` names a
 *   function and the redactor (or the provenance refusal) it must call, and the
 *   fence checks that the function exists in that file and makes that call.
 * - `carry`: writes only records loaded from state (moved, renamed, removed,
 *   or with a marker or a physical id changed): no new bag value. Each says
 *   why. Not checkable by shape; the reviewer of the entry is the check.
 * - `no-record`: writes no resource bag at all (the deploy events, the create
 *   token ledger, the stack instance id sibling). Each says why.
 * - `definition`: the backend's own delegation to its module function.
 *
 * BOUNDS. The fence proves the population is classified and that each named
 * redactor call exists. It does not follow the written value back to that
 * call, nor check that the call's RESULT is used (a guard whose verdict is
 * ignored passes here; the behavioural tests beside each guard catch that).
 * It keys on the WRITER, so a new upstream PRODUCER that decides secrecy from
 * a value's text and feeds an already-classified writer is outside it: the
 * reader-side helper of #7061 is that class's fence. `callsIn` matches a
 * function by name within its file. Also outside: S3 copies of an object
 * already at rest (`state-migrate`'s `CopyObjectCommand`).
 * `observedProperties` has that dataflow critic
 * (`scripts/check-observed-properties-redaction.ts`); the engine's save sites
 * have the output-provenance fence (`fresh-read-save-output-provenance-7110`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import {
  ROOT,
  SRC,
  parseOrThrow,
  scanSites,
  sitesIn,
  walkNodes,
  type Found,
  type Node,
} from '../_choke-point-sites.js';

/** Each writer, keyed on the argument that carries the written value. */
const TARGETS: ReadonlyMap<string, number> = new Map([
  ['saveState', 2],
  // `scrub`'s exported save wrapper: a new caller of it writes a bag too.
  ['saveScrubbedState', 3],
  ['appendRollbackJournalSegment', 2],
  ['setRollbackJournalFailedOperations', 2],
  ['rewriteRollbackJournalFailedOperations', 2],
  ['putRawObject', 1],
  // The exports index holds each export's VALUE.
  ['updateForStack', 2],
  ['patchEntry', 1],
  ['writeIndex', 0],
  ['removeStack', 0],
  ['removeStackIfPresent', 0],
]);

/** The calls a `scrubbed` writer's `via` may name. */
const GUARDS = new Set([
  'scrubResourceRecord',
  'redactForState',
  'redactAtProvenance',
  'redactRollbackRecord',
  'redactOperationsForJournal',
  // `cdkd orphan` resolves no secret, so it has no needles to scrub with: it
  // refuses a secret-derived live attribute by provenance instead.
  'secretDerivedLiveAttribute',
  // ...and its `Ref` arm refuses a physical id carrying a credential.
  'secretPhysicalIdSegment',
]);

type Site = { count: number } & (
  | { kind: 'redacted'; by?: 'redactOutputs' }
  | { kind: 'scrubbed'; via: Array<{ at: string; calls: string }> }
  | { kind: 'carry'; why: string }
  | { kind: 'no-record'; why: string }
  | { kind: 'definition' }
);

const ENGINE = 'src/deployment/deploy-engine';
const JOURNAL = 'src/state/s3-state-backend/rollback-journal.ts';
const REPLAY_VIA = [
  { at: 'src/deployment/rollback-executor/replay-secrets.ts#redactRollbackRecord', calls: 'scrubResourceRecord' },
  { at: 'src/deployment/rollback-executor/replay-observed-refresh.ts#withRefreshedObservedBaseline', calls: 'scrubResourceRecord' },
];
const IMPORT_VIA = [
  { at: 'src/cli/commands/import/resolve-properties.ts#resolveImportedProperties', calls: 'redactForState' },
  { at: 'src/cli/commands/import/observed-capture.ts#captureObservedForImportedResources', calls: 'redactForState' },
];
const ORPHAN_VIA = [
  // Every `Fn::GetAtt` answer, recorded, live or `--force`'s cache, passes it first.
  { at: 'src/analyzer/orphan-rewriter/attribute-fetcher.ts#getAtt', calls: 'secretDerivedLiveAttribute' },
  { at: 'src/analyzer/orphan-rewriter/attribute-fetcher.ts#ref', calls: 'secretPhysicalIdSegment' },
];
const JOURNAL_EDIT = 'removes or marks operations of segments that appendRollbackJournalSegment already wrote redacted';
const CC_SETTLE = 'rewrites an operation already journaled: drops its pending request, sets the recovered physical id and provider';

/** `<file>#<enclosing function>#<written value>` -> its class. */
const SITES: Record<string, Site> = {
  // The engine: every save goes through `withParentInfo`.
  [`${ENGINE}/deploy-flow.ts#doDeployWithPrefetch#engine.withParentInfo(conditionVerdicts ? { ...newState, conditionVerdicts } : newState)`]:
    { kind: 'redacted', count: 1 },
  [`${ENGINE}/deploy-flow/no-change.ts#deployWithoutChanges#engine.withParentInfo(refreshedState)`]: { kind: 'redacted', count: 1 },
  [`${ENGINE}/execute.ts#executeDeploymentBody#engine.withParentInfo(preRollbackState)`]: { kind: 'redacted', count: 1 },
  [`${ENGINE}/execute.ts#savePartialState#engine.withParentInfo(partialState)`]: { kind: 'redacted', count: 1 },
  [`${ENGINE}/execute.ts#persistStateAfterOutputFailure#engine.withParentInfo(buildState())`]: { kind: 'redacted', count: 2 },
  [`${ENGINE}/execute/rollback-after-failure.ts#rollbackFailedDeploy#engine.withParentInfo(postRollbackState)`]: { kind: 'redacted', count: 2 },
  [`${ENGINE}/nested-cleanup.ts#persistDropped#engine.withParentInfo(next)`]: { kind: 'redacted', count: 1 },

  // The engine's rollback journal: completed and failed operations are redacted
  // before the segment is built.
  [`${ENGINE}/rollback/journal-write.ts#writeRollbackJournalSegment#segment`]: {
    kind: 'scrubbed',
    via: [{ at: `${ENGINE}/rollback/adopt-orphans.ts#redactOperationsForJournal`, calls: 'scrubResourceRecord' }],
    count: 1,
  },
  [`${ENGINE}/rollback/settle.ts#orphanUntakenResumes#<callback:de85a816ee>`]: { kind: 'carry', why: CC_SETTLE, count: 1 },
  ['src/deployment/cc-pending-requests.ts#settlePending#<callback:b57dbcdd81>']: { kind: 'carry', why: CC_SETTLE, count: 1 },

  // `cdkd scrub`: the whole point of the command; the save helper is handed
  // states its rewrite pass rebuilt.
  ['src/cli/commands/scrub/save-state.ts#saveScrubbedState#state']: {
    kind: 'scrubbed',
    via: [{ at: 'src/cli/commands/scrub/stack-rewrite.ts#scrubStackRewritePass', calls: 'scrubResourceRecord' }],
    count: 1,
  },
  // ...and its callers, so a new caller handing it an arbitrary bag is seen.
  ['src/cli/commands/scrub/stack-rewrite.ts#scrubStackRewritePass#nextState']: {
    kind: 'scrubbed',
    via: [{ at: 'src/cli/commands/scrub/stack-rewrite.ts#scrubStackRewritePass', calls: 'scrubResourceRecord' }],
    count: 1,
  },
  ['src/cli/commands/scrub/nested.ts#repairParentOutputAttributes#{ ...locked.state, ...stackInstanceIdCarriedFrom(locked.state), resources: { ...locked.state.resources, [parentRow.logicalId]: { ...row, attributes: locked.attributes }, }, lastModified: Date.now(), }']: {
    kind: 'carry',
    why: 'writes back the parent record read under its lock, changing only `Outputs.*` attributes it replaces with the child output expression that resolves to exactly the stored plaintext',
    count: 1,
  },
  // AWS readbacks written into `observedProperties`.
  ['src/cli/commands/state/refresh-observed-stack.ts#refreshObservedForStack#state']: {
    kind: 'scrubbed',
    via: [{ at: 'src/cli/commands/state/refresh-observed-stack.ts#refreshObservedForStack', calls: 'redactForState' }],
    count: 1,
  },
  ['src/cli/commands/drift/accept.ts#runAccept#newState']: {
    kind: 'scrubbed',
    via: [{ at: 'src/cli/commands/drift/accept.ts#runAccept', calls: 'redactForState' }],
    count: 1,
  },
  ['src/cli/commands/drift/revert.ts#runRevert#newState']: {
    kind: 'scrubbed',
    via: [
      { at: 'src/cli/commands/drift/revert-apply.ts#applyRevertUpdateInScope', calls: 'redactForState' },
      { at: 'src/cli/commands/drift/revert-apply.ts#recordReturnedIdentity', calls: 'redactForState' },
    ],
    count: 1,
  },
  ['src/cli/commands/drift/revert-attestation.ts#writeAheadRevertAttestations#state']: {
    kind: 'carry',
    why: 'strips the version attestation marker from loaded records',
    count: 1,
  },
  // `cdkd import`: readbacks become `properties`, `attributes` and the baseline.
  ['src/cli/commands/import/locked-import.ts#runLockedImport#stackState']: { kind: 'scrubbed', via: IMPORT_VIA, count: 1 },
  ['src/cli/commands/import/nested.ts#importNestedStackChildrenRecursive#childStackState']: {
    kind: 'scrubbed',
    via: IMPORT_VIA,
    count: 1,
  },
  // `cdkd rollback` and the nested child's revert: every record rebuilt from a
  // create / update result or a refreshed baseline.
  ['src/cli/commands/rollback/replay.ts#saveState#next()']: { kind: 'scrubbed', via: REPLAY_VIA, count: 2 },
  ['src/cli/commands/rollback/replay.ts#runRollbackReplay#<ref>']: {
    kind: 'carry',
    why: 'hands the local `saveState` closure above (classified) to the replay as its afterOp',
    count: 4,
  },
  ['src/cli/commands/rollback/replay.ts#set#ops']: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  ['src/deployment/nested-child-journal.ts#save#nextState()']: { kind: 'scrubbed', via: REPLAY_VIA, count: 2 },
  ['src/deployment/nested-child-journal.ts#recordChildTemplateDependencies#{ ...state, ...stackInstanceIdCarriedFrom(state), resources, lastModified: Date.now(), }']:
    { kind: 'carry', why: "rewrites only the loaded records' dependency lists", count: 1 },
  // `cdkd orphan` / `cdkd state orphan`: splices a sibling's `Fn::GetAtt`
  // answer into other records; a secret-derived live answer is refused.
  ['src/cli/commands/orphan.ts#orphanCommand#rewriteResult.state']: { kind: 'scrubbed', via: ORPHAN_VIA, count: 1 },
  ['src/cli/commands/state/orphan.ts#stateOrphanResources#rewriteResult.state']: { kind: 'scrubbed', via: ORPHAN_VIA, count: 1 },
  // Renames, moves and deletes of loaded records.
  ['src/cli/commands/refactor/apply.ts#applyStackRefactor#renamed']: {
    kind: 'carry',
    why: 'renames loaded records and rewrites references to the new logical ids',
    count: 1,
  },
  ['src/cli/commands/refactor-move.ts#save#state']: {
    kind: 'carry',
    why: 'renames loaded records and adds their construct path, template metadata',
    count: 1,
  },
  ['src/cli/commands/refactor-move.ts#finishPendingMoves#insertMovedRecords(dest.state, list, { Resources: {} })']: {
    kind: 'carry',
    why: 'moves loaded records into the destination stack',
    count: 1,
  },
  ['src/cli/commands/refactor-move.ts#finishPendingMoves#withoutMarks( leaving.length > 0 ? removeMovedRecords(source.state, leaving) : source.state, done )']:
    { kind: 'carry', why: 'removes moved records and their marks from the source stack', count: 1 },
  ['src/cli/commands/destroy-runner/under-lock.ts#destroyStackUnderLock#buildDestroySnapshot()']: {
    kind: 'carry',
    why: 'the loaded records minus the deleted ones, with outputs and exports emptied',
    count: 1,
  },
  ['src/cli/commands/destroy-runner/under-lock.ts#persistStateAfterDelete#buildDestroySnapshot()']: {
    kind: 'carry',
    why: 'the loaded records minus the deleted ones, with outputs and exports emptied',
    count: 1,
  },

  // The raw puts: the journal module's own edits, and stores holding no bag.
  [`${JOURNAL}#appendRollbackJournalSegment#JSON.stringify(journal, null, 2)`]: {
    kind: 'carry',
    why: 'appends the segment its caller built (classified above) to the loaded journal',
    count: 1,
  },
  [`${JOURNAL}#setRollbackJournalFailedOperations#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#dropRollbackJournalFailedOperations#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#rewriteRollbackJournalFailedOperations#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#reduceRollbackJournalToFailedOperations#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#popRollbackJournalSegment#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#markRollbackJournalSuperseded#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#markRollbackJournalImported#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  [`${JOURNAL}#dropRollbackJournalSegments#JSON.stringify(journal, null, 2)`]: { kind: 'carry', why: JOURNAL_EDIT, count: 1 },
  ['src/state/s3-state-backend/sidecars.ts#saveCreateTokenLedger#JSON.stringify(ledger, null, 2)']: {
    kind: 'no-record',
    why: 'the create-token ledger: logical ids, client tokens and a nonce',
    count: 1,
  },
  ['src/state/s3-state-backend/sidecars.ts#stackInstanceIdForFirstWrite#body']: {
    kind: 'no-record',
    why: "the stack instance id sibling: one minted id",
    count: 1,
  },
  ['src/state/deployment-events-store.ts#doFlush#body + \'\\n\'']: {
    kind: 'no-record',
    why: 'deployment events: errors and metadata, no resource properties (the store\'s own contract)',
    count: 1,
  },
  ['src/state/deployment-events-store.ts#writeIndexAndPrune#JSON.stringify(file, null, 2)']: {
    kind: 'no-record',
    why: 'the deployment events index: run ids and times',
    count: 1,
  },
  ['src/state/deployment-events-store.ts#rewriteIndexAfterPrune#JSON.stringify(file, null, 2)']: {
    kind: 'no-record',
    why: 'the deployment events index: run ids and times',
    count: 1,
  },
  ['src/assets/asset-storage/ensure.ts#ensureAssetStorage#JSON.stringify(marker, null, 2)']: {
    kind: 'no-record',
    why: 'the asset storage marker: a version and a time',
    count: 1,
  },

  // The exports index: each export's value.
  [`${ENGINE}/deploy-flow/success-settle.ts#settleSuccessfulDeploy#importableOutputs({ ...newState, outputs: redactOutputs(engine.maskingDeps(), newState.outputs), })`]:
    { kind: 'redacted', by: 'redactOutputs', count: 1 },
  [`${ENGINE}/deploy-flow/no-change.ts#deployWithoutChanges#importableOutputs({ ...refreshedState, outputs: redactOutputs(engine.maskingDeps(), refreshedState.outputs), })`]:
    { kind: 'redacted', by: 'redactOutputs', count: 1 },
  ['src/deployment/nested-child-journal.ts#revertNestedChildFromJournal#importableOutputs(nextState())']: {
    kind: 'carry',
    why: "publishes the child's outputs the revert restored from its journal, copied from state at rest",
    count: 1,
  },
  ['src/cli/commands/scrub/export-index.ts#repairExportIndexForStack#{ ...entry, value: finding.stateValue }']: {
    kind: 'carry',
    why: "re-publishes the value the producer's state record holds",
    count: 1,
  },
  ['src/deployment/intrinsic-resolver/cross-stack/import-value.ts#resolveImportValue#{ value, producerStack: refStack, producerRegion: lookupRegion, }']:
    { kind: 'carry', why: "indexes the value the scan read from the producer's state record", count: 1 },

  // The exports index store's own writes: entries rebuilt from, or removed
  // from, the producers' state at rest.
  ['src/state/export-index-store.ts#rebuild#next']: {
    kind: 'carry',
    why: "rebuilds every entry from the producers' state records at rest",
    count: 1,
  },
  ['src/state/export-index-store.ts#persist#file']: {
    kind: 'carry',
    why: 'writes the entries updateForStack / patchEntry / removeStack produced (each classified at its caller)',
    count: 1,
  },
  ['src/cli/region-options.ts#removeFromOther#stackName']: { kind: 'carry', why: "removes a stack's entries", count: 1 },
  ['src/cli/region-options.ts#get#stackName']: { kind: 'carry', why: "removes a stack's entries", count: 1 },
  ['src/cli/commands/destroy-runner/under-lock.ts#destroyStackUnderLock#stackName']: {
    kind: 'carry',
    why: "removes a destroyed stack's entries",
    count: 2,
  },

  // The backend's methods delegate to the module functions above.
  ['src/state/s3-state-backend.ts#saveState#<ref>']: { kind: 'definition', count: 1 },
  ['src/state/s3-state-backend.ts#putRawObject#<ref>']: { kind: 'definition', count: 1 },
  ['src/state/s3-state-backend.ts#appendRollbackJournalSegment#<ref>']: { kind: 'definition', count: 1 },
  ['src/state/s3-state-backend.ts#setRollbackJournalFailedOperations#<ref>']: { kind: 'definition', count: 1 },
  ['src/state/s3-state-backend.ts#rewriteRollbackJournalFailedOperations#<ref>']: { kind: 'definition', count: 1 },
};

/** Every site, with `extra` (repo-relative path -> text) overriding or adding files. */
function scan(extra: Record<string, string> = {}): { sites: Found[]; texts: Map<string, string> } {
  const abs: Record<string, string> = {};
  for (const [rel, text] of Object.entries(extra)) abs[join(ROOT, rel)] = text;
  return scanSites(TARGETS, SRC, abs);
}

/** Whether `<file>#<fn>` declares a function that calls `callee` (directly, or as a method). */
function callsIn(at: string, callee: string, extra: Record<string, string>): boolean {
  const [file, fn] = at.split('#') as [string, string];
  const text = extra[file] ?? readFileSync(join(ROOT, file), 'utf8');
  // The function's own sites of `callee`: the scanner keys each reference by
  // its enclosing named function.
  return sitesIn(new Map([[callee, 0]]), join(ROOT, file), text).some(
    (s) => s.fn === fn && s.saved !== '<ref>'
  );
}

function violations(extra: Record<string, string> = {}): string[] {
  const { sites } = scan(extra);
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const s of sites) counts.set(s.key, (counts.get(s.key) ?? 0) + 1);
  for (const [key, n] of counts) {
    const site = SITES[key];
    if (site === undefined) problems.push(`unclassified writer: ${key}`);
    else if (site.count !== n) problems.push(`${key}: ${n} sites, classified ${site.count}`);
  }
  for (const [key, site] of Object.entries(SITES)) {
    if (!counts.has(key)) problems.push(`classified writer gone: ${key}`);
    if (site.kind === 'redacted') {
      const saved = key.split('#').slice(2).join('#');
      const ok =
        site.by === undefined
          ? /^engine\.(?:withParentInfo|redactStateForPersist)\(/.test(saved)
          : // The exports index is fed the outputs bag only: its value is
            // built from the outputs redactor's result.
            new RegExp(`\\boutputs: ${site.by}\\(`).test(saved);
      if (!ok) problems.push(`${key}: a redacted writer must write the choke point's result`);
    }
    if (site.kind === 'scrubbed') {
      for (const { at, calls } of site.via) {
        if (!GUARDS.has(calls)) problems.push(`${key}: ${calls} is no redactor`);
        else if (!callsIn(at, calls, extra)) problems.push(`${key}: ${at} does not call ${calls}`);
      }
    }
  }
  return problems;
}

describe('every state writer goes through the redaction choke point (go-to-k/cdkd#7061)', () => {
  it('every writer is classified, and each redacted or scrubbed one reaches its redactor', () => {
    const { sites } = scan();
    // A floor the scan does not read: too few sites means a broken scan.
    expect(sites.length).toBeGreaterThanOrEqual(55);
    expect(violations()).toEqual([]);
  });

  it('each `via` is a real redactor call, not a reference', () => {
    // A bare reference (a function passed on, an import) is no call.
    expect(callsIn(`${ENGINE}/rollback/adopt-orphans.ts#redactOperationsForJournal`, 'scrubResourceRecord', {})).toBe(true);
    expect(callsIn(`${ENGINE}/rollback/adopt-orphans.ts#noSuchFunction`, 'scrubResourceRecord', {})).toBe(false);
  });

  // Self-probes: each hole the fence must close, injected into a copy of the
  // real file it would land in.
  const real = (rel: string): string => readFileSync(join(ROOT, rel), 'utf8');

  it('probe: a new writer in a CLI command fails until classified', () => {
    const rel = 'src/cli/commands/drift/accept.ts';
    const text =
      real(rel) +
      `\nexport async function acceptAgain(b: { saveState: Function }, s: unknown): Promise<void> {\n` +
      `  await b.saveState('s', 'r', { resources: { A: { properties: s } } });\n}\n`;
    expect(violations({ [rel]: text })).toEqual([
      `unclassified writer: ${rel}#acceptAgain#{ resources: { A: { properties: s } } }`,
    ]);
  });

  it('probe: an engine save that drops withParentInfo fails', () => {
    const rel = `${ENGINE}/deploy-flow/no-change.ts`;
    const text = real(rel).replace('engine.withParentInfo(refreshedState)', 'refreshedState');
    expect(text).not.toBe(real(rel));
    expect(violations({ [rel]: text })).toEqual([
      `unclassified writer: ${rel}#deployWithoutChanges#refreshedState`,
      `classified writer gone: ${rel}#deployWithoutChanges#engine.withParentInfo(refreshedState)`,
    ]);
  });

  it('probe: a scrubbed writer whose redactor call is removed fails', () => {
    const rel = 'src/deployment/rollback-executor/replay-secrets.ts';
    const text = real(rel).replace(/scrubResourceRecord\(/g, 'Object.assign(');
    expect(text).not.toBe(real(rel));
    const problems = violations({ [rel]: text });
    expect(problems).toContain(
      `src/cli/commands/rollback/replay.ts#saveState#next(): ${rel}#redactRollbackRecord does not call scrubResourceRecord`
    );
    expect(problems).toContain(
      `src/deployment/nested-child-journal.ts#save#nextState(): ${rel}#redactRollbackRecord does not call scrubResourceRecord`
    );
  });

  it('probe: an exports index write that drops redactOutputs fails', () => {
    const rel = `${ENGINE}/deploy-flow/success-settle.ts`;
    const text = real(rel).replace(
      'outputs: redactOutputs(engine.maskingDeps(), newState.outputs),',
      'outputs: newState.outputs,'
    );
    expect(text).not.toBe(real(rel));
    expect(violations({ [rel]: text })).toEqual([
      `unclassified writer: ${rel}#settleSuccessfulDeploy#importableOutputs({ ...newState, outputs: newState.outputs, })`,
      `classified writer gone: ${rel}#settleSuccessfulDeploy#importableOutputs({ ...newState, outputs: redactOutputs(engine.maskingDeps(), newState.outputs), })`,
    ]);
  });

  it("probe: the orphan fetcher's provenance refusal removed fails", () => {
    const rel = 'src/analyzer/orphan-rewriter/attribute-fetcher.ts';
    const text = real(rel).replace(
      'const secretDerived = secretDerivedLiveAttribute(orphan, attribute);',
      'const secretDerived = undefined as string | undefined;'
    );
    expect(text).not.toBe(real(rel));
    expect(violations({ [rel]: text })).toEqual([
      `src/cli/commands/orphan.ts#orphanCommand#rewriteResult.state: ${rel}#getAtt does not call secretDerivedLiveAttribute`,
      `src/cli/commands/state/orphan.ts#stateOrphanResources#rewriteResult.state: ${rel}#getAtt does not call secretDerivedLiveAttribute`,
    ]);
  });

  it("probe: the orphan fetcher's Ref refusal removed fails", () => {
    const rel = 'src/analyzer/orphan-rewriter/attribute-fetcher.ts';
    const text = real(rel).replace('if (secretPhysicalIdSegment(o.resourceType, o.physicalId) !== undefined) {', 'if (false) {');
    expect(text).not.toBe(real(rel));
    expect(violations({ [rel]: text })).toEqual([
      `src/cli/commands/orphan.ts#orphanCommand#rewriteResult.state: ${rel}#ref does not call secretPhysicalIdSegment`,
      `src/cli/commands/state/orphan.ts#stateOrphanResources#rewriteResult.state: ${rel}#ref does not call secretPhysicalIdSegment`,
    ]);
  });

  it('probe: an edit to a classified callback body is classified again', () => {
    const rel = 'src/deployment/cc-pending-requests.ts';
    const text = real(rel).replace("provisionedBy: 'cc-api',", "provisionedBy: 'cc-api', properties: {},");
    expect(text).not.toBe(real(rel));
    const problems = violations({ [rel]: text });
    expect(problems.some((p) => p.startsWith(`unclassified writer: ${rel}#settlePending#<callback:`))).toBe(true);
    expect(problems.some((p) => p.startsWith(`classified writer gone: ${rel}#settlePending#<callback:`))).toBe(true);
  });

  it('probe: a raw put of a new store fails until classified', () => {
    const rel = 'src/state/s3-state-backend/sidecars.ts';
    const text = real(rel) + `\nexport async function putBag(this: { putRawObject: Function }, b: object) {\n  await this.putRawObject('k', JSON.stringify(b));\n}\n`;
    expect(violations({ [rel]: text })).toEqual([
      `unclassified writer: ${rel}#putBag#JSON.stringify(b)`,
    ]);
  });

  it('probe: a comment, a string or a type naming a writer is no site', () => {
    const rel = 'src/state/zz-probe.ts';
    const text =
      `// b.saveState('s', 'r', x)\nconst S = "b.saveState('s', 'r', y)";\n` +
      `type T = Pick<{ saveState(): void }, 'saveState'>;\n`;
    expect(violations({ [rel]: text })).toEqual([]);
  });

  it('the parser reads every file it is handed', () => {
    expect(() => parseOrThrow('x.ts', 'const = ;')).toThrow(/cannot parse/);
    let n = 0;
    walkNodes(parseOrThrow('x.ts', 'f(1)') as Node, () => n++);
    expect(n).toBeGreaterThan(1);
  });
});
