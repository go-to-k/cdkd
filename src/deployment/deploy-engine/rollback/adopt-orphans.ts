/**
 * The journal redaction of an attempt's operations and the re-adoption of rollback orphans.
 * One module, since both read the per-engine `adoptedOrphanRecords` map.
 * Split out of `deploy-engine/rollback.ts` (go-to-k/cdkd#5835), which
 * re-exports what it exported.
 */
import { explicitNamePropertyFor } from '../../../provisioning/resource-name.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import { displayIdent, displaySafe, safeMsg } from '../../../utils/display-safe.js';
import {
  type OrphanAdoptionOutcome,
  makeSiblingClaimReader,
  planOrphanAdoption,
} from '../../orphan-adoption.js';
import type { CompletedOperation, FailedOperation } from '../../rollback-executor.js';
import { withPrintingSecrets } from '../../resource-secrets-scope.js';
import { orphanRecordsPrintingBag } from '../../secret-name-needles.js';
import { keepPersistedPlainRecordLeaves } from '../../rollback-executor/replay-secrets.js';
import { applyNoEchoPersist, noEchoPositionSources } from '../noecho.js';
import {
  isSameGenerationBag,
  redactionClaimOf,
  maskSecretsInText,
  redactForState,
  scrubResourceRecord,
  maskAtCoordinates,
  noEchoCoordinatesOf,
} from '../../secret-redaction.js';
import type { RollbackDeps } from './deps.js';

