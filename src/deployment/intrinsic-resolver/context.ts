import {
  type StaleAttributeHealPhase,
  type StaleAttributeHealer,
} from '../stale-attribute-heal.js';
import { type RecordedSecretValues } from '../secret-redaction.js';
import type { CloudFormationTemplate } from '../../types/resource.js';
import {
  type ResourceState,
  type StateImportEntry,
  type StateOutputReadEntry,
} from '../../types/state.js';
import { S3StateBackend } from '../../state/s3-state-backend.js';
import type { ExportIndexStore } from '../../state/export-index-store.js';
import type { AbandonedResolution, RedactedAttributeRead } from './context/refusals.js';

export {
  LOG_TWINS_BY_PASS,
  carriesDynamicReference,
  sitsInsideResolvableReference,
  recordKeptPlaceholder,
  takeKeptPlaceholdersInsideReferences,
  keepsSecretReferenceToken,
} from './context/log-twins.js';
export type { LogTwin, DynamicReferencePass } from './context/log-twins.js';
export {
  NESTED_STACK_RESOURCE_TYPE,
  NESTED_STACK_OUTPUT_ATTRIBUTE_PREFIX,
  NESTED_STACK_LOCAL_ARN,
  nestedStackChildRegionFromLocalArn,
  selectIndexPosition,
  DYNAMIC_REFERENCE_PREFIX,
  carriesFetchableDynamicReference,
  NAMELESS_DYNAMIC_REFERENCE_MARKERS,
  isNamelessDynamicReferenceError,
  isDeliberateResolutionRefusal,
} from './context/refusals.js';
export type { AbandonedResolution, RedactedAttributeRead } from './context/refusals.js';
export {
  cachedAccountIdentities,
  cachedAvailabilityZones,
  recordedSecretExpressions,
  cachedEc2InstanceAttributes,
  cachedVpcDefaultSecurityGroups,
  cachedCloudFrontDomainNames,
  cachedSecurityGroupVpcIds,
} from './context/caches.js';
export type {
  AwsAccountInfo,
  CachedAccountIdentity,
  CachedDynamicReference,
  NamedRequestMasks,
} from './context/caches.js';

/**
 * The same context with the `producerRegions` EVIDENCE removed (issue #2134
 * review rounds 1 and 2).
 *
 * That field means "the CONSUMER stack reads from these regions", and it is
 * only meaningful where the origin of a reference is genuinely UNKNOWN. Hand it
 * to a resolution whose origin is already established and it re-judges a
 * reference cdkd has just proven, verdicting `ambiguous`.
 *
 * ROUND 1 stripped it by RESOLVER IDENTITY -- "is this a different instance?"
 * -- and round 2 measured that that is the wrong question. When the producer
 * lives in the CONSUMER's own region `resolverForProducerRegion` returns `this`,
 * so the identity test passed the evidence straight through and a name-form
 * reference read out of that producer was refused. The LOCAL producer failed
 * while the CROSS-REGION one succeeded, which is backwards, and after the
 * round-1 re-raise it aborted the whole stack's scrub rather than logging a
 * debug line.
 *
 * The right question is whether the ORIGIN IS KNOWN, so each caller answers it
 * for itself and this helper only performs the strip. Returned BY IDENTITY when
 * there is no evidence to remove, so the ordinary path allocates nothing.
 */
export function withoutProducerRegions(
  context: ResolverContext | undefined
): ResolverContext | undefined {
  if (context?.producerRegions === undefined) return context;
  const { producerRegions: _stripped, ...rest } = context;
  return rest;
}

/**
 * Resolver context for intrinsic functions
 */
/**
 * One cross-stack read a diff pass resolved (go-to-k/cdkd#4852): the producer
 * output it read and, when the read already held it, the producer's state.
 */
export interface CrossStackRead {
  stackName: string;
  region: string;
  outputKey: string;
  /** The value read carries a `{{resolve:` token: only such a read can be a member. */
  carriesToken: boolean;
  state?: import('../../types/state.js').StackState;
}

