/**
 * `cdkd drift`: one resource's comparison after a successful readback.
 * Split out of `../drift.ts`, which re-exports the public names.
 */
import type { ConsoleLogger } from '../../../utils/logger.js';
import type { Logger } from '../../../types/config.js';
import { isReadableResourceEntry } from '../../../state/malformed-resources-bag.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  undeclaredEmptyObservedKeys,
  calculateResourceDrift,
} from '../../../analyzer/drift-calculator.js';
import {
  type PrincipalUniqueIdResolver,
  canonicalizePrincipalUniqueIds,
} from '../../../analyzer/drift-principal-normalize.js';
import { canonicalizeIpProtocols } from '../../../analyzer/drift-protocol-normalize.js';
import { hasOwnKey, ownValue, nullPrototypeRecord } from '../../../utils/own-keys.js';
import {
  PATTERN_B_NAME_PROPERTIES,
  derivesPatternBName,
} from '../../../provisioning/resource-name.js';
import type { ProducerRegionEvidence } from '../../../deployment/producer-regions-scope.js';
import {
  type RecordedSecretValues,
  maskSecretsInText,
  recordLogOnlyValue,
  unionOfSecretBags,
} from '../../../deployment/secret-redaction.js';
import type { ResourceProvider, ReadCurrentStateContext } from '../../../types/resource.js';
import type { ResourceState, StackState } from '../../../types/state.js';
import {
  type DriftOutcome,
  type NotComparedCause,
  PRE_V10_BASELINE_WARNING_FLOOR,
  matchOutcome,
} from './outcome.js';
import {
  DriftSecretResolvers,
  type SecretPathSet,
  collectDynamicReferencePaths,
  collectSecretMaskPaths,
  resolveStateSecretExpressions,
  isDriftSecretRefusal,
} from './secret-resolution.js';
import {
  partitionNoEchoParameterChanges,
  partitionUncertifiedBaselineChanges,
  redactDriftChanges,
} from './redaction.js';
import {
  undeclaredUncomparedDriftKeys,
  preFixBaselineUncomparedDriftKeys,
} from './baseline-keys.js';
import { withAbsentDefaultKeys, driftAbsentMeansDefaultKeys } from './revert-payload.js';

/** What {@link compareDriftReadback} reads from `runDriftForStack`'s scope. */
interface CompareDriftReadbackArgs {
  region: string;
  resolvePrincipalUniqueId: PrincipalUniqueIdResolver;
  outcomes: DriftOutcome[];
  logger: ConsoleLogger;
  secretResolvers: DriftSecretResolvers;
  producerRegions: ProducerRegionEvidence;
  stackSecretNames: RecordedSecretValues;
  resource: ResourceState;
  logicalId: string;
  provider: ResourceProvider;
  secrets: RecordedSecretValues;
  printing: RecordedSecretValues;
  aws: Record<string, unknown>;
}

/**
 * The comparison half of {@link runDriftForStack}'s per-resource read: every
 * step after the readback returned a live property bag, up to the outcome it
 * pushes. Runs inside that read's `try`, so a throw here reaches the same
 * `catch`.
 */