export function redactOperationsForJournal<T extends CompletedOperation | FailedOperation>(
  deps: RollbackDeps,
  operations: T[]
): T[] {
  return operations.map((op) => {
    const secrets = deps.secretsRun().perResourceSecrets.get(op.logicalId);
    const templateProps = deps.secretsRun().perResourceTemplateProps.get(op.logicalId);
    // `previousState` is redactable with NO secrets map at all (#1900), so the
    // early return has to let that case through or the whole state-sourced
    // half is dead code.
    // go-to-k/cdkd#4043 (review B3): the positional `NoEcho` arm needs no
    // secrets, so a bag positioned by this deploy's template is masked even
    // when the resource recorded none.
    const sources =
      templateProps === undefined ? undefined : noEchoPositionSources(deps.noEchoRun());
    const byPosition = <B>(bag: B): B =>
      sources === undefined || templateProps === undefined
        ? bag
        : maskAtCoordinates(bag, noEchoCoordinatesOf(templateProps, bag, sources));
    if ((!secrets || secrets.size === 0) && !op.previousState && sources === undefined) return op;
    const ownSecrets = secrets ?? new Map<string, string>();
    const next = { ...op } as CompletedOperation & FailedOperation;
    if (next.properties) {
      // A COMPLETED op journals the record's own bag (`execute.ts`), which
      // `propertiesToRecord` marked same-generation when this pass resolved
      // it; the claim that mark carries is stated here (go-to-k/cdkd#5047), so
      // a sub-floor embedded secret keeps its token in the journal too.
      const properties = next.properties;
      next.properties = byPosition(
        templateProps === undefined
          ? redactForState(properties, { provenance: 'value-scan', secrets: ownSecrets })
          : redactForState(properties, {
              provenance: 'template-derived',
              secrets: ownSecrets,
              source: templateProps,
              // Leaf-certified `effectiveProperties` too (go-to-k/cdkd#5063).
              generation: redactionClaimOf(properties),
            })
      );
    }
    if (next.attemptedProperties) {
      // Issue #2516: a FAILED op's attempted bag is the resolver's own
      // output of today's template — the provider threw, so
      // `propertiesToRecord` never marked it — and this journal is a
      // persisted S3 artifact of its own, so it is walked under a
      // same-generation claim, the no-change re-check's pattern. The claim
      // marks nothing (go-to-k/cdkd#5047): `redactForState` walks a copy.
      const attempted = next.attemptedProperties;
      next.attemptedProperties = byPosition(
        templateProps === undefined
          ? redactForState(attempted, { provenance: 'value-scan', secrets: ownSecrets })
          : redactForState(attempted, {
              provenance: 'template-derived',
              secrets: ownSecrets,
              source: templateProps,
              generation: 'same-generation',
            })
      );
    }
    if (next.previousState) {
      // No `sourceProperties`: the previous record positions itself.
      //
      // `state-readback` is passed EXPLICITLY (issue #2886):
      // left to `scrubResourceRecord`'s derivation, an op whose resource
      // resolved nothing this deploy — a DELETE, an UPDATE with no reference
      // of its own — arrives here with an EMPTY map (the guard above admits
      // it whenever `previousState` exists) and would take the FAIL-CLOSED
      // baseline constant, masking every position the walk cannot certify in
      // this journal snapshot. `replayRollback` restores that record, so the
      // masks would land in `state.json` as permanent phantom drift on a
      // baseline that was intact before the deploy. The journal is a
      // REPLAYED baseline, not a fresh readback: its bag already sits in
      // `state.json`, so a mask here protects nothing a reader could still
      // be protected from and poisons the record a rollback rebuilds.
      //
      // The same holds for the value scan (go-to-k/cdkd#4801): a plaintext
      // leaf of that record — a reader's copy of a secret-derived physical
      // name, such as a queue policy's `Queues` URL — stays as state holds it,
      // or the restore writes the reference where a provider addresses the
      // resource. "As state holds it" is the working map's record, except for
      // an id `adoptRollbackOrphans` adopted: there it is the orphan entry's
      // own `state`, since the adopted record's attributes merge a LIVE
      // readback and a key state never held must fall to the scan. So the
      // journal's `previousState` keeps no plaintext state did not hold, and
      // the restore's own keep (`redactRollbackRecord`) leans on exactly that.
      const previous = next.previousState;
      const adopted = adoptedOrphanRecords.get(deps.owner);
      const loaded = adopted?.has(op.logicalId) ? adopted.get(op.logicalId) : previous;
      // The `NoEcho` arms over the PREVIOUS record (review B3): its own
      // `noEchoLeaves` when it has them, else today's template positions for
      // the same logical id and type, so a pre-v11 record's plaintext does not
      // reach this journal on a failed migration deploy.
      next.previousState = applyNoEchoPersist(
        deps.noEchoRun(),
        deps.noEchoDeps(),
        op.logicalId,
        previous,
        keepPersistedPlainRecordLeaves(
          scrubResourceRecord(previous, ownSecrets, undefined, 'state-readback', {
            // go-to-k/cdkd#5047: a readback drained this deploy may sit on
            // the record; its mark is stated as the walk's claim.
            observed: isSameGenerationBag(previous.observedProperties)
              ? 'same-generation'
              : 'unproven',
          }),
          previous,
          loaded ?? {}
        ),
        undefined,
        {},
        undefined,
        true
      );
    }
    return next as unknown as T;
  });
}

/**
 * Per engine, the record state held for each id {@link adoptRollbackOrphans}
 * adopted: the orphan entry's own `state`, before the live readback's
 * attributes are merged in (go-to-k/cdkd#4801). Read by
 * {@link redactOperationsForJournal}; an id absent here was not adopted.
 */
const adoptedOrphanRecords = new WeakMap<object, Map<string, ResourceState | undefined>>();

/**
 * Re-adopt what a previous rollback left in AWS, before the diff runs
 * (issue #2934).
 *
 * MUTATES `currentState`: adopted records go into `resources` so the diff
 * sees them, and `orphans` is replaced by the surviving set so every save
 * on every path below persists the same object. Mutation rather than a
 * returned copy because `currentState` is read by ~a dozen later sites and
 * threading a second binding through all of them is how one gets missed.
 *
 * Refusals THROW. A record whose name this deploy is about to request, that
 * cdkd cannot vouch for, is exactly the go-to-k/cdkd#2916 situation: letting
 * the deploy run would collide and roll back anyway, adding another orphan
 * on the way.
 */
