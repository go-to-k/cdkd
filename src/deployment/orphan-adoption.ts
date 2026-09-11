/**
 * Deploy-side consumption of {@link StackState.orphans} (issue #2934).
 *
 * A rollback that orphans a `DeletionPolicy: Retain` resource records what it
 * left behind. This module decides, BEFORE the diff runs, whether the next
 * deploy should re-adopt that resource instead of asking AWS for a name the
 * orphan still holds — which is the loop an external user reported in
 * go-to-k/cdkd#2902 and could only escape by hand-deleting through the AWS API.
 *
 * ## Why it runs before the diff rather than on the already-exists error
 *
 * `DiffCalculator` decides CREATE by ABSENCE from state (`if (!currentResource)`).
 * So adoption needs no branch in the create path and no new change type: put
 * the recorded `ResourceState` back into `currentState.resources` and the
 * ordinary diff produces an UPDATE (or NO_CHANGE) by itself.
 *
 * Keying on the already-exists ERROR instead would be per-type and would miss
 * the types that most need it. `AWS::SNS::Topic` raises nothing at all — AWS's
 * `CreateTopic` is idempotent and returns the existing topic — while
 * `AWS::S3::Bucket` and `AWS::Logs::LogGroup` raise errors cdkd already
 * swallows, and only `AWS::IAM::Role` actually fails the deploy. It would also
 * act only AFTER the CREATE had been issued.
 *
 * ## The record is evidence, not proof
 *
 * It says cdkd created SOMETHING under this name once. It cannot say the
 * current holder of that name is still that thing: a user who hand-deletes the
 * orphan frees a PREDICTABLE name, and for a globally-namespaced type someone
 * else can take it. So every record is re-verified against AWS before it is
 * acted on, and anything the checks cannot vouch for leaves the deploy alone.
 *
 * This module is import-light on purpose: it takes the provider registry and a
 * sibling-state reader as parameters rather than reaching for them, so the
 * decision can be tested without an engine.
 */

import type { CloudFormationTemplate, ResourceProvider } from '../types/resource.js';
import type { ResourceState, StackOrphanRecord } from '../types/state.js';
import { carriesSecretMask } from './secret-redaction.js';

/**
 * What the pre-pass decided. Every field is always present so a caller cannot
 * skip a half of it by reading a missing one as "nothing to do".
 */
export interface OrphanAdoptionOutcome {
  /** Records to splice into `currentState.resources`, keyed by logical id. */
  adopted: Record<string, ResourceState>;
  /** The record set to persist — minus anything adopted or found absent. */
  remaining: StackOrphanRecord[];
  /**
   * Reasons the deploy must STOP. Non-empty means cdkd holds a record for a
   * resource whose name this deploy is about to request, and could not
   * establish that adopting it is safe — proceeding would either collide
   * anyway or take a resource that is not ours.
   */
  refusals: string[];
  /**
   * One line per record that is KEPT but not adoptable this run (its logical id
   * left the template, or its type changed). Printed so a record can never be
   * present, blocking nothing, and invisible.
   */
  notices: string[];
}

/** Reads the physical ids every OTHER stack's state already claims. */
export type SiblingClaimReader = () => Promise<ReadonlySet<string>>;

/**
 * True when the template still declares `logicalId` with `resourceType` and
 * supplies no explicit physical name for it.
 *
 * In that shape the name this deploy would generate equals the recorded
 * `physicalId` BY CONSTRUCTION — `generateResourceName` is deterministic over
 * exactly (stack name, logical id), truncation included, with no random
 * component. That matters because the engine cannot DERIVE the name to compare:
 * the per-type `ResourceNameOptions` live in the providers, and
 * `looksLikeCdkdGeneratedName`'s own doc records that the engine does not know
 * which type maps to which.
 *
 * An explicitly named resource is never adopted here. Two different reasons
 * converge on that: a template-supplied name may belong to someone else
 * entirely, and if the user CHANGED the name there is no collision to solve —
 * the ordinary CREATE succeeds and the orphan simply stays behind.
 */