export async function compareDriftReadback(args: CompareDriftReadbackArgs): Promise<void> {
  const {
    region,
    resolvePrincipalUniqueId,
    outcomes,
    logger,
    secretResolvers,
    producerRegions,
    stackSecretNames,
    resource,
    logicalId,
    provider,
    secrets,
    printing,
    aws,
  } = args;
  // Providers can declare state property paths they cannot read back
  // from AWS (e.g. Lambda `Code`, Secrets Manager `SecretString`). The
  // CC-API fallback has no provider-specific intuition here — only the
  // SDK provider's getDriftUnknownPaths is consulted. The recorded
  // properties are passed so a provider can scope a path to the subset
  // of resources it is actually unreadable for (API Gateway V2
  // `TlsConfig` on a non-private integration, issue #1602).
  const ignorePaths = provider.getDriftUnknownPaths
    ? provider.getDriftUnknownPaths(resource.resourceType, resource.properties ?? {})
    : [];
  // Providers can also declare plain-string array paths that are
  // semantically UNORDERED sets (FSx `WindowsConfiguration.Aliases`, ...).
  // The comparator sorts those on BOTH sides, so an AWS-side reorder is
  // not phantom drift. Same CC-API-fallback caveat as ignorePaths above.
  const unorderedPaths = provider.getDriftUnorderedPaths
    ? provider.getDriftUnorderedPaths(resource.resourceType)
    : [];
  // Prefer the observedProperties baseline (deploy-time AWS snapshot)
  // when present — this is what makes "console-side change to a key
  // the user did not template" surface as drift, instead of being
  // silently ignored because the key is absent from `properties`.
  // Resources written by an older binary (or by a provider without
  // readCurrentState) lack observedProperties; falling back to
  // `properties` preserves the pre-v3 behavior for those.
  // The observed baseline is "what AWS actually had at deploy time"
  // (already includes AWS-managed defaults), so it is safe — and
  // strictly more powerful — to walk the union of baseline+aws keys
  // when descending into nested objects. This is what lets a
  // console-side **key add** to a map-shaped property (Lambda
  // `Environment.Variables.EXTRA`, etc.) surface as drift. The
  // properties fallback (`observedProperties` undefined) keeps the
  // state-keys-only walk so AWS-side defaults the user did not
  // template don't fire false positives on every run.
  const useObserved = resource.observedProperties !== undefined;
  const baseline = useObserved ? resource.observedProperties! : (resource.properties ?? {});
  // The map that resolution fills is declared ABOVE the guard (see the
  // `secrets` declaration and issue #1914's note there); the two path sets
  // below stay here, where they are used.
  // PROVEN secret paths — filled by resolution, so a `{{resolve:ssm:...}}`
  // naming a plain `String` parameter correctly stays out of it.
  const secretPaths: SecretPathSet = new Set<string>();
  // ...and the OFFLINE fallback, computed with no AWS call from where the
  // `{{resolve:` strings simply ARE. Only used when resolution fails, where
  // the alternative is no positional masking at all — and that is not a
  // theoretical gap: the likeliest failure is a least-privilege role, and
  // the comparator's `{{resolve:` skip only re-arms for a LEAF whose state
  // side is a string. A resource whose `observedProperties` lack the secret
  // key while `properties` have it drifts at the ANCESTOR, with the whole
  // AWS subtree — plaintext included — as `awsValue`. Coarser than the
  // proven set (it cannot tell a public ssm reference from a secret one),
  // so it over-masks; that is the direction to err in when the choice is
  // against printing a secret.
  const seededSecretPaths: SecretPathSet = new Set<string>();
  collectDynamicReferencePaths(baseline, seededSecretPaths);
  if (useObserved) collectDynamicReferencePaths(resource.properties ?? {}, seededSecretPaths);
  // Issue #2274: a REDACTION MASK in the record is a secret-bearing
  // position too, and it is the one the dynamic-reference seeds above
  // structurally cannot see — a `NoEcho` custom-resource value has no
  // `{{resolve:` behind it.
  //
  // ITS OWN SET, deliberately, rather than seeded into the two above.
  // `redactDriftChanges` uses `secretPaths` for TWO different decisions:
  // an ANCESTOR match that decides masking, and an EXACT-leaf match that
  // licenses DROPPING a change whose AWS side is absent. The second rule
  // means "AWS cannot read this position back", which is true of a
  // write-only credential and false of a mask — so folding the masks in
  // would silently drop a masked leaf AWS did not report, retiring both
  // the drift signal and the `--revert` refusal that keeps `***` off the
  // live resource. This set feeds the masking decision only.
  //
  // Computed once and used on BOTH the resolution-succeeded and the
  // resolution-failed path, because a mask is read off the record with no
  // AWS call: it is known either way.
  const maskSecretPaths: SecretPathSet = new Set<string>();
  collectSecretMaskPaths(baseline, maskSecretPaths);
  if (useObserved) collectSecretMaskPaths(resource.properties ?? {}, maskSecretPaths);
  const unresolvedTokens = new Set<string>();
  const noteUnresolved = (tokens: string[]): void => {
    for (const token of tokens) unresolvedTokens.add(token);
  };
  let comparisonBaseline = baseline;
  let secretResolutionFailed = false;
  try {
    comparisonBaseline = await resolveStateSecretExpressions(baseline, secretResolvers, secrets, {
      secretPaths,
      onUnresolved: noteUnresolved,
      logicalId,
      consumerRegion: region,
      record: resource,
      producerRegions,
    });
    // The record's `properties` are resolved into the SAME map and path set
    // (the resolved bag is thrown away — only those two are wanted) so a
    // leaf the observed baseline never captured is still redactable.
    // Without it, a resource whose readback omitted a secret-bearing key at
    // deploy time has no map entry for that secret, and the live value AWS
    // returns for it now would reach both the report and `--accept`'s state
    // write in plaintext. Issue #1900's shape, arriving here through the
    // observed capture instead of an UNCHANGED resource. Free unless the
    // template side names a reference the baseline does not, since resolved
    // values are cached.
    if (useObserved) {
      await resolveStateSecretExpressions(resource.properties ?? {}, secretResolvers, secrets, {
        secretPaths,
        onUnresolved: noteUnresolved,
        logicalId,
        consumerRegion: region,
        record: resource,
        producerRegions,
      });
    }
  } catch (err) {
    // Before this issue `cdkd drift` made no secret lookups at all, so
    // every way one can fail is a failure mode this change INTRODUCED: a
    // deleted secret, a version rotated out from under a pinned reference,
    // or — the likeliest — a least-privilege role that was never granted
    // `secretsmanager:GetSecretValue` / `ssm:GetParameter` because drift
    // never needed them. Letting it propagate would abort the whole
    // command: every remaining resource, and under `--all` every remaining
    // STACK, over one unreadable reference on one resource.
    //
    // Degrade to the pre-issue behaviour for THIS resource instead. The
    // unresolved baseline still carries its `{{resolve:...}}` strings, so
    // `calculateResourceDrift`'s skip suppresses the phantom drift exactly
    // as it did before — the resource's secret-bearing paths are simply not
    // compared, which is what the command already did and is strictly
    // better than not running at all.
    //
    // The VALUE map is cleared: a partial one would redact some leaves and
    // not others, unevenly and for a reason no reader could see. The PATH
    // answer is not lost with it — `seededSecretPaths` was computed offline
    // and takes over below, because the skip does not cover a drift
    // reported ABOVE a secret leaf.
    //
    // ACCEPTED COST ON THE #2108 REFUSAL PATH, stated so it is a recorded
    // trade rather than a side effect. The refusal is per LEAF, not per
    // resource: `resolveDriftLeafByRegion` classifies one leaf at a time and
    // the pass walks them sequentially, so the map is NOT necessarily empty
    // here. An ARN-form reference (verdict `named-region`) resolves and
    // records its plaintext, and a name-form reference on a LATER leaf of
    // the same resource can then refuse — and this clear discards the
    // correctly-resolved needle along with everything else. An earlier
    // wording claimed the map is always empty at this point because the
    // refusal precedes any fetch; that is true only of the FIRST refusing
    // leaf, and it made the clear look free when it is not.
    //
    // The blast radius is still bounded to this resource (the map is
    // per-resource) and to paths whose state side carries no `{{resolve:`
    // for `seededSecretPaths` to have seeded. Where it does bite
    // is the KNOWN OVER-REFUSAL (a purely local name-form reference in a
    // stack with any foreign producer region on record): pre-#2108 that
    // resource resolved fine and the map held the CORRECT plaintext, which
    // value-based redaction used to mask that value wherever it appeared —
    // including at paths whose state side has no `{{resolve:` for the
    // offline `seededSecretPaths` seed to find. Post-#2108 only the
    // positional seed is left there. Kept anyway: the alternative is
    // resolving the reference to build the needle, which is the wrong-region
    // fetch this whole change exists to refuse.
    secretResolutionFailed = true;
    comparisonBaseline = baseline;
    // A REFUSAL is not a failure to read, and saying "could not resolve"
    // about a deliberate decision sends the reader hunting for an IAM
    // problem that does not exist. Branch on the code and say which one it
    // was. Both spellings keep the phrase `NOT compared`, which is the part
    // that describes the CONSEQUENCE, and both stay to one line: this warns
    // once per RESOURCE, and the over-refusal above makes the common
    // `secretValueFromJson` shape hit it on every resource in the stack.
    const refused = isDriftSecretRefusal(err);
    logger.warn(
      `${logicalId} (${resource.resourceType}): ` +
        (refused
          ? `refused to resolve a dynamic reference this resource's state records, so its ` +
            `secret-bearing properties are NOT compared — `
          : `could not resolve the dynamic reference(s) this resource's state records, so ` +
            `its secret-bearing properties are NOT compared — `) +
        // Masked BEFORE the map is cleared, and that ordering is the whole
        // reason the clear is below rather than above. The message comes
        // from an external system whose wording cdkd does not control, and
        // a partially completed pass can already hold a plaintext.
        `${maskSecretsInText(describeAwsFailure(err).detail, secrets)}`
    );
    // Every needle the clear discards stays a LOG-ONLY one of this bag
    // (issue #2102): the side set is keyed by the map INSTANCE, so it
    // survives `clear()`, and only the PRINTING maskers read it. The
    // report's VALUE redaction and `--accept`'s write still see an empty
    // map, which is the evenness the clear exists for; `redactDriftChanges`'
    // PATH mask is a printing masker, so a key carrying one is masked and
    // refused (see the note there). Without it the `readFailed` warning
    // and its debug stack below, which mask through this same bag, would
    // print a plaintext the pass had already resolved.
    for (const plaintext of secrets.keys()) recordLogOnlyValue(secrets, plaintext);
    secrets.clear();
  }
  if (unresolvedTokens.size > 0) {
    // Not a failure: `cdkd deploy` resolves through this same code, so AWS
    // already holds these literals and state records them. Worth saying
    // once per resource, and safe to say — a token names a reference, not a
    // value.
    //
    // The revert clause is deliberately conditional. A token EMBEDDED in a
    // larger string (`"jdbc:...password={{resolve:...}}"`) is preserved
    // only when the rest of the string matches AWS exactly (issue #2102),
    // and this is the message the user reads immediately before the
    // confirmation prompt — promising an untouched live value
    // unconditionally would misinform someone about to authorise a
    // destructive write.
    logger.warn(
      `${logicalId} (${resource.resourceType}): cdkd cannot resolve ` +
        `${maskSecretsInText([...unresolvedTokens].join(', '), secrets)} — those properties ` +
        `are NOT compared. A revert leaves a property whose WHOLE value is one of these ` +
        `tokens untouched where its position can be matched against AWS's report (a list ` +
        `element pairs by an identity field, or by the list's own unchanged literal ` +
        `values). A token EMBEDDED in a longer string is left untouched the same way when ` +
        `the rest of that string is exactly what AWS holds. Where it cannot be matched, ` +
        `the revert writes the token literal, exactly as 'cdkd deploy' does — so a ` +
        `resolved value AWS holds there WOULD be overwritten. cdkd resolves ` +
        `'secretsmanager', 'ssm' and 'ssm-secure' references; anything else is left as ` +
        `written.`
    );
  }
  // Observed-baseline blind spot (issue #1498): the snapshot is captured
  // per-resource BEFORE dependent sibling resources run, so a parent key
  // that a sibling resource type materializes later (ECS
  // ClusterCapacityProviderAssociations -> Cluster.CapacityProviders,
  // AutoScaling::LifecycleHook -> the ASG's hook list, standalone SG
  // ingress/egress rules) is captured empty and later populated —
  // permanent phantom drift that `--revert` would then destructively
  // strip from AWS. Skip top-level keys the template never declared
  // whose captured value was empty; CFn drift only compares
  // template-declared properties, so this restores parity for exactly
  // that class while keeping detection on undeclared keys captured with
  // a real value (AWS-side defaults a console edit could change).
  const observedIgnorePaths = useObserved
    ? undeclaredEmptyObservedKeys(resource.observedProperties!, resource.properties ?? {})
    : [];
  // Issue #1515: AWS renders an IAM principal inside a resource policy as
  // either its ARN or its `AROA…` / `AIDA…` unique id, choosing on its own
  // schedule — so the deploy-time capture and this read can hold two
  // spellings of ONE principal, which is permanent phantom drift `--revert`
  // cannot clear (it writes the recorded form back and AWS re-canonicalizes
  // on write). Canonicalized on BOTH sides, and only for a pair PROVEN
  // equal by an `iam:GetRole` / `GetUser` lookup; anything unresolvable is
  // left alone and still reported. No AWS call unless a unique id is
  // actually present.
  const normalized = await canonicalizePrincipalUniqueIds(
    comparisonBaseline,
    aws,
    resolvePrincipalUniqueId
  );
  // Issue #1643: EC2 owns the spelling of a security-group rule's
  // `IpProtocol` — it renames the four protocol NUMBERS it has a name for
  // (`1` -> `icmp`, `6` -> `tcp`, `17` -> `udp`, `58` -> `icmpv6`; measured
  // us-east-1 2026-08-12, ingress AND egress) and lower-cases a name it is
  // given. cdkd records what it SENT, so the baseline and this read are two
  // spellings of ONE protocol — permanent phantom drift `--revert` cannot
  // clear, since it revokes and re-authorizes into the same state. Pure and
  // path-scoped to the security-group types (a blanket rewrite would turn an
  // unrelated `'6'` into `'tcp'`), and applied to BOTH sides so the
  // `properties`-fallback baseline (the user's raw template) normalizes too.
  const protocolNormalized = canonicalizeIpProtocols(
    normalized.baseline,
    normalized.aws,
    resource.resourceType
  );
  // Issue #1784: the provider's own BOTH-SIDES canonicalizer, for a
  // difference no ignore-path can express — a member of an ARRAY ELEMENT.
  // `calculateResourceDrift` compares arrays wholesale, so the only
  // expressible suppression is the whole array; stripping the AWS-managed
  // member from BOTH bags instead converges an OLD observedProperties
  // record with a NEW readback while keeping the array compared.
  //
  // Position: after the principal (#1515) and IpProtocol (#1643) passes,
  // and necessarily BEFORE the tag-list / id-array / unordered-path passes,
  // which run INSIDE `calculateResourceDrift` — an element strip has to
  // precede the unordered sort or the two sides' canonical sort keys are
  // computed over different member sets and diverge.
  //
  // It rewrites the COMPARISON copies only, so `outcome.awsProperties` —
  // the raw bag `--revert` diffs against — keeps the stripped member. Note
  // `--accept` is NOT symmetric with that: it writes each change's
  // `awsValue`, which comes from these canonicalized bags, so a stripping
  // canonicalizer means `--accept` persists the stripped shape on a path
  // that still drifts. That is the intended direction (state should stop
  // carrying a member the readback no longer reports), but a provider
  // author must know it is a WRITE, not just a comparison filter.
  const canonicalized = provider.canonicalizeDriftProperties
    ? {
        baseline: provider.canonicalizeDriftProperties(
          resource.resourceType,
          protocolNormalized.baseline
        ),
        aws: provider.canonicalizeDriftProperties(resource.resourceType, protocolNormalized.aws),
      }
    : protocolNormalized;
  // Issue #3573: the provider's PAIR canonicalizer, for a rule that reads
  // one side to decide the other -- a readback shape change absorbed only
  // against a baseline written in the legacy shape. After the per-side
  // pass, so it sees the same bags the comparator will. `runRevert`
  // applies it to its desired bag as well.
  const paired = provider.canonicalizeDriftPair
    ? await provider.canonicalizeDriftPair(
        resource.resourceType,
        canonicalized.baseline,
        canonicalized.aws,
        resource.properties ?? {}
      )
    : canonicalized;
  // Issue #4081: a declared Pattern B name the live one is DERIVED from
  // (the legacy stack-name prefix, a sanitize rewrite) is the same name.
  // Inside this function's `withStackScope`, which the check needs.
  const nameBaseline = canonicalizeDerivedPatternBName(
    resource.resourceType,
    paired.baseline,
    paired.aws
  );
  // go-to-k/cdkd#5399: a key the provider says the readback omits at
  // its default is compared even when the observed baseline lacks it,
  // which the comparator's baseline-keys-only top-level walk skips.
  const comparedBaseline = useObserved
    ? withAbsentDefaultKeys(
        nameBaseline,
        paired.aws,
        driftAbsentMeansDefaultKeys(provider, resource.resourceType, resource.properties)
      )
    : nameBaseline;
  // go-to-k/cdkd#5736 / #5741: an undeclared key another writer owns
  // (a bucket's NotificationConfiguration) is not compared, whichever
  // baseline is in use.
  const ownedIgnorePaths = undeclaredUncomparedDriftKeys(
    resource.resourceType,
    resource.properties
  );
  // go-to-k/cdkd#5749: a baseline value a pre-#5737 cdkd recorded by
  // mistake (an event source mapping's `Enabled: false`) is not
  // compared while the template and the live mapping agree on enabled.
  const preFixIgnorePaths = preFixBaselineUncomparedDriftKeys(
    resource.resourceType,
    resource.observedProperties,
    resource.properties,
    aws
  );
  const changes = calculateResourceDrift(comparedBaseline, paired.aws, {
    ignorePaths:
      observedIgnorePaths.length || ownedIgnorePaths.length || preFixIgnorePaths.length
        ? [...ignorePaths, ...observedIgnorePaths, ...ownedIgnorePaths, ...preFixIgnorePaths]
        : ignorePaths,
    unionWalkObjects: useObserved,
    unorderedPaths,
  });
  // Issue #1914: redacted BEFORE the outcome exists, so no reader can be
  // added later that sees the plaintext. Every consumer of a drifted
  // outcome — the human report, the `--json` payload, both plans, and the
  // value `--accept` writes into state — reads `changes`.
  //
  // The PROVEN path set when resolution succeeded, the offline seed when it
  // did not — never a half-populated mixture of the two.
  //
  // Run BEFORE the clean/drifted decision, not inside the drifted arm: this
  // pass can DROP a change (an absent AWS value at a secret-bearing path is
  // unknown, not drift), and deciding on the raw list first produced a
  // `drifted` outcome with an empty change list — a report that says drift
  // was detected and then shows nothing.
  // Issue #3595: a change that exists only because the baseline holds an
  // uncertified-position mask is UNKNOWN, not drift. Split off before
  // redaction, which would turn the AWS side into the mask too.
  // go-to-k/cdkd#4043: a `NoEcho` parameter's marked position first; what
  // remains goes to the uncertified-baseline partition.
  const noEchoPartitioned = partitionNoEchoParameterChanges(changes, resource, baseline);
  const partitioned = partitionUncertifiedBaselineChanges(
    noEchoPartitioned.kept,
    resource.properties ?? {},
    baseline
  );
  // go-to-k/cdkd#5332: a provider that compares a secret-bearing value at
  // ANOTHER position (Step Functions folds `DefinitionSubstitutions` into
  // `Definition`) names where it landed, so the position mask follows it
  // and a value shorter than the value scan's needle floor is still
  // masked. Into `maskSecretPaths`, the masking-only set: these positions
  // are readable back, so they must not license the exact-leaf drop that
  // `secretPaths` also drives.
  if (provider.getDriftSecretPathAliases) {
    for (const alias of provider.getDriftSecretPathAliases(
      resource.resourceType,
      resource.properties ?? {},
      // The `***` positions too: a NoEcho value substituted into a
      // folded leaf is as secret as a dynamic reference.
      new Set([...(secretResolutionFailed ? seededSecretPaths : secretPaths), ...maskSecretPaths])
    )) {
      maskSecretPaths.add(alias);
    }
  }
  const reported = redactDriftChanges(
    partitioned.kept,
    secrets,
    secretResolutionFailed ? seededSecretPaths : secretPaths,
    maskSecretPaths
  );
  // ONE field where issues #1914 / #2108 carried two booleans, and the
  // ordering is what the old `comparisonRefused = secretResolutionFailed`
  // said: a resource that BOTH threw and kept a surviving token is
  // `refused`, the wider of the two signals. See `NotComparedCause`.
  // `uncertifiedBaseline` (issue #3595) ranks ABOVE `unresolvedToken`:
  // the outcome carries one cause, and that one is excluded from the exit
  // code, so ranking it first would let a permanent token hide a
  // position cdkd did not compare.
  const notComparedCause: NotComparedCause | undefined = secretResolutionFailed
    ? 'refused'
    : partitioned.uncertifiedPaths.length > 0
      ? 'uncertifiedBaseline'
      : unresolvedTokens.size > 0
        ? 'unresolvedToken'
        : noEchoPartitioned.noEchoParameterPaths.length > 0
          ? 'noEchoParameter'
          : undefined;
  if (reported.changes.length === 0) {
    if (notComparedCause !== undefined) {
      // Issue #2135: its OWN variant rather than a `clean` carrying a flag.
      // An empty change list here can mean "compared and equal" or "not
      // compared at all", and a consumer that has to remember to ask which
      // reports the second as the first by default.
      outcomes.push({
        kind: 'notCompared',
        logicalId,
        resourceType: resource.resourceType,
        notComparedCause,
      });
    } else {
      outcomes.push({
        kind: 'clean',
        logicalId,
        resourceType: resource.resourceType,
      });
    }
  } else {
    outcomes.push({
      kind: 'drifted',
      logicalId,
      resourceType: resource.resourceType,
      ...reported,
      awsProperties: aws,
      secrets,
      printingNeedles: unionOfSecretBags([printing, stackSecretNames]),
      uncertifiedPaths: partitioned.uncertifiedPaths,
      noEchoParameterPaths: noEchoPartitioned.noEchoParameterPaths,
      secretsIncomplete: secretResolutionFailed || unresolvedTokens.size > 0,
      notComparedCause,
    });
  }
}