export async function adoptRollbackOrphans(
  deps: RollbackDeps,
  currentState: StackState,
  effectiveTemplate: CloudFormationTemplate
): Promise<OrphanAdoptionOutcome> {
  const records = currentState.orphans ?? [];
  // go-to-k/cdkd#3869: the planner's own lines (a vanished record's debug
  // line, a provider `import()`'s existence check) print a kept record's id
  // before provisioning binds any printing bag, so they run under one judged
  // from every record, as the notices and the refusal below are masked.
  const named = orphanRecordsPrintingBag(records);
  const plan = await withPrintingSecrets(named, () =>
    planOrphanAdoption({
      records,
      // Read BEFORE the splice below, so a record whose resource this same
      // pass adopts is not also read as "already managed".
      managedLogicalIds: new Set(Object.keys(currentState.resources)),
      template: effectiveTemplate,
      stackName: currentState.stackName,
      region: deps.stackRegion,
      getProvider: (type, provisionedBy) =>
        deps.providerRegistry.getProviderFor({
          resourceType: type,
          ...(provisionedBy !== undefined && { provisionedBy }),
        }).provider,
      nameProperties: (type) => {
        const property = explicitNamePropertyFor(type);
        return property === undefined ? [] : [property];
      },
      readSiblingClaims: makeSiblingClaimReader({
        stateBackend: deps.stateBackend,
        selfStackName: currentState.stackName,
        selfRegion: deps.stackRegion,
        logger: deps.logger,
      }),
      logger: { debug: (m) => deps.logger.debug(m) },
      newScheme: currentState.stackInstanceId !== undefined,
    })
  );

  // `notices` and `refusals` arrive already rendered through `displaySafe` /
  // `displayIdent`: `planOrphanAdoption` sanitizes each state-chosen field
  // where it builds the string, because `cdkd diff` consumes the same lines
  // (go-to-k/cdkd#3642). Only the `Adopting` line below is built HERE, so it
  // is the one this function sanitizes.
  // go-to-k/cdkd#3869: the same bag masks these lines, a record named from a
  // secret (its name still a `{{resolve:` reference) by its id spellings. One
  // log-only bag over every record: a line names one record, and a sibling's
  // needle only over-masks. The thrown refusal too: it names the id and
  // carries no command, and the logical id beside it is what the user acts on.
  for (const notice of plan.notices) deps.logger.info(maskSecretsInText(notice, named));
  for (const warning of plan.warnings) deps.logger.warn(maskSecretsInText(warning, named));

  // go-to-k/cdkd#4801: for the journal's keep, what state held for each
  // adopted id. Installed BEFORE the refusal below, so a refused run never
  // leaves an earlier run's map behind.
  const adoptedFrom = new Map<string, ResourceState | undefined>();
  adoptedOrphanRecords.set(deps.owner, adoptedFrom);

  if (plan.refusals.length > 0) {
    throw new Error(
      safeMsg`Deploy refused — cdkd left ${plan.refusals.length} resource(s) in AWS that it cannot ` +
        'safely re-adopt:' +
        plan.refusals.map((r) => safeMsg`\n  ${maskSecretsInText(r, named)}`).join('')
    );
  }

  for (const [logicalId, record] of Object.entries(plan.adopted)) {
    // The entry the plan adopted (its `adopted` map is last-wins), read before
    // `orphans` is replaced below.
    adoptedFrom.set(logicalId, records.findLast((r) => r.logicalId === logicalId)?.state);
    currentState.resources[logicalId] = record;
    deps.logger.info(
      safeMsg`Adopting ${displayIdent(logicalId)} (${displayIdent(record.resourceType)}) left in AWS ` +
        safeMsg`by an earlier rollback as ${displaySafe(maskSecretsInText(record.physicalId, named))}`
    );
  }
  // Assigned unconditionally when there WERE records, so an adopted or
  // vanished one actually leaves the set. Left untouched when there were
  // none, so a stack that never orphaned keeps a byte-identical state.json.
  if (records.length > 0) currentState.orphans = plan.remaining;

  return plan;
}