export function templateStillDeclares(
  template: CloudFormationTemplate,
  record: StackOrphanRecord,
  nameProperties: readonly string[]
): boolean {
  const declared = template.Resources?.[record.logicalId];
  if (!declared) return false;
  if (declared.Type !== record.state.resourceType) return false;
  const properties = (declared.Properties ?? {}) as Record<string, unknown>;
  // Any explicit name property disqualifies — including one carrying an
  // unresolved intrinsic, which cannot be compared here and is treated as a
  // mismatch. Falling through to CREATE is the safe direction: it either
  // succeeds (no collision) or fails with the go-to-k/cdkd#2916 diagnosis.
  return !nameProperties.some((p) => properties[p] !== undefined && properties[p] !== null);
}

/**
 * Types the allow-list admits but adoption must still refuse (issue #2934).
 *
 * The primary gate asks "does cdkd derive a name for this type", which is the
 * by-construction premise restated. `AWS::Lambda::LayerVersion` passes it —
 * `FALLBACK_NAME_RULES` carries `LayerName` — while its provider records the
 * `LayerVersionArn` as the physical id (`lambda-layer-provider.ts:143`), so the
 * premise is false for it anyway. `AWS::ECS::TaskDefinition` is here as a BELT:
 * it is absent from both name tables today, so the primary gate already refuses
 * it, and an entry added there later (its `Family` is a plausible one) would
 * silently re-admit a type round 5 proved harmful.
 *
 * **Membership is decided by the three CONSEQUENCES, never by the id's SHAPE.**
 * An earlier revision of this doc said "the provider records an AWS-minted
 * identifier while `explicitNamePropertyFor` answers" — and at least six
 * admitted types satisfy that: `AWS::SNS::Topic` (ARN), `AWS::Cognito::UserPool`
 * (`userPoolId`), both ELBv2 types, `AWS::StepFunctions::StateMachine`,
 * `AWS::ECS::Service`. A maintainer applying it would add SNS Topic — the
 * module header's own motivating type — and gut the feature. The tests are:
 *
 *   1. the create API mints a NEW resource instead of colliding on the name, so
 *      there is no loop to break;
 *   2. `update()` refuses outright, so an adopted resource's next change is a
 *      REPLACEMENT;
 *   3. that replacement's delete destroys the very copy `DeletionPolicy: Retain`
 *      preserved.
 *
 * All three, together. SNS Topic fails (1): `CreateTopic` returns the EXISTING
 * topic rather than minting a new one, which is exactly the shape adoption is
 * for — and is why the module header calls it the type that "raises nothing at
 * all".
 */
const ADOPTION_REFUSED_TYPES: ReadonlySet<string> = new Set([
  'AWS::Lambda::LayerVersion',
  'AWS::ECS::TaskDefinition',
]);

/**
 * Decide what to do with each orphan record, before the diff runs.
 *
 * Ordering is load-bearing: the AWS existence check runs for EVERY record,
 * INDEPENDENTLY of whether the template still declares it. The reverse order
 * left a record whose logical id had left the template never checked, so it
 * never dropped — present, blocking nothing, surfacing nowhere, and with no
 * per-record command to clear it.
 */