/**
 * Warn once for a stack whose state PREDATES the refused-baseline marker
 * (`ResourceState.observedBaselineRefused`, state schema v10) and still has a
 * resource without a drift baseline (issue
 * [#3011](https://github.com/go-to-k/cdkd/issues/3011)).
 *
 * Both conjuncts are load-bearing, and neither is a heuristic:
 *
 *  - `version < 10` is not "probably imported" — it is the exact statement that
 *    this record could not carry a refusal even if one was made. A v10 record
 *    that omits the field is a record nothing refused, and warning there would
 *    be false.
 *  - the missing baseline is what makes the warning ACTIONABLE. A pre-v10 stack
 *    where every resource has a baseline has nothing for drift to fall back to
 *    `properties` for, so it cannot hit the disclosure.
 *
 * Exported for unit testing -- internal to the drift flow otherwise.
 */
export function warnIfPreV10BaselineGap(
  state: StackState,
  outcomes: readonly DriftOutcome[],
  logger: Logger
): string[] {
  // `undefined` is a legacy record too, and reads as older than 10 rather than
  // as "no opinion" -- a record with no version predates every field.
  if ((state.version ?? 1) >= PRE_V10_BASELINE_WARNING_FLOOR) return [];

  // Only resources drift actually COMPARED can carry the disclosure this warns
  // about, so the count is taken from the OUTCOMES rather than from the record
  // (review of issue #3011). `observedProperties === undefined` is also true of
  // a Custom Resource (`skipped`, issue #323) and of a type no provider reads
  // back (`unsupported`) -- neither is ever compared, so neither can surface a
  // live value, and counting them would make this line fire forever on stacks
  // it has nothing to say about.
  const compared = new Set(
    outcomes.flatMap((o) =>
      matchOutcome<string[]>(o, {
        drifted: (d) => [d.logicalId],
        clean: (c) => [c.logicalId],
        notCompared: (n) => [n.logicalId],
        unsupported: () => [],
        skipped: () => [],
        // Nothing was read back, so no live value can surface.
        deleted: () => [],
      })
    )
  );
  const affected = Object.entries(state.resources ?? {})
    .filter(([id, r]) => r.observedProperties === undefined && compared.has(id))
    .map(([id]) => id);
  if (affected.length === 0) return [];

  // NAMED, capped: "deploy a change to those resources" naming none is not a
  // remedy the user can act on, and under `--all` the region is what tells two
  // same-named stacks apart.
  const shown = affected.slice(0, 10).join(', ');
  const rest = affected.length > 10 ? `, and ${affected.length - 10} more` : '';
  const finding =
    `${state.stackName} (${state.region ?? 'unknown region'}): this stack's state predates ` +
    `cdkd's refused-baseline marker (schema v${state.version ?? 1}; the marker arrived in ` +
    `v${PRE_V10_BASELINE_WARNING_FLOOR}), and ${affected.length} of its compared ` +
    `resource(s) have no drift baseline: ${shown}${rest}. If any were adopted by ` +
    `'cdkd import' and that import REFUSED to capture a baseline, cdkd cannot tell — so it ` +
    `compares them against their recorded properties, which can hold a placeholder the ` +
    `deployed stack never used and can surface a live secret in this report. ` +
    `Re-run 'cdkd import' for this stack to put the record right.`;
  // SEPARATE line, and it is the half a review round had to add. The first
  // wording said this warning "stops after the stack's next deploy", which is
  // FALSE and dangerous: `saveState` stamps the CURRENT schema version
  // unconditionally, so any write — `cdkd drift --accept` / `--revert` in this
  // very invocation, a NO_CHANGE deploy, a partial save — silences this line
  // while the untrustworthy properties survive. Worse on the deploy path: the
  // baseline auto-refresh then refills those resources FROM those same
  // properties, with no marker to stop it, so the thing that silences the
  // warning is the disclosure itself.
  const note =
    `  Note: ANY write to this stack's state — including this run's --accept / --revert, ` +
    `or a deploy that changes nothing about the resources above — re-stamps it at the ` +
    `current schema version and SILENCES this warning without fixing those records. ` +
    `Only a re-import, or a deploy that actually CHANGES a listed resource, repairs one — ` +
    `and the deploy only when that resource reads no template parameter, since a deploy ` +
    `binds the same parameter Default the import did.`;
  logger.warn(finding);
  logger.warn(note);
  return [finding, note];
}