export interface ResolverContext {
  /** Template being processed */
  template: CloudFormationTemplate;
  /** Current resource states (for Ref/GetAtt) */
  resources: Record<string, ResourceState>;
  /** Parameter values (for Ref to parameters) */
  parameters?: Record<string, unknown>;
  /** Evaluated condition values (for Fn::If) */
  conditions?: Record<string, boolean>;
  /** State backend for cross-stack references (Fn::ImportValue) */
  stateBackend?: S3StateBackend;
  /** Current stack name (for Fn::ImportValue to avoid self-reference) */
  stackName?: string;
  /**
   * Persistent exports index for fast `Fn::ImportValue` resolution. When
   * supplied, the resolver tries an O(1) index lookup before falling back
   * to the per-stack state.json scan. Optional for backwards compat; the
   * scan-only path is still correct.
   */
  exportIndex?: ExportIndexStore;
  /**
   * Bag for the resolver to push every successful `Fn::ImportValue`
   * resolution into. The deploy engine reads this after resource
   * provisioning and persists it to the consumer's `state.imports`
   * field (schema v4) so destroy-time strong-reference checks can
   * refuse to delete a producer with active consumers.
   *
   * `Fn::GetStackOutput` does NOT push entries here by design — it
   * is a weak reference and uses the sibling `recordedOutputReads`
   * bag instead (schema v8, issue #668).
   */
  recordedImports?: StateImportEntry[];
  /**
   * Bag for the resolver to push every successful `Fn::GetStackOutput`
   * resolution into (schema v8+, issue #668). The deploy engine reads
   * this after resource provisioning and persists it to the consumer's
   * `state.outputReads` field so `findDownstreamConsumers` can name
   * the downstream stacks affected by a producer's recreate.
   *
   * Sibling of `recordedImports` for the weak-reference
   * `Fn::GetStackOutput` intrinsic. Cross-account `RoleArn`-based
   * reads do NOT push entries here in v8 (deferred to a future
   * schema bump alongside a `sourceAccountId` field).
   */
  recordedOutputReads?: StateOutputReadEntry[];
  /**
   * Bag for the resolver to push every resolved SECRET dynamic reference into,
   * keyed by the resolved plaintext VALUE with the original `{{resolve:...}}`
   * expression as the payload (GHSA fix). The deploy engine reads this after
   * resolution to (a) redact the plaintext out of the bag it PERSISTS to state
   * — replacing each secret value with its unresolved expression, CloudFormation
   * semantics — and (b) mask the value out of log / error output. What counts
   * as a secret is decided by TYPE, not by the reference's SPELLING (issue
   * #1901): every `secretsmanager` reference, plus a plain `{{resolve:ssm:...}}`
   * one whose parameter turns out to be a `SecureString` — that form resolves
   * with `WithDecryption`, so for that type it yields a real secret. An `ssm`
   * reference to a `String` / `StringList` parameter IS public config and is
   * deliberately NOT recorded, so state keeps storing it resolved.
   * See `src/deployment/secret-redaction.ts`.
   */
  recordedSecretValues?: RecordedSecretValues;
  /**
   * Secret pairs a PARENT stack already resolved on a nested CHILD's behalf,
   * for the child resolver to RECORD from rather than to substitute with
   * (issues [#1903](https://github.com/go-to-k/cdkd/issues/1903) /
   * [#2087](https://github.com/go-to-k/cdkd/issues/2087)).
   *
   * Set only by a nested-stack child `DeployEngine`, from
   * `DeployEngineOptions.inheritedSecrets`. The parent resolves the child's
   * `Parameters` block, so the value reaching the child is already PLAINTEXT
   * and the child's own template spells the consumption as
   * `{Ref: <ParamName>}` — an intrinsic OBJECT, never a `{{resolve:` string.
   * Nothing in the child's own resolution can therefore record the
   * `plaintext -> expression` pair that the deploy engine's state-save choke
   * point redacts with, and the child's `state.json` persisted the decrypted
   * secret.
   *
   * READ-ONLY and NEVER substituted: `resolveRef` still returns the real
   * parameter value — that is what reaches AWS — and only copies the matching
   * pair into `recordedSecretValues`, i.e. into the map belonging to the
   * resource whose resolution actually consumed the parameter. Recording at
   * RESOLUTION time rather than pre-seeding every context is what keeps the
   * per-resource scoping every reader of `perResourceSecrets` assumes; the
   * earlier pre-seed handed the same bag to every child resource, so an
   * unrelated literal merely CONTAINING the plaintext (`my-production-bucket`
   * against a secret `production`) was spliced into the expression and the
   * stack acquired a perpetual UPDATE (issue #2087).
   *
   * A reader MUST NOT enumerate or log its KEYS — they are secret plaintext.
   */
  inheritedSecrets?: RecordedSecretValues;
  /**
   * A nested child's: the physical ids the parent row read
   * (go-to-k/cdkd#4810), set whether or not {@link inheritedSecrets} is. A
   * `{Ref: <Param>}` value containing one records it as a copy of THIS
   * context's bag (go-to-k/cdkd#4819).
   */
  inheritedPhysicalNameCopies?: ReadonlySet<string>;
  /**
   * A nested child's (state schema v12, go-to-k/cdkd#4852): the reference
   * provenance the parent row's resolution recorded, a snapshot taken when the
   * child engine was built. A `{Ref: <Param>}` value carrying an inherited pair
   * records that token's entry into THIS context's bag, on the `read` route.
   */
  inheritedReferenceProvenance?: ReadonlyMap<
    string,
    import('../../types/state.js').ReferenceProvenance
  >;
  /**
   * State schema v12 (go-to-k/cdkd#4847 / #4852): the ROUTE every resolution
   * in this context records its provenance under. `read` inside a
   * re-resolution of a recorded value (a `Fn::GetAtt` / `Ref` served from a
   * record, a cross-stack read, a nested `Outputs.<Key>`); absent means
   * `literal`, a token the template spells.
   */
  provenanceRoute?: 'read';
  /**
   * A second bag the recording seam writes PROVENANCE into, beside
   * {@link recordedSecretValues}: the outputs pass gives each output its own,
   * so two outputs holding one token at two generations keep apart. Pairs are
   * never recorded here.
   */
  provenanceSink?: RecordedSecretValues;
  /**
   * The one-time v12 migration capture's context (go-to-k/cdkd#4847 / #4852):
   * suppresses the "Serving ... as recorded" warning, which the deploy's own
   * resolution of the same record prints when it applies.
   */
  provenanceCapture?: true;
  /**
   * go-to-k/cdkd#4847: the version each listed token is PINNED to, set only
   * by the re-resolution of a recorded value (`reresolveRecordedReferences`,
   * a nested `Outputs.<Key>`) from the record's `referenceProvenance`. A pin
   * equal to the version this resolver already cached reuses that entry; any
   * other pin is looked up at that version, cached under a key carrying it,
   * and its plaintext is paired ({@link recordResolvedPair}) only when it
   * equals what this pass recorded for the token, so two generations of one
   * token never mark its pair conflicting.
   */
  referencePins?: ReadonlyMap<string, string>;
  /**
   * go-to-k/cdkd#4852 (design §2.2, the read-route source): the versions the
   * PRODUCER's record holds for each listed token, set beside
   * {@link referencePins} by the re-resolution of a recorded value. A `read`
   * resolution of a listed token records these, not the version its lookup
   * returned: they differ only where the pin could not be read and today's
   * proof served the current value, and a reader recording that version would
   * be promoted on every later deploy against a producer that never held it.
   */
  recordedReadVersions?: ReadonlyMap<string, readonly string[]>;
  /**
   * go-to-k/cdkd#4852: the cross-stack reads a DIFF pass resolved, keyed by the
   * reading leaf's `crossStackSourceKey`, so the diff's read-provenance arm can
   * find the producer output each one read without resolving it again. Set by
   * the diff contexts only; a producer state already in hand rides along.
   */
  crossStackReads?: Map<string, CrossStackRead>;
  /**
   * go-to-k/cdkd#4847: record NO provenance for resolutions in this context.
   * Set on the unpinned lookup that precedes a pinned one, whose version the
   * served value does not carry.
   */
  provenanceSuppressed?: true;
  /**
   * A PRINT-ONLY corpus of LOG-ONLY needles (go-to-k/cdkd#4043): read by the
   * render mask of this resolver's own lines ({@link maskSecretsRaw}) and by
   * nothing that detects, records into {@link recordedSecretValues} or
   * decides. `cdkd diff`'s Outputs pass resolves into bags of its own, whose
   * log-only needles decide which export aliases are refused, so the
   * `NoEcho` values it holds up front reach its lines through here instead.
   * An `Fn::Base64` whose input this corpus masks records its encoding into
   * THIS bag, as a log-only needle, so the encoding prints masked too.
   */
  printingSecrets?: RecordedSecretValues;
  /**
   * Logical ids whose provider declared THIS RUN's `attributes` sensitive —
   * a Lambda-backed custom resource whose handler answered `NoEcho: true`
   * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
   *
   * Set by the deploy engine from the create / update results it has already
   * collected this run, so by the time a DEPENDENT resolves, the producer's
   * entry is present (each resource is provisioned before anything that depends
   * on it, which is what the DAG guarantees).
   *
   * READ-ONLY and never substituted, exactly like {@link inheritedSecrets}:
   * `resolveGetAtt` still returns the REAL attribute value — that is what
   * reaches AWS, and CloudFormation delivers it to a dependent in the clear —
   * and only records the resolved string leaves as MASK-ONLY needles in
   * {@link recordedSecretValues}, i.e. in the bag belonging to the resource
   * whose resolution actually consumed the attribute. Recording at RESOLUTION
   * time rather than pre-seeding every context is what keeps the per-resource
   * scoping every reader of `perResourceSecrets` assumes — the same rule issue
   * #2087 forced on the inherited-secrets channel.
   *
   * `true` declares the WHOLE attributes bag sensitive (a custom resource's
   * `NoEcho` response); a SET names the sensitive members only (a nested
   * stack's `Outputs.<Key>` entries, where the rest of the child's outputs are
   * ordinary and masking them would degrade unrelated parent resources).
   */
  noEchoAttributeResources?: ReadonlyMap<string, true | ReadonlySet<string>>;
  /**
   * go-to-k/cdkd#4043 §3.3: attribute values a producer HELD in this deploy
   * (unchanged, so its record keeps `***`) serves for this resolution only,
   * read back from AWS and matched against a `NoEcho` value the producer was
   * given in this deploy. Consulted only where the record holds the mask, and
   * never written into any record.
   */
  noEchoAttributeOverrides?: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /**
   * The needles of a resource in this stack NAMED from a secret, or
   * `undefined` when it is not (go-to-k/cdkd#3869); the deploy engine answers
   * from its derived-name registry. A `Ref` / `Fn::GetAtt` serving such a
   * resource records them, and each string leaf of the value it served, as
   * LOG-ONLY needles of {@link recordedSecretValues} BEFORE its `resolved to`
   * line: a name derived from a secret, or an ARN embedding one, is no
   * recorded plaintext, so the reading resource's maskers and this
   * resolver's own lines would print it.
   *
   * LOG-ONLY, never a map entry: the value is the reader's real input and is
   * persisted as it is. Absent on a context whose bag DECIDES something from
   * its log-only needles: the masked-input fingerprint pass and the outputs
   * pass, whose export-name verdict reads them.
   */
  secretNameNeedles?: (logicalId: string) => ReadonlySet<string> | undefined;
  /**
   * Where {@link secretNameNeedles}' reads are recorded, when neither the
   * pass's bag nor {@link printingSecrets} may take them (go-to-k/cdkd#3869):
   * a command resolving against state (`cdkd diff`, `import`, `scrub`,
   * `export`) has bags that DECIDE (a child's inherited corpus, a scrub's
   * positions, an import's redaction), and a `printingSecrets` some of them
   * forward into a child. PRINT-ONLY: read by this resolver's render mask
   * alone, never by a detector or anything that records.
   */
  secretNameSink?: RecordedSecretValues;
  /**
   * The secrets bag a resource's resolution recorded in THIS run, by logical
   * id (go-to-k/cdkd#4802): `undefined` for one not resolved this run. A
   * reader served an attribute of a producer updated this run gets the
   * provider's fresh value, in plaintext; the producer's own pairs whose
   * plaintext that value carries are recorded into the READER's bag, so the
   * reader persists the reference form, as a reader of an unchanged producer
   * does (go-to-k/cdkd#4800). Read only for that; never mutated.
   */
  producerSecrets?: (logicalId: string) => RecordedSecretValues | undefined;
  /**
   * The physical id a resource had when this run LOADED its state, by logical
   * id, or `undefined` for one the run did not load (go-to-k/cdkd#4802). A
   * `{{resolve:` reference does not say which secret value it stood for, so
   * {@link producerSecrets}' pairs are copied only for a producer that keeps
   * this id and whose id embeds the plaintext: the same generation, as
   * go-to-k/cdkd#4800's `referencesMatchPhysicalId` requires. A replaced
   * producer's new value must reach the reader, which a reference-to-reference
   * compare would skip.
   */
  producerPreRunPhysicalId?: (logicalId: string) => string | undefined;
  /**
   * The deploy's producer-region evidence (go-to-k/cdkd#4805): the regions this
   * stack's cross-stack reads name, from its state and this run's reads,
   * unioned with a nested child's ancestors', and whether that set is
   * complete. Read ONLY by `reresolveRecordedReferences`, to prove that a
   * region-less `{{resolve:` reference in a persisted record was resolved in
   * this region: complete, with no producer in another region, it cannot
   * have come from another region's stack. `undefined` (absent, or a getter
   * answering nothing) proves nothing. Set by the deploy engine only.
   */
  secretRegionEvidence?: () =>
    | { readonly regions: readonly string[]; readonly complete: boolean }
    | undefined;
  /**
   * Bag the resolver pushes `<logicalId>.<attributeName>` into whenever it
   * serves a PERSISTED attribute that is nothing but {@link SECRET_MASK}
   * (issue #2274).
   *
   * This is the cross-DEPLOY half of the `NoEcho` story, and it exists because
   * the redaction is not free. Once a `NoEcho` custom resource's `Data` has
   * been masked into `state.json`, a LATER deploy that does NOT re-invoke the
   * handler (the resource is `NO_CHANGE`, so CloudFormation semantics say the
   * handler does not run) reads `***` back out of state — and a dependent
   * resolving `Fn::GetAtt` against it would otherwise PUSH that literal to AWS.
   * `state.ts` carries no durable per-attribute `NoEcho` flag to recover from
   * (issue [#2449](https://github.com/go-to-k/cdkd/issues/2449)), so the mask
   * itself is the signal.
   *
   * The resolver RECORDS; it never throws for this, and the difference decides
   * whether a stack stays deployable. A throw inside the diff would be caught
   * by `resolveBestEffort`, which keeps the raw intrinsic — so the desired side
   * would stop matching the `***` in state, the resource would look CHANGED on
   * every run, and the provisioning pass would then fail it. Recording instead
   * leaves the diff comparing `***` against `***`, i.e. a clean NO_CHANGE, so a
   * stack nobody has edited keeps deploying and only a dependent that ACTUALLY
   * has to be written is refused.
   *
   * **PRESENCE OF THE BAG IS THE OPT-IN, so it belongs ONLY on a context whose
   * reads something will READ** (issue #2847 round-4 review). An earlier
   * revision of this note said the deploy engine puts it on EVERY context, the
   * diff one included, on the argument that an unread array costs nothing. That
   * stopped being true the moment `resolveRefValue` began consulting the bag to
   * decide whether {@link refStateLookupFromResource} may SKIP a masked leaf:
   * on the diff context the skip fired with no reader behind it, so `{Ref: X}`
   * resolved to the raw physical id and was compared against the `'***'` in
   * state — a pre-existing #2274 stack that reported NO_CHANGE and deployed
   * clean now reported a spurious UPDATE and then hard-failed at the
   * provisioning refusal. Fail-closed, so never an exposure, but a regression
   * for existing users and a divergence from standalone `cdkd diff` (bagless,
   * still NO_CHANGE). The deploy's `buildResolverContext` therefore takes the
   * bag from its CALLER, and only the two provisioning sites pass one.
   */
  redactedAttributeReads?: RedactedAttributeRead[];

