import { type DeployEngine } from '../../deploy-engine.js';
import { resolveDynamicReferences } from '../../intrinsic-resolver/dynamic-refs.js';
import type { ProvisionCounts } from '../../deploy-engine.js';
import { readReaderForFreshNoEchoCeiling, secretNameBagFor } from '../masking.js';
import { extractTemplateAttributes } from '../record-shape.js';
import {
  withoutAcceptedSdkUnwiredProperties,
  withoutUnwrittenSdkUnwiredProperties,
} from '../../../provisioning/property-coverage.js';
import { getCreateOnlyPropertyPaths } from '../../../provisioning/create-only-properties.js';
import type { CloudFormationTemplate } from '../../../types/resource.js';
import {
  acceptedCreateOnlyDropsOf,
  type ResourceChange,
  type ResourceState,
} from '../../../types/state.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { formatResourceLine } from '../../../utils/resource-line.js';
import { type FreshNoEchoReadback, keyOrderFreeJson } from '../../deploy-value-equality.js';
import {
  SECRET_MASK,
  carriesSecretMask,
  freshNoEchoLeafPositions,
  type FreshNoEchoLeaf,
  maskAtCoordinates,
  withoutPhysicalNameCopies,
  repairPhysicalNameCopyLeaves,
  embeddedPhysicalNameRewrites,
  replaceEmbeddedPhysicalNameRewrites,
  overlapRuleAnswered,
  withLegacyOverlapScan,
  mixedLiteralAnswered,
  withLegacyMixedScan,
  differingStringLeaves,
  replaceWholeLeaves,
  legacyReferenceLeavesOnly,
  legacyLeavesWithoutMask,
  repairEmbeddedPhysicalNamesTowards,
  physicalNameCopiesOf,
  noEchoLeavesOf,
  redactForState,
  valueAtCoordinate,
  witnessNormalize,
  withoutNoEchoParameterEntries,
} from '../../secret-redaction.js';
import {
  confirmValueMoves,
  readProvenanceMovedPaths,
  sameValueAtVersions,
} from '../read-provenance-moved.js';
import {
  persistedTokenResolverContext,
  resolveRecordSecrets,
} from '../../masked-baseline-recapture.js';
import { getCurrentProducerRegions } from '../../producer-regions-scope.js';
import {
  echoFidelityCandidates,
  noEchoExactEchoLeavesOf,
  noteNoEchoExactEchoes,
  provesEchoChangeAt,
} from '../noecho.js';
import { unsettledPropertiesOf } from '../../../state/unsettled-properties.js';
import {
  scalarLeavesOf,
  recordPreviousNoEchoLeaves,
  recordHoldsEmbeddedReference,
  redactionRewrittenPaths,
  readsProducerReplacedThisRun,
} from './helpers.js';
import type { ResolvedUpdateInputs } from './resolve-inputs.js';

/**
 * The second phase of `provisionUpdate`: the record compared with the desired
 * bag (legacy repairs, the migration witness, the fresh `NoEcho` leaves, the
 * skip predicates and the one readback). Split out of `deploy-engine/update.ts`
 * (go-to-k/cdkd#5835); the statements run in their original order.
 */