/**
 * Set a value at a dotted path inside a plain object, creating intermediate
 * objects as needed. Mirrors `lodash.set` for the subset of paths the drift
 * comparator actually emits — dotted nested keys, no array indices.
 *
 * The drift comparator (`src/analyzer/drift-calculator.ts`) only synthesizes
 * paths through plain objects; arrays and scalars surface as a single drift
 * entry on the parent path. So we do not need to parse `[i]` segments.
 */
/**
 * Issue #323: build the cross-resource context passed to
 * `provider.readCurrentState` so IAM Role / User / Group readers can
 * filter out inline policies managed by a sibling `AWS::IAM::Policy`
 * resource. `excludedLogicalId` is the resource being read — it's
 * omitted from the siblings map so a self-reference can never collide.
 */
export function buildReadCurrentStateContext(
  state: StackState,
  excludedLogicalId: string
): ReadCurrentStateContext {
  const siblings: NonNullable<ReadCurrentStateContext['siblings']> = {};
  for (const [lid, res] of Object.entries(state.resources ?? {})) {
    if (lid === excludedLogicalId) continue;
    // go-to-k/cdkd#3018, and this one IS at the loop rather than at a load,
    // deliberately: the helper is EXPORTED and its three callers reach it with
    // three different guarantees — `cdkd drift` and `cdkd state refresh-observed`
    // now settle the record's shape at their own load sites, while `cdkd import`
    // hands it a record it is midway through building.
    //
    // TWO outcomes, not one, and the second is why a `try` around the next lines
    // would not do instead: a `null` sibling CRASHES on `res.resourceType`,
    // while a string, a number, a list or an OBJECT WITH NO TYPE does NOT — it
    // yields `undefined` for every field it lacks and enters the map as a
    // sibling record naming no resource. A provider reading that map to resolve
    // a cross-resource reference is then answered about a resource that does
    // not exist. The predicate asks for the resource TYPE for that reason: it
    // is the field every reader of an entry touches first.
    if (!isReadableResourceEntry(res)) continue;
    siblings[lid] = {
      resourceType: res.resourceType,
      physicalId: res.physicalId,
      properties: res.properties ?? {},
      attributes: res.attributes ?? {},
    };
  }
  // go-to-k/cdkd#4447: the read resource's own recorded attributes, through
  // the same readability gate as a sibling's.
  const own: unknown = (state.resources ?? {})[excludedLogicalId];
  const ownAttributesValue = isReadableResourceEntry(own)
    ? (own as { attributes?: unknown }).attributes
    : undefined;
  const ownAttributes =
    typeof ownAttributesValue === 'object' &&
    ownAttributesValue !== null &&
    !Array.isArray(ownAttributesValue)
      ? (ownAttributesValue as Record<string, unknown>)
      : undefined;
  return { siblings, ...(ownAttributes && { attributes: ownAttributes }) };
}