  /**
   * Units this pass could not resolve, recorded instead of abandoning every
   * later unit beside them (issues #3181 / #3218).
   *
   * OPT-IN, exactly like the bag above and for the same reason: the recovery
   * changes what a partially-resolved value looks like, so a caller asks for it
   * on the line where it builds its context rather than inheriting it
   * ambiently. Passing no bag keeps the pre-#3181 behaviour, where the first
   * failing token aborts every later token in the leaf and the first failing
   * key aborts every later key in the bag.
   *
   * **What a CONSUMER owes, and it is not optional: a non-empty bag MUST fail
   * the operation.** Recovery leaves each abandoned unit's input in place, so
   * `resolveValue`'s return can still carry a literal `{{resolve:...}}` token
   * or an unresolved `{"Ref": ...}` — and for a caller that SENDS its resolved
   * value to AWS that is the issue-#2482 shape, where the credential WAS the
   * template text and the deploy exited 0. The two consumers today are
   * `cdkd scrub`, which discards the resolved value and only wants the needles
   * recorded along the way, and this resolver's own tests.
   *
   * What a PUSHER owes: `subject` and `message` must already be LOG text —
   * an assembled reference can put a plaintext in the raw token, and an SDK
   * rejection echoes the name it was given.
   */
  abandonedResolutions?: AbandonedResolution[];
  /**
   * Internal hook used while evaluating the template `Conditions` section.
   * A CFn Condition can reference ANOTHER named condition via
   * `{Condition: OtherName}` inside `Fn::And` / `Fn::Or` / `Fn::Not`
   * (issue #840). When set, the `{Condition: X}` case in `resolveValue`
   * delegates to this resolver, which lazily evaluates condition `X`
   * (recursing into its own `{Condition: ...}` references) and memoizes
   * the result so declaration order in the `Conditions` block does not
   * matter and cycles are rejected. Not set when resolving normal
   * resource properties — a `{Condition: X}` reference outside the
   * `Conditions` section is invalid CFn and falls through to the
   * already-evaluated `conditions` map (or the not-found path).
   */
  conditionResolver?: (conditionName: string) => Promise<boolean>;
  /**
   * Set by BEST-EFFORT callers (the diff calculator's
   * `resolveBestEffort`, which catches resolution failures and keeps the
   * raw intrinsic) where a `Ref` to a resource that is not in state yet is
   * the EXPECTED case — the classic CDK logical-id-churn dance (an
   * `AWS::ApiGateway::Deployment` hash rotation, a `fn.currentVersion`
   * Lambda Version) makes the new template reference a resource this same
   * deploy will CREATE. When true, the resolver's "Ref not found" log is
   * demoted from warn to debug so a routine diff is not noisy (issue
   * #1017); the throw itself is unchanged. Deploy-time resolution leaves
   * this unset, keeping the warn as a genuine error signal.
   */
  bestEffort?: boolean;
  /**
   * When true, SECRET `{{resolve:...}}` dynamic references are left UNRESOLVED
   * (the expression string is returned verbatim). Set by the diff / no-op
   * comparison paths (GHSA fix): cdkd now persists the unresolved expression to
   * state (CloudFormation semantics — the substitution keeps the secret value
   * out of the persisted bag wherever the redaction can certify the position).
   * That is a redaction pass, not a guarantee about `state.json`: positions it
   * cannot certify keep what they were handed, ON THE DEPLOY PATH TOO — an
   * unchanged resource's `drainObservedCaptures` baseline reaches the persist
   * choke point with an empty secrets map (go-to-k/cdkd#2012,
   * go-to-k/cdkd#2852) — and other commands widen it further
   * (go-to-k/cdkd#2846, go-to-k/cdkd#2847). So a
   * comparison must keep the desired side as its
   * expression too, otherwise a resolved-plaintext-vs-stored-expression compare
   * reports a spurious change on every run and `cdkd diff` would also fetch and
   * print the value. A changed EXPRESSION still shows as a diff; a rotated
   * secret behind an unchanged expression is a no-op, exactly as under
   * CloudFormation.
   *
   * NO secret VALUE is fetched under this flag, but it is not the same as "no
   * AWS call" (issue #1901). A `secretsmanager` reference is secret by its
   * spelling, so it is skipped outright with no call. A plain `ssm` one is
   * secret only when its parameter is a `SecureString`, which is knowable only
   * from `GetParameter` — so a not-yet-classified `ssm` reference DOES cost one
   * call here, made with `WithDecryption: false` so a `SecureString` comes back
   * as ciphertext (never substituted, cached or persisted) and a `String` /
   * `StringList` resolves exactly as it must. The verdict is memoized per
   * expression, so each reference pays that call at most once per process.
   */
  skipDynamicReferences?: boolean;