export async function planOrphanAdoption(params: {
  records: readonly StackOrphanRecord[];
  /**
   * The logical ids state already MANAGES. A record for one of these is stale
   * by definition — the resource is back under management, so there is nothing
   * to re-adopt.
   *
   * Reachable, and not only in theory: go-to-k/cdkd#2916's diagnosis tells the
   * user to run `cdkd import`, and `cdkd import` carries the record forward. So
   * a user who followed the printed advice ends up with the logical id in BOTH
   * bags, and without this the next deploy would splice the older orphan state
   * over the record the import just created.
   */
  managedLogicalIds: ReadonlySet<string>;
  template: CloudFormationTemplate;
  stackName: string;
  region: string;
  /**
   * Resolve the provider for a record.
   *
   * Takes the record's `provisionedBy`, not the type alone: `getProvider` reads
   * an absent value as SDK, and its own doc calls using it on a CC-managed
   * resource "the silent-data-corruption hazard that v7's schema bump is meant
   * to prevent". For a `cc-api` orphan the consequence is concrete — Cloud
   * Control stored the schema `primaryIdentifier` form of the physical id, an
   * SDK provider's `import()` expects its own form and answers `null`, and this
   * pre-pass would DROP the record as "no longer exists" while the resource is
   * live, reopening the very collision loop it exists to close.
   */
  getProvider: (
    resourceType: string,
    provisionedBy: ResourceState['provisionedBy']
  ) => ResourceProvider;
  /**
   * The template property that would supply an explicit physical name for this
   * type, or an EMPTY list when cdkd knows of none.
   *
   * It decides two things, and the second is easy to miss: an empty list means
   * the type is not adopted AT ALL. cdkd derives a name only for types it has a
   * rule for, and the adoption guard's premise is that the recorded physical id
   * IS the name the next deploy will request — so a type this cannot answer for
   * is one whose premise cannot be checked. Refusing costs a missed adoption;
   * proceeding cost a REPLACEMENT that destroyed a retained resource, three
   * times over.
   */
  nameProperties: (resourceType: string) => readonly string[];
  readSiblingClaims: SiblingClaimReader;
  logger: { debug: (m: string) => void };
}): Promise<OrphanAdoptionOutcome> {
  const outcome: OrphanAdoptionOutcome = {
    adopted: {},
    remaining: [],
    refusals: [],
    notices: [],
  };
  if (params.records.length === 0) return outcome;

  // Read once, and only when at least one record exists — the normal deploy
  // path (no records) must add no AWS calls at all. Lazily, because a record
  // that fails the cheaper checks never needs it.
  let siblingClaims: ReadonlySet<string> | undefined;
  const claims = async (): Promise<ReadonlySet<string>> =>
    (siblingClaims ??= await params.readSiblingClaims());

  for (const record of params.records) {
    const { logicalId, state } = record;

    // Already managed? Then the record describes a past that state has moved
    // on from — drop it, before any AWS call. Splicing over the live record
    // would replace it with an older snapshot of the same resource.
    if (params.managedLogicalIds.has(logicalId)) {
      params.logger.debug(
        `orphan ${logicalId}: already present in state.resources — dropping the stale record`
      );
      continue;
    }

    // Inside the try: `getProviderFor` can throw for a type this binary cannot
    // route (an `--allow-unsupported-types` resource redeployed without the
    // flag, say). Outside it, that throw would fail the whole deploy with a
    // message about a resource the user did not ask to touch, and leave no way
    // to clear the record — the brick this design refuses everywhere else.
    let provider: ResourceProvider;
    try {
      provider = params.getProvider(state.resourceType, state.provisionedBy);
    } catch (error) {
      outcome.remaining.push(record);
      outcome.notices.push(
        `${logicalId} (${state.resourceType}) is still in AWS as ${state.physicalId} from an ` +
          `earlier rollback, but this build cannot route that type ` +
          `(${error instanceof Error ? error.message : String(error)}) — cdkd is not adopting it.`
      );
      continue;
    }

    if (!provider.import) {
      // No way to verify existence or refresh attributes. Adopting blind would
      // splice a record whose attributes may be stale into the resource graph,
      // breaking a dependent's `Fn::GetAtt`; refusing outright would brick the
      // stack with no way to clear the record. Keep it and say so.
      outcome.remaining.push(record);
      outcome.notices.push(
        `${logicalId} (${state.resourceType}) was left in AWS by an earlier rollback as ` +
          `${state.physicalId}, but its provider cannot verify it — cdkd is not adopting it.`
      );
      continue;
    }

    // (b) Does it still exist? Runs for every record, whatever the template
    // says, so a resource the user deleted by hand always clears its record.
    let found;
    try {
      found = await provider.import({
        logicalId,
        resourceType: state.resourceType,
        stackName: params.stackName,
        region: params.region,
        properties: state.properties,
        knownPhysicalId: state.physicalId,
      });
    } catch (error) {
      // A throw is NOT absence. A throttle or a transient network failure that
      // dropped the record would lose the only trace of a live, billing
      // resource — so keep it and try again next run.
      // A NOTICE, not just a debug line. The deploy now walks straight into the
      // collision this record exists to prevent, and the only thing the user
      // would otherwise see is the go-to-k/cdkd#2916 diagnosis — which names the
      // orphan but not the fact that cdkd HELD the evidence and could not
      // confirm it. "Never present and invisible" has to hold on this arm too.
      outcome.notices.push(
        `${logicalId} (${state.resourceType}) is recorded as left in AWS as ${state.physicalId}, ` +
          `but cdkd could not confirm it exists ` +
          `(${error instanceof Error ? error.message : String(error)}) — keeping the record and ` +
          `not adopting it this run.`
      );
      outcome.remaining.push(record);
      continue;
    }
    if (found !== null && found.physicalId !== state.physicalId) {
      // A provider is contracted to treat `knownPhysicalId` as ground truth,
      // but nothing enforces it across ~74 implementations. One that searches
      // instead can vouch for a DIFFERENT resource, and adopting on that answer
      // puts someone else's resource under this stack's `cdkd destroy`.
      outcome.remaining.push(record);
      outcome.notices.push(
        `${logicalId} (${state.resourceType}): cdkd asked about ${state.physicalId} and its ` +
          `provider answered for ${found.physicalId} — not adopting.`
      );
      continue;
    }
    if (found === null) {
      params.logger.debug(
        `orphan ${logicalId}: ${state.physicalId} no longer exists in AWS — dropping the record`
      );
      continue;
    }

    // Adoption requires that cdkd NAMES this type — an ALLOW-list, and the
    // inversion is the point.
    //
    // This started as a deny-list of types whose physical id AWS mints rather
    // than cdkd deriving it, and three review rounds each added a member the
    // previous one had missed (`AWS::ECS::TaskDefinition`,
    // `AWS::Lambda::LayerVersion`, `AWS::ApiGateway::Deployment`), with 28
    // providers refusing `update()` still unwalked. A list nobody can finish is
    // the wrong shape for a guard whose failure mode is REPLACING a resource
    // `DeletionPolicy: Retain` preserved.
    //
    // The allow-list answers the question the by-construction premise actually
    // rests on: does `generateResourceName` decide this resource's name? A type
    // cdkd knows a name property for is one it names when the template does
    // not, so the recorded physical id IS the name the next deploy will ask
    // for. A type it does not know is either AWS-id-minted (adoption is wrong —
    // nothing collides, and the next change REPLACES) or simply absent from the
    // table (the premise is unverified). Both readings say refuse, so an
    // incomplete table now costs a missed adoption — go-to-k/cdkd#2916's
    // diagnosis still prints — instead of a deleted resource.
    //
    // Decided HERE rather than at the top of the loop: above the existence
    // check, the two arms that CLEAR a record become unreachable for refused
    // types, and the notice below would claim "still in AWS" with no AWS call
    // behind it.
    if (
      params.nameProperties(state.resourceType).length === 0 ||
      ADOPTION_REFUSED_TYPES.has(state.resourceType)
    ) {
      outcome.remaining.push(record);
      // Two arms, two reasons, and the shared sentence was FALSE on the
      // second: `AWS::Lambda::LayerVersion` sits in `FALLBACK_NAME_RULES`, so
      // telling its user cdkd "does not derive that resource's physical name"
      // contradicts the table.
      const why = ADOPTION_REFUSED_TYPES.has(state.resourceType)
        ? `a new deploy of it mints a new resource rather than colliding, and cdkd cannot ` +
          `update one in place — so adopting it would end in a replacement that destroys what ` +
          `DeletionPolicy: Retain preserved`
        : `cdkd does not derive that resource's physical name, so a new deploy mints a new ` +
          `resource instead of colliding`;
      outcome.notices.push(
        `${logicalId} (${state.resourceType}) is still in AWS as ${state.physicalId} from an ` +
          `earlier rollback. cdkd does not re-adopt this type: ${why}. Delete it yourself when ` +
          `you no longer need it.`
      );
      continue;
    }

    // (a) Is this deploy going to ask for that same name?
    if (
      !templateStillDeclares(params.template, record, params.nameProperties(state.resourceType))
    ) {
      outcome.remaining.push(record);
      outcome.notices.push(
        `${logicalId} (${state.resourceType}) is still in AWS as ${state.physicalId} from an ` +
          `earlier rollback. This deploy does not create it under that name, so cdkd is ` +
          `leaving it alone.`
      );
      continue;
    }

    // (d) Does another stack already manage this exact resource? Adopting it
    // would put one physical id in two state files, and either stack's
    // `cdkd destroy` would then delete the other's live resource.
    if ((await claims()).has(state.physicalId)) {
      outcome.refusals.push(
        `${logicalId}: ${state.physicalId} is already recorded by another cdkd stack. ` +
          `cdkd will not adopt a resource another stack manages.`
      );
      outcome.remaining.push(record);
      continue;
    }

    // (e) Adopt: the RECORDED state, with attributes refreshed from the
    // readback. Attributes are MERGED rather than replaced — a provider whose
    // `import()` reports a narrower set than `create()` did would otherwise
    // drop an attribute a dependent's `Fn::GetAtt` still resolves.
    //
    // Giving `found.attributes` precedence is wrong in a way that corrupts the
    // record it is meant to refresh: `CloudControlProvider.import` returns its
    // model through `maskUncertifiedModelValues`, which replaces every leaf it
    // cannot certify as an attribute with `SECRET_MASK` — the WHOLE model when
    // `DescribeType` is unavailable — so a `cc-api` orphan would be adopted
    // with `'***'` where a real `Arn` was, and that is what dependents then
    // resolve `Fn::GetAtt` against. A recorded value came from the actual create
    // and is preferred — but not unconditionally; the per-key rule below says
    // when it is not. Drift is `observedProperties`' job, not this merge's.
    //
    // A key carrying a mask ANYWHERE inside it is dropped, not merely
    // out-ranked — otherwise a key the record does not carry arrives as a mask
    // and nothing can out-rank it.
    //
    // `carriesSecretMask` is DEEP, and that is why it is the shared helper
    // rather than a local test: `maskUncertifiedModelValues` masks LEAVES
    // (`maskLeavesDeep` walks arrays and objects and PRESERVES the containers),
    // so the first cut's top-level `value === SECRET_MASK` passed
    // `Tags: [{ Key: '***' }]` and `Endpoint: { Address: '***' }` straight
    // through — with a comment claiming exactly the property it did not have.
    // With `DescribeType` unavailable EVERY leaf is masked, so that shallow
    // test admitted every container-valued key in the model.
    //
    // A whole key is dropped, not just its masked leaves: handing the record a
    // container that LOOKS complete and is missing members reads as "absent" to
    // a dependent's `Fn::GetAtt` path walk, where the recorded value it
    // displaces was the one those dependents resolved against.
    // `Object.create(null)`, not `{}` — the same reason `CloudControlProvider`
    // builds its model bag that way: assigning a `JSON.parse`-produced
    // `__proto__` key onto an object literal writes the PROTOTYPE and the key
    // vanishes, which is a silent DROP of an attribute rather than a refusal.
    const refreshed = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(found.attributes ?? {})) {
      if (carriesSecretMask(value)) continue;
      refreshed[key] = value;
    }
    const mergedAttributes = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(refreshed)) mergedAttributes[key] = value;
    // A recorded value ALWAYS wins, including a masked one.
    //
    // A per-key "heal" was tried — letting a live readback replace a recorded
    // `SECRET_MASK`, on the reasoning that a `cc-api` re-import with
    // `DescribeType` granted is authoritative — and it is a DISCLOSURE, because
    // two different producers write the same sentinel. `carriesSecretMask`
    // cannot tell `maskUncertifiedModelValues`' "not certified as an attribute"
    // mask from `redactSecretsForState`' GHSA-class SECRET redaction, and a
    // `cc-api` record's attributes carry the latter (`scrubResourceRecord` runs
    // over them on the persist path). On a key that is BOTH certified and
    // secret-bearing the heal skipped the redaction and wrote plaintext — and
    // an adopted resource that diffs NO_CHANGE has no `perResourceSecrets`
    // entry, so nothing re-redacts it before `state.json` is written.
    //
    // The cost is accepted and stated: a mask recorded by a
    // `DescribeType`-less import stays masked through adoption, so the user's
    // re-import after granting the permission is still the remedy — which is
    // what `refuseRedactedAttributeReads` already tells them.
    for (const [key, value] of Object.entries(state.attributes ?? {})) {
      mergedAttributes[key] = value;
    }
    outcome.adopted[logicalId] = {
      ...state,
      ...(Object.keys(mergedAttributes).length > 0 || state.attributes
        ? { attributes: mergedAttributes }
        : {}),
    };
  }

  return outcome;
}