export async function compareWithRecord(
  engine: DeployEngine,
  logicalId: string,
  change: ResourceChange,
  stateResources: Record<string, ResourceState>,
  template: CloudFormationTemplate | undefined,
  counts: ProvisionCounts | undefined,
  progress: { current: number; total: number } | undefined,
  resolved: ResolvedUpdateInputs
) {
  const {
    resourceType,
    renderer,
    currentResource,
    desiredProps,
    currentProps,
    updateSecrets,
    resolvedProps,
    noEchoSources,
    parameterCoordinates,
    attributeCoordinates,
    staleCoordinates,
    comparisonCoordinates,
    movedMasked,
  } = resolved;
  const desiredForSkipCheck = maskAtCoordinates(
    redactForState(resolvedProps, {
      provenance: 'template-derived',
      secrets: updateSecrets,
      source: desiredProps,
      generation: 'same-generation',
    }),
    comparisonCoordinates
  );
  // go-to-k/cdkd#4810: a record written before the persist walk kept a read
  // physical id's copy in plaintext holds that copy rewritten into its
  // `{{resolve:` form. Repaired here, before anything compares or sends it:
  // left as it is, the copy reads as MOVED (a create-only one REPLACED the
  // reader with no template change) and reaches the provider as a previous
  // value (an SQS queue policy cleared `https://sqs.../{{resolve:...}}`).
  // Position-wise against what today's value persisted the old way, so a
  // literal reference the template spells is never touched; a provider's
  // recorded attribute has no desired side and takes the embedded spellings
  // only. The repaired record is what this deploy persists.
  const legacyDesired = withoutPhysicalNameCopies(updateSecrets, () =>
    maskAtCoordinates(
      redactForState(resolvedProps, {
        provenance: 'template-derived',
        secrets: updateSecrets,
        source: desiredProps,
        generation: 'same-generation',
      }),
      comparisonCoordinates
    )
  );
  // The legacy spellings come from today's bag, plus (review M2 on PR #4817)
  // from the RECORD's own references resolved into a map of their own: the
  // secret that rewrote the copy may no longer be one today's template reads
  // (a literal reference since removed). Only for a record that read some
  // physical id and holds an embedded reference; the resolver caches each
  // reference's lookup. Resolved with the stack's producer-region evidence, as
  // the masked-baseline re-capture is: a region-less reference this stack may
  // have read from another region refuses (all or nothing: no map) rather than
  // answering from a same-named secret here; with no complete evidence there
  // is no lookup. For a PROPERTIES leaf a wrong answer still repairs nothing
  // (the equal-to-today guard below); the map persists and decides nothing else.
  const copies = physicalNameCopiesOf.get(updateSecrets);
  const regionEvidence = getCurrentProducerRegions()?.();
  const recordOwnSecrets =
    copies !== undefined &&
    copies.size > 0 &&
    regionEvidence?.complete === true &&
    recordHoldsEmbeddedReference(currentResource)
      ? await resolveRecordSecrets(
          { properties: currentResource.properties, attributes: currentResource.attributes },
          (token, own) =>
            resolveDynamicReferences(
              engine.resolver,
              token,
              persistedTokenResolverContext(own, regionEvidence.regions)
            )
        )
      : undefined;
  const embeddedRewrites = [
    ...embeddedPhysicalNameRewrites(updateSecrets),
    ...(recordOwnSecrets === undefined || recordOwnSecrets.size === 0
      ? []
      : embeddedPhysicalNameRewrites(updateSecrets, recordOwnSecrets)),
  ];
  // A record whose `properties` bag went missing (a hand edit) has nothing to repair.
  const repairable = [currentProps, currentResource.properties].filter(
    (bag): bag is Record<string, unknown> => bag !== null && typeof bag === 'object'
  );
  for (const bag of new Set(repairable)) {
    for (const key of Object.keys(bag)) {
      // A properties leaf takes an embedded spelling only where that makes it
      // equal today's: the spelling was the whole difference.
      const repaired = repairEmbeddedPhysicalNamesTowards(
        repairPhysicalNameCopyLeaves(bag[key], legacyDesired[key], desiredForSkipCheck[key]),
        desiredForSkipCheck[key],
        embeddedRewrites
      );
      if (repaired !== bag[key]) bag[key] = repaired;
    }
  }
  // go-to-k/cdkd#4986: a record a pre-fix cdkd wrote can hold an overlapping
  // leaf in its leftmost-first spelling (`{{resolve:A}}` + the rest of B in
  // plaintext). Compared with today's `***` it reads as MOVED, so an
  // unchanged template would send an UPDATE (a REPLACEMENT on a create-only
  // property) where CloudFormation sends nothing. A leaf equal to what the old
  // walk persisted for TODAY's value is that value unchanged: it takes
  // today's spelling, which this deploy persists, with no send. A real edit
  // changes today's value, so the old spelling no longer matches and it is
  // sent. Only where today's walk took the overlap rule, so no other deploy
  // pays for the second walk. The legacy bag can hold plaintext: a
  // comparison key, never persisted (each leaf written is today's).
  if (overlapRuleAnswered(updateSecrets)) {
    const legacyOverlapBag = withLegacyOverlapScan(updateSecrets, () =>
      maskAtCoordinates(
        redactForState(resolvedProps, {
          provenance: 'template-derived',
          secrets: updateSecrets,
          source: desiredProps,
          generation: 'same-generation',
        }),
        comparisonCoordinates
      )
    );
    // Only a leaf the old walk spelled with a reference: never a stored `***`.
    const legacyOverlap = legacyReferenceLeavesOnly(legacyOverlapBag) as Record<string, unknown>;
    for (const bag of new Set(repairable)) {
      for (const key of Object.keys(bag)) {
        const repaired = repairPhysicalNameCopyLeaves(
          bag[key],
          legacyOverlap[key],
          desiredForSkipCheck[key]
        );
        if (repaired !== bag[key]) bag[key] = repaired;
      }
    }
    // The same spelling in the record's `attributes` / `observedProperties`
    // (the save redacted them with the same map): whole leaves only.
    const pairs = differingStringLeaves(legacyOverlap, desiredForSkipCheck);
    for (const field of ['attributes', 'observedProperties'] as const) {
      const target = currentResource[field];
      if (target === undefined || target === null || pairs.length === 0) continue;
      for (const key of Object.keys(target)) {
        const repaired = replaceWholeLeaves(target[key], pairs);
        if (repaired !== target[key]) target[key] = repaired;
      }
    }
  }
  // go-to-k/cdkd#5056, the same repair for a literal embedding a short
  // secret beside a PUBLIC ssm token: a pre-fix cdkd persisted it as the
  // value scan left it, the secret in plaintext. A leaf equal to what that
  // walk persisted for TODAY's value is today's value unchanged, so it takes
  // today's spelling with no send; anything else is a real edit. Only where
  // today's walk took the mixed arm, so a deploy of a resource without such a
  // leaf pays nothing; one with it pays a second, CPU-only walk on every
  // update, as #4986's does. A legacy leaf holding a mask is left out: it
  // matches whatever masked value it hides, a rotated one included. The
  // legacy bag can hold plaintext: a comparison key, never persisted.
  if (mixedLiteralAnswered(updateSecrets)) {
    const legacyMixed = legacyLeavesWithoutMask(
      withLegacyMixedScan(updateSecrets, () =>
        maskAtCoordinates(
          redactForState(resolvedProps, {
            provenance: 'template-derived',
            secrets: updateSecrets,
            source: desiredProps,
            generation: 'same-generation',
          }),
          comparisonCoordinates
        )
      )
    ) as Record<string, unknown>;
    for (const bag of new Set(repairable)) {
      for (const key of Object.keys(bag)) {
        const repaired = repairPhysicalNameCopyLeaves(
          bag[key],
          legacyMixed[key],
          desiredForSkipCheck[key]
        );
        if (repaired !== bag[key]) bag[key] = repaired;
      }
    }
    const pairs = differingStringLeaves(legacyMixed, desiredForSkipCheck);
    for (const field of ['attributes', 'observedProperties'] as const) {
      const target = currentResource[field];
      if (target === undefined || target === null || pairs.length === 0) continue;
      for (const key of Object.keys(target)) {
        const repaired = replaceWholeLeaves(target[key], pairs);
        if (repaired !== target[key]) target[key] = repaired;
      }
    }
  }
  // IN PLACE, as the properties above: the rollback journal's `previousState`
  // is a shallow copy of this record, so both halves stay repaired together.
  const attributes = currentResource.attributes;
  if (attributes !== undefined && attributes !== null && embeddedRewrites.length > 0) {
    for (const key of Object.keys(attributes)) {
      const repaired = replaceEmbeddedPhysicalNameRewrites(attributes[key], embeddedRewrites);
      if (repaired !== attributes[key]) attributes[key] = repaired;
    }
  }
  const allowedSdkUnwired = engine.providerRegistry.getAllowedUnsupportedProperties?.();
  const desiredForSkipCheckAsWritten =
    currentResource.provisionedBy !== 'cc-api' && allowedSdkUnwired
      ? withoutAcceptedSdkUnwiredProperties(
          resourceType,
          desiredForSkipCheck,
          allowedSdkUnwired,
          currentResource.properties
        )
      : desiredForSkipCheck;
  // The allow set the diff narrowed by; a test double without the getter
  // reads as the flag-less deploy, as `cdkd diff` does. The diff decided
  // "accepted" over its best-effort resolution, this over the full one: an
  // UNRECOGNIZED key still behind an intrinsic there can answer differently
  // here, and then the diff carries no replacement row for the #2790 refusal
  // below to see. That needs a schema-unknown key behind an intrinsic on a
  // type with a create-only drop.
  const allowedForRecord = allowedSdkUnwired ?? new Set<string>();
  // The create-only drops this record PROVES were never sent (#2790); the
  // diff reads the same field, so both decide on the same evidence.
  const createOnlyEvidence = acceptedCreateOnlyDropsOf(currentResource);
  const recordedAsWritten =
    currentResource.provisionedBy === 'cc-api'
      ? currentProps
      : withoutUnwrittenSdkUnwiredProperties(
          resourceType,
          currentProps,
          desiredForSkipCheck,
          allowedForRecord,
          createOnlyEvidence
        );
  // go-to-k/cdkd#4043 (the MIGRATION WITNESS, review B2): a record no v11
  // binary wrote carries no `noEchoLeaves`, and where this deploy persists
  // `***` it may still hold the plaintext it last SENT. Compared with what the
  // persist walk writes WITHOUT the `NoEcho` arms (the dynamic-reference
  // form), an equal leaf is an unchanged value with no readback, and a
  // different one a change the comparison below sees as moved.
  const unmarkedRecord = noEchoLeavesOf(currentResource) === undefined;
  // For a MARKED record too (go-to-k/cdkd#4831): it can still hold a
  // plaintext where today's template masks, a leaf a `NoEcho` declaration
  // reaches only since that write. A leaf it holds as `***` is no witness
  // (`witnessNormalize` leaves it), so a fully-v11 record reads as before.
  // Where the witness compares depends only on the stored and persisted
  // shapes, so a probe with no reference answers whether it can say anything
  // (every such leaf reads as differing), by the witness's own shape rules.
  const witnessCanSpeak =
    unmarkedRecord ||
    witnessNormalize(recordedAsWritten, undefined, desiredForSkipCheckAsWritten).differing.length >
      0;
  const todayAsWritten = witnessCanSpeak
    ? redactForState(resolvedProps, {
        provenance: 'template-derived',
        secrets: withoutNoEchoParameterEntries(updateSecrets),
        source: desiredProps,
        generation: 'same-generation',
      })
    : undefined;
  const witness =
    todayAsWritten === undefined
      ? undefined
      : witnessNormalize(recordedAsWritten, todayAsWritten, desiredForSkipCheckAsWritten);
  const currentPropsAsWritten =
    witness === undefined ? recordedAsWritten : (witness.current as Record<string, unknown>);
  // A deploy that MIGRATES a leaf to the mask on the witness's word: a
  // pre-v11 record, or a marked one whose plaintext the witness confirmed
  // (go-to-k/cdkd#4831). Its readback is handed the mask at every parameter
  // coordinate (#4656 rule 1), and its migration readback is taken even when
  // nothing else reads (an earlier mark from a held producer's `NoEcho`
  // attribute supplies nothing fresh), so the echo fidelity a later change
  // of that value needs is recorded.
  const witnessMigrates = unmarkedRecord || (witness?.confirmed.length ?? 0) > 0;
  // A MARKED record keeps its own `noEchoLeaves` on a save it was not written
  // by (`noEchoLeavesFor`), so a leaf the witness CONFIRMED here is named for
  // that save: its stored plaintext equals today's value, so the mask and the
  // marker describe it exactly (go-to-k/cdkd#4831). Only a confirmed leaf: a
  // differing one keeps the old plaintext the record holds until it is sent.
  if (!unmarkedRecord && witness !== undefined && witness.confirmed.length > 0) {
    engine.noEchoRun.witnessConfirmedLeaves.set(
      logicalId,
      witness.confirmed.map((coordinate) => [...coordinate])
    );
  }
  // go-to-k/cdkd#4741: a witness that DIFFERS keeps the record's stored
  // plaintext, the PREVIOUS value of a `NoEcho` position, on the side handed
  // to the provider as the previous properties (and to a replacement's
  // delete), and no bag knew it. It goes into this resource's PRINT-ONLY bag,
  // the derived-name registry `provisionResource` binds around the whole
  // resource body: every log line there (a provider's own included), the
  // resource's errors and its events mask it. Not into `updateSecrets`, which
  // persisting and deciding readers walk (the fingerprint refusal, a nested
  // child's inherited bag). A shape-moved coordinate names a whole list or
  // object, so only its leaves the desired side does not hold are recorded.
  // The log-only floor applies: a whole printed text equal to it is masked at
  // any length, an embedded occurrence only from `MIN_NEEDLE_LENGTH`
  // characters.
  for (const coordinate of witness?.differing ?? []) {
    const desiredAt = valueAtCoordinate(desiredForSkipCheckAsWritten, coordinate);
    recordPreviousNoEchoLeaves(
      secretNameBagFor(engine.secretsRun, logicalId),
      valueAtCoordinate(recordedAsWritten, coordinate),
      scalarLeavesOf(desiredAt),
      updateSecrets,
      desiredAt !== SECRET_MASK
    );
  }
  // The fresh `NoEcho` leaves, by class. The custom-resource class (a
  // handler's `Data`, a recovered output) keeps the go-to-k/cdkd#3729 table;
  // the PARAMETER class is read back whatever the property's replacement
  // class, and a create-only property it feeds is never replaced on a
  // readback's word (maintainer decision on #4043) unless that readback is
  // proven exact (`noEchoExactEchoLeaves`, #4656).
  // A positional leaf of the attribute class: a value supplied in this run
  // that no needle keys (a `Number`, a value under the floor).
  const positionalLeavesAt = (
    coordinates: readonly (readonly (string | number)[])[],
    key: string
  ): FreshNoEchoLeaf[] =>
    coordinates
      .filter((coordinate) => coordinate[0] === key)
      .flatMap((coordinate) => {
        const plaintext = valueAtCoordinate(resolvedProps, coordinate);
        return plaintext === undefined || carriesSecretMask(plaintext)
          ? []
          : [{ path: coordinate.slice(1), plaintext }];
      });
  // The migration witness, per leaf: a pre-v11 record's stored plaintext at
  // the leaf equals what the dynamic-reference persist form holds there.
  const witnessConfirms = (key: string, leaf: FreshNoEchoLeaf): boolean => {
    if (todayAsWritten === undefined) return false;
    const full = [key, ...leaf.path];
    const stored = valueAtCoordinate(recordedAsWritten, full);
    return (
      stored !== undefined &&
      !carriesSecretMask(stored) &&
      keyOrderFreeJson(stored) === keyOrderFreeJson(valueAtCoordinate(todayAsWritten, full))
    );
  };
  const otherFreshAt = (key: string): FreshNoEchoLeaf[] => {
    const leaves = freshNoEchoLeafPositions(resolvedProps[key], updateSecrets, 'other');
    for (const leaf of positionalLeavesAt(attributeCoordinates, key)) {
      if (!leaves.some((known) => keyOrderFreeJson(known.path) === keyOrderFreeJson(leaf.path))) {
        leaves.push(leaf);
      }
    }
    // A pre-v11 reader of a declared attribute whose stored value is the
    // same is unchanged too (the witness covers both classes).
    return leaves.filter((leaf) => !witnessConfirms(key, leaf));
  };
  const pendingParameterLeaves = new Map<string, FreshNoEchoLeaf[]>();
  const addParameterLeaf = (key: string, leaf: FreshNoEchoLeaf): void => {
    if (witnessConfirms(key, leaf)) return; // the witness confirmed it
    const list = pendingParameterLeaves.get(key) ?? [];
    if (!list.some((known) => keyOrderFreeJson(known.path) === keyOrderFreeJson(leaf.path))) {
      list.push(leaf);
    }
    pendingParameterLeaves.set(key, list);
  };
  for (const key of Object.keys(resolvedProps)) {
    // A redacted read (the mask itself, out of a previous run's record) is
    // no value supplied in this deploy, which `positionalLeavesAt` skips.
    for (const leaf of positionalLeavesAt(parameterCoordinates, key)) addParameterLeaf(key, leaf);
    for (const leaf of positionalLeavesAt(staleCoordinates, key)) addParameterLeaf(key, leaf);
    for (const leaf of freshNoEchoLeafPositions(resolvedProps[key], updateSecrets, 'parameter')) {
      const covered = parameterCoordinates.some(
        (coordinate) =>
          coordinate[0] === key &&
          coordinate.length - 1 <= leaf.path.length &&
          coordinate.slice(1).every((segment, i) => segment === leaf.path[i])
      );
      if (!covered) addParameterLeaf(key, leaf);
    }
  }
  // A pre-v11 record whose stored plaintext DIFFERS from a `NoEcho` parameter
  // value this deploy supplies: exact evidence the value changed (maintainer
  // decision on #4043, design §9 item 6), so a create-only path it feeds is
  // replaced as before, and the replacement names that cause, never the value.
  // The cause a differing witness names (review round 9 m4): the PARAMETER's
  // value only where the position is a bare `Ref` to a `NoEcho` parameter, so
  // the stored value at it is exactly that parameter's last value. Any other
  // form (an `Fn::Sub` around it) may have moved for its template text alone.
  const witnessCauseAt = (key: string): 'parameter' | 'position' | undefined => {
    let cause: 'parameter' | 'position' | undefined;
    for (const coordinate of witness?.differing ?? []) {
      if (coordinate[0] !== key) continue;
      const rest = coordinate.slice(1);
      const pending = (pendingParameterLeaves.get(key) ?? []).some((leaf) => {
        const shorter = rest.length <= leaf.path.length ? rest : leaf.path;
        const longer = shorter === rest ? leaf.path : rest;
        return shorter.every((segment, i) => segment === longer[i]);
      });
      if (!pending) continue;
      const node = valueAtCoordinate(desiredProps, coordinate);
      const bareRef =
        node !== null &&
        typeof node === 'object' &&
        !Array.isArray(node) &&
        Object.keys(node).length === 1 &&
        typeof (node as Record<string, unknown>)['Ref'] === 'string' &&
        noEchoSources?.parameters.has((node as Record<string, string>)['Ref']!) === true;
      if (bareRef) return 'parameter';
      cause = 'position';
    }
    return cause;
  };
  const warnWitnessReplacement = (key: string): void => {
    const cause = witnessCauseAt(key);
    if (cause === undefined) return;
    engine.logger.warn(
      cause === 'parameter'
        ? safeMsg`${logicalId}.${key} is a create-only property, and a NoEcho parameter's value changed since the last deploy: ${logicalId} is replaced.`
        : safeMsg`${logicalId}.${key} is a create-only property, and the value at its NoEcho position changed since the last deploy: ${logicalId} is replaced.`
    );
  };
  const suppliesFreshMaskOnlyValue =
    pendingParameterLeaves.size > 0 ||
    Object.keys(resolvedProps).some((key) => otherFreshAt(key).length > 0);
  // What both no-change skips require of the bags: equal redacted values, and
  // no masked property whose template expression moved (go-to-k/cdkd#4451),
  // since `***` equals `***` whatever the edit. ONE predicate, so the two
  // skips cannot disagree on it.
  //
  // go-to-k/cdkd#4838: a `{{resolve:` reference does not say which value it
  // stood for. When a resource this one reads was REPLACED in this run (a new
  // physical id: a queue renamed after its secret rotated), a plaintext the
  // redaction rewrote can be the NEW generation's, and the equal reference
  // form then hides a value AWS does not hold (the reader kept the deleted
  // queue's ARN). Such a resource is sent, never skipped, and a create-only
  // path the redaction rewrote counts as MOVED, so a replacement it carries
  // stands.
  const rewrittenPaths = readsProducerReplacedThisRun(engine, template, logicalId, stateResources)
    ? redactionRewrittenPaths(resolvedProps, desiredForSkipCheck, comparisonCoordinates)
    : new Set<string>();
  // State schema v12 (go-to-k/cdkd#4852): the same, across runs. A path
  // holding a token at a read-derived leaf, served at read-route versions the
  // record's `readVersions` do not hold, MOVED whatever its reference form
  // says (an interrupted earlier deploy, a nested child, a cross-stack
  // consumer, a producer updated in place earlier). OR'd with the #4851 term.
  // A version move whose VALUE did not move (another key of a JSON secret
  // rotated) is no move: read at both versions and compared, only for a
  // reader whose versions moved. Such a reader's `readVersions` are refreshed
  // if it is skipped, so the next diff does not promote it again.
  const { moved: provenanceMoved, unchanged: provenanceUnchanged } = await confirmValueMoves(
    readProvenanceMovedPaths({
      record: currentResource,
      templateProperties: desiredProps,
      desiredRedacted: desiredForSkipCheck,
      secrets: updateSecrets,
    }),
    (entry, recordedVersion, servedVersion) =>
      sameValueAtVersions(engine.resolver, entry, recordedVersion, servedVersion, {
        template: template!,
        resources: stateResources,
      })
  );
  for (const path of provenanceMoved.paths) rewrittenPaths.add(path);
  if (provenanceMoved.paths.size > 0) {
    // Decision 5: the deploy names why a resource was sent. The ids and the
    // property names only, never a token or a version.
    engine.logger.info(
      safeMsg`${logicalId} is sent: ${[...provenanceMoved.paths].sort().join(', ')} read a secret-derived value at a newer version than ${logicalId} was deployed with (its upstream changed since then)`
    );
  }
  const recordMatchesDesired =
    movedMasked.size === 0 &&
    rewrittenPaths.size === 0 &&
    keyOrderFreeJson(desiredForSkipCheckAsWritten) === keyOrderFreeJson(currentPropsAsWritten);
  // The same three terms for ONE top-level key: its as-written value moved, or
  // a move its redacted form hides (a masked property whose template moved, a
  // rewritten or provenance-moved path).
  // go-to-k/cdkd#5380: a key an earlier failed update left unsettled may hold
  // either side in AWS, so the update is sent and the key counts as changed
  // whatever the two bags say. Not a "moved" value: no replacement verdict
  // below reads it, since the provider changed the key in place.
  const unsettledNames = unsettledPropertiesOf(currentResource);
  const movedAsWritten = (key: string): boolean =>
    movedMasked.has(key) ||
    rewrittenPaths.has(key) ||
    keyOrderFreeJson(desiredForSkipCheckAsWritten[key]) !==
      keyOrderFreeJson(currentPropsAsWritten[key]);
  // The metadata-only arm both no-change skips share: refresh the record's
  // template attributes and call no provider.
  const applyAttributeOnlyUpdate = (
    attributeChanges: NonNullable<typeof change.attributeChanges>
  ): void => {
    const attrSummary = attributeChanges
      .map((a) => `${a.attribute}: ${a.oldValue ?? '(unset)'} → ${a.newValue ?? '(unset)'}`)
      .join(', ');
    engine.logger.info(
      safeMsg`  ↻ ${logicalId} (${resourceType}) attribute update: ${attrSummary}`
    );
    stateResources[logicalId] = {
      // The record as the read-version refresh above may have left it.
      ...(stateResources[logicalId] ?? currentResource),
      ...extractTemplateAttributes(template, logicalId),
    };
    if (counts) counts.updated++;
    if (progress) progress.current++;
    const attrPrefix = progress ? `[${progress.current}/${progress.total}] ` : '  ';
    renderer.removeTask(logicalId);
    engine.logger.info(
      safeMsg`${attrPrefix}${formatResourceLine('updated', logicalId, resourceType, 'updated (metadata)')}`
    );
  };
  // The type's create-only paths (the committed snapshot when DescribeType
  // fails), read when a `NoEcho` parameter serves this bag.
  const schemaCreateOnly =
    pendingParameterLeaves.size === 0 && parameterCoordinates.length === 0
      ? []
      : await getCreateOnlyPropertyPaths(resourceType).catch(
          () => [] as ReadonlyArray<readonly string[]>
        );
  // go-to-k/cdkd#4656: the create-only `NoEcho` parameter coordinates whose
  // echo fidelity a readback may prove.
  const echoCandidates = echoFidelityCandidates(
    parameterCoordinates,
    resolvedProps,
    schemaCreateOnly
  );
  // The ONE readback of this resource for its `NoEcho` leaves, shared by every
  // block below. It hands the provider the RECORD, never the resolved bag. A
  // pre-v11 record still holds the plaintext it last sent, so it is handed a
  // copy with `***` at every `NoEcho` parameter coordinate (#4656, rule 1):
  // a provider that echoes its argument then reports the mask.
  const readbackRecord =
    witnessMigrates && parameterCoordinates.length > 0
      ? {
          ...currentResource,
          properties: maskAtCoordinates(currentResource.properties, parameterCoordinates),
        }
      : currentResource;
  let readback: Promise<FreshNoEchoReadback> | undefined;
  const readOnce = (): Promise<FreshNoEchoReadback> =>
    (readback ??= readReaderForFreshNoEchoCeiling(
      engine.maskingDeps(),
      logicalId,
      readbackRecord,
      updateSecrets
    ).then((read) => {
      // Every coordinate this read echoed exactly gains the flag; a differing
      // or failed one changes nothing.
      noteNoEchoExactEchoes(
        engine.noEchoRun,
        logicalId,
        currentResource.physicalId,
        read,
        readbackRecord.properties,
        echoCandidates,
        'add'
      );
      return read;
    }));
  // go-to-k/cdkd#4656: a create-only `NoEcho` parameter leaf this record's
  // provider was PROVEN to echo exactly (`noEchoExactEchoLeaves`), which the
  // readback now reports holding a different string: a change, not a
  // provider's normalization, so the path is replaced as before Phase B. Only
  // a whole-string leaf the record holds as `***` is eligible, as when the
  // flag was set (a value-arm leaf there would be a stale coordinate).
  const exactEchoCoordinates = new Set(
    (noEchoExactEchoLeavesOf(currentResource) ?? []).map((c) => JSON.stringify(c))
  );
  const provenChangedAt = (key: string, read: FreshNoEchoReadback | undefined): boolean => {
    if (exactEchoCoordinates.size === 0 || read === undefined || 'failure' in read) return false;
    return (pendingParameterLeaves.get(key) ?? []).some((leaf) => {
      const full = [key, ...leaf.path];
      if (!exactEchoCoordinates.has(JSON.stringify(full))) return false;
      const [candidate] = echoFidelityCandidates([full], resolvedProps, schemaCreateOnly);
      return (
        candidate !== undefined &&
        provesEchoChangeAt(read.live, readbackRecord.properties, candidate)
      );
    });
  };
  return {
    desiredForSkipCheck,
    desiredForSkipCheckAsWritten,
    allowedForRecord,
    createOnlyEvidence,
    witness,
    currentPropsAsWritten,
    witnessMigrates,
    otherFreshAt,
    pendingParameterLeaves,
    warnWitnessReplacement,
    suppliesFreshMaskOnlyValue,
    provenanceUnchanged,
    recordMatchesDesired,
    unsettledNames,
    movedAsWritten,
    applyAttributeOnlyUpdate,
    schemaCreateOnly,
    echoCandidates,
    readOnce,
    provenChangedAt,
  };
}

/** What {@link compareWithRecord} hands the later phases. */
export type ComparedUpdate = Awaited<ReturnType<typeof compareWithRecord>>;