  /**
   * Receives every SECRET `{{resolve:...}}` token a
   * {@link skipDynamicReferences} pass leaves unresolved: exactly the tokens
   * the real pass replaces with their plaintext (issue
   * [#4929](https://github.com/go-to-k/cdkd/issues/4929)). `cdkd diff
   * --recursive` reads it off a nested-stack row's `Parameters` resolution to
   * learn which tokens in a child's parameter values stand for a secret
   * ({@link secretStandInTokens}). Write-only; the deploy never sets it.
   */
  skippedSecretReferences?: Set<string>;

  /**
   * Token spellings that stand for a plaintext the REAL pass holds where this
   * {@link skipDynamicReferences} pass holds the token (issue
   * [#4929](https://github.com/go-to-k/cdkd/issues/4929)): a nested child's
   * parameter value its parent's real pass resolved. The comparison twin of a
   * pair on {@link inheritedSecrets}, for a pass that fetched no secret and so
   * holds no pair (`cdkd diff --recursive`). Read by `Fn::Split` alone, which
   * keeps such a token whole as the real split keeps its plaintext. Never set
   * from a token's spelling alone: token TEXT the real pass passes through as
   * text (a `Ref` to a parameter spelling one, an `Fn::FindInMap` value) is
   * split as text there.
   */
  secretStandInTokens?: ReadonlySet<string>;