/** The slice of the state backend {@link makeSiblingClaimReader} needs. */
export interface SiblingStateReader {
  listStacks(): Promise<readonly { stackName: string; region?: string }[]>;
  getState(
    stackName: string,
    region: string
  ): Promise<{ state: { resources: Record<string, { physicalId: string }> } } | null>;
}

/**
 * Every physical id recorded by a cdkd stack OTHER than `selfStackName` in
 * `selfRegion` (issue #2934).
 *
 * The orphan record proves cdkd created something under a name; it cannot
 * prove no one has since taken that resource over. A `cdkd import` into a
 * different stack during the rollback-to-redeploy window would leave one
 * physical id in two state files, and either stack's `cdkd destroy` would
 * then delete the other's live resource. This is the check that refuses it.
 *
 * Best-effort per sibling: a state file that fails to load is SKIPPED rather
 * than failing the caller, because the alternative is that one unreadable
 * record in an unrelated stack blocks every adoption in the account. That
 * makes the result a lower bound on what is claimed — stated here because it
 * is the direction that can let a wrong adoption through, and the reason this
 * check is one of several rather than the only one.
 *
 * Reachability is bounded by what this backend can see: another ACCOUNT's
 * bucket, and a stack deployed against a different `--state-bucket`, are
 * invisible here by construction.
 *
 * SHARED by `cdkd deploy` and `cdkd diff` (issue go-to-k/cdkd#2943) rather
 * than copied: the two must agree on which records they refuse, or the
 * preview stops predicting the deploy — which is the defect that issue is
 * about. A second implementation is the way they would drift apart.
 */