/**
 * The comparison baseline with a Pattern B resource's declared name replaced
 * by the live one, when the live name is what the provider derives from it
 * (issue [#4081](https://github.com/go-to-k/cdkd/issues/4081)).
 *
 * A record with no `observedProperties` compares its TEMPLATE bag, whose
 * `RoleName` / `ManagedPolicyName` / ELBv2 `Name` / ... is the declared name.
 * The IAM and ELBv2 providers create under `generateResourceNameWithFallback`'s
 * output instead, which on a stack deployed with the legacy
 * `--prefix-user-supplied-names` is `<stack>-<name>`: a name difference on
 * every run, and an exit 1, with nothing drifted. {@link derivesPatternBName}
 * decides it under either prefix setting, in the CALLER's `withStackScope`
 * scope, so a live name it does not reproduce (another stack's prefix, a
 * different name) stays reported.
 *
 * Only the COMPARISON copy is rewritten, like the other canonicalizers here:
 * `--accept` writes nothing for a name that no longer differs, and `--revert`
 * sends the live name, which no drifted subtree overlays. Returns `baseline`
 * by identity when nothing applies; the rewrite is onto a null-prototype
 * record, so an own `__proto__` key survives it.
 */
export function canonicalizeDerivedPatternBName(
  resourceType: string,
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>
): Record<string, unknown> {
  if (!hasOwnKey(PATTERN_B_NAME_PROPERTIES, resourceType)) return baseline;
  const property = PATTERN_B_NAME_PROPERTIES[resourceType]!;
  const declared = ownValue(baseline, property);
  const live = ownValue(aws, property);
  if (declared === live || !derivesPatternBName(resourceType, declared, live)) return baseline;
  const out = nullPrototypeRecord();
  for (const [key, value] of Object.entries(baseline)) out[key] = value;
  out[property] = live;
  return out;
}