  /**
   * The FOREIGN-region evidence for the secret-region classification issue
   * [#2134](https://github.com/go-to-k/cdkd/issues/2134) performs inside
   * `resolveDynamicReferences` (`dynamic-refs.ts`) -- the producer
   * regions this stack is on record as reading from, i.e.
   * `producerRegionsFromState(state)` over `state.imports[].sourceRegion` plus
   * `state.outputReads[].sourceRegion`.
   *
   * **Opt-in, and its ABSENCE is meaningful rather than a default.** Supplying
   * it arms the `ambiguous` REFUSAL: a name-form secret reference in a stack
   * that reads across a region boundary cannot be attributed to a region, so
   * the resolver declines rather than fetching a possibly-different secret.
   * Omitting it leaves every name-form reference `local`, which is the
   * pre-#2134 behaviour exactly.
   *
   * **`cdkd deploy` deliberately does NOT supply it, and that is a decision
   * rather than an omission.** The classifier's refusal is per-STACK, not
   * per-reference -- the evidence cannot say WHICH reference crossed the
   * boundary -- so arming it on deploy would refuse the ordinary CDK
   * `secretValueFromJson` shape (a plain name-form reference) in any stack
   * that also happens to hold one cross-region import, and templates that
   * deploy today would stop deploying.
   *
   * **`cdkd scrub` is the ONLY supplier**, and the precision matters because an
   * earlier draft of this paragraph named `cdkd drift` and the rollback replay
   * as well. They do NOT supply it: each classifies per token in its own
   * `*Resolvers` wrapper BEFORE calling the resolver, so a reference they route
   * arrives already attributed and never reaches the arm below. Scrub supplies
   * it because a wrong-region answer there is a silent MISS -- the stack
   * reported clean over surviving plaintext -- and failing closed is the point.
   *
   * A supplier must also make the refusal SURVIVE its own error handling.
   * Scrub wraps each resolution pass in a best-effort `catch`, so it re-raises
   * {@link DynamicReferenceRegionAmbiguousError} explicitly; swallowed, the
   * refusal produces exactly the silent success it exists to prevent (issue
   * #2134 review). Any future supplier owes the same.
   *
   * The other half of #2134 needs no evidence at all and is therefore always
   * armed, deploy included: a reference naming a full ARN says its own region,
   * so it is routed to a resolver pinned there rather than fetched against
   * this stack's endpoint.
   */
  producerRegions?: readonly string[];

  /**
   * Re-reads a state record's attributes from AWS when `Fn::GetAtt` is about to
   * take the physical-id fallback for it (issue
   * [#1852](https://github.com/go-to-k/cdkd/issues/1852)) — a record written
   * before its provider recorded the attribute is never re-recorded by a
   * no-change deploy, so without this the fallback's refusal is permanent.
   *
   * OPT-IN by presence, like the bags above. Only a caller that can ROUTE a
   * record to its provider supplies it: `DeployEngine` does, on every context
   * it builds, and persists what the read returns; `cdkd diff` supplies a
   * `readOnly` one (`read-only-attribute-healer.ts`) that persists nothing. A
   * context without one keeps the pre-#1852 behaviour exactly — no AWS call is
   * ever issued on its behalf. The supplier owns single-flight, memoization and
   * any persistence; the resolver only asks, and only on a MISS.
   */
  attributeHealer?: StaleAttributeHealer;

  /**
   * INTERNAL to `resolveGetAtt`'s heal wrapper, which sets it on a DERIVED
   * context for one resolution. Never set by a caller.
   */
  staleAttributeHeal?: StaleAttributeHealPhase;
}