export function makeSiblingClaimReader(params: {
  stateBackend: SiblingStateReader;
  selfStackName: string;
  selfRegion: string;
  logger: { debug: (message: string) => void };
}): SiblingClaimReader {
  const { stateBackend, selfStackName, selfRegion, logger } = params;
  return async (): Promise<ReadonlySet<string>> => {
    const claimed = new Set<string>();
    let refs;
    try {
      refs = await stateBackend.listStacks();
    } catch (error) {
      logger.debug(
        `orphan adoption: could not list sibling stacks — ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return claimed;
    }
    for (const ref of refs) {
      // Name AND region: the same stack name in another region is a DIFFERENT
      // state file, and globally-namespaced ids — an IAM role, an S3 bucket —
      // are exactly the ones it could be claiming.
      if (ref.stackName === selfStackName && ref.region === selfRegion) continue;
      // The REF carries no region — `listStacks` leaves it unset for a legacy
      // `version: 1` key — and `getState` needs one. Note it is the REF, not
      // necessarily the record: `readLegacyRegion` also answers `undefined`
      // for a body it could not read. Skipping rather than substituting a
      // region is the permissive arm of this function's best-effort contract,
      // described in its doc above.
      //
      // It also catches a region-less ref for THIS stack, which the skip above
      // cannot: that one requires the name AND the region to match, and
      // `selfRegion` is always a string. Substituting would read our OWN
      // record, and our own ids would become claims that (d) reports as
      // belonging to "another cdkd stack". Pinned by the region-less-SELF case
      // in `orphan-adoption-wiring.test.ts`.
      if (ref.region === undefined) continue;
      try {
        const sibling = await stateBackend.getState(ref.stackName, ref.region);
        for (const record of Object.values(sibling?.state.resources ?? {})) {
          claimed.add(record.physicalId);
        }
      } catch (error) {
        logger.debug(
          `orphan adoption: skipping unreadable state for ${ref.stackName} — ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return claimed;
  };
}
