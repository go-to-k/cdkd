import { DeployEngine } from '../../deploy-engine.js';
import { displayIdent, safeMsg } from '../../../utils/display-safe.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { keyOrderFreeJson } from '../../deploy-value-equality.js';
import {
  SECRET_MASK,
  freshNoEchoValuesOf,
  isMaskOnlyPlaintext as isMaskOnlyPlaintextOf,
  noEchoCoordinatesOf,
  valueAtCoordinate,
  type RecordedSecretValues,
  recordNoEchoAttributeValues,
} from '../../secret-redaction.js';
import { noEchoPositionSources } from '../noecho.js';
import type { MaskingDeps, SecretsRunState } from '../masking.js';

/**
 * Redact resolved secret plaintext out of rollback-journal operations (GHSA
 * fix). Each op may carry resolved `properties` / `attemptedProperties` and a
 * `previousState` snapshot (whose `properties` / `attributes` /
 * `observedProperties` also hold resolved values). Each op is redacted with
 * the secrets recorded for ITS OWN resource (`perResourceSecrets`), so a
 * whole-secret value from one resource cannot rewrite another's literal.
 * Preserves ops that carry none of those fields, or whose resource recorded
 * no secret.
 *
 * The POSITION source matters MORE here than anywhere else (issue #1910).
 * This journal is not just persisted, it is REPLAYED to AWS by the rollback
 * executor's `resolveReplayProps`, so a leaf redacted onto a SIBLING's
 * expression — which is what the value-keyed map does when two expressions
 * resolve to one value — re-resolves at replay time to the wrong reference.
 * For two `:AWSCURRENT` / `:AWSPREVIOUS` stages of one secret that is the
 * wrong VERSION shipped to the live resource the moment the two diverge.
 *
 * The two SIDES take different sources, and conflating them would be a fresh
 * defect rather than a simplification: `properties` / `attemptedProperties`
 * are this deploy's DESIRED bags, produced by resolving the CURRENT template,
 * so the template bag positions them. `previousState` is a record read back
 * from STATE, whose leaves already hold expressions from whenever it was
 * written — the current template is not its source and may not even have the
 * same shape — so it is redacted against ITSELF via `scrubResourceRecord`,
 * the same #1900 fallback an UNCHANGED resource takes.
 */
/**
 * Take a provider's `noEchoAttributes` declaration and turn it into REDACTION
 * (issue [#2274](https://github.com/go-to-k/cdkd/issues/2274)).
 *
 * TWO registrations, and both are needed because `perResourceSecrets` is
 * keyed by LOGICAL ID:
 *
 * - the values go into the PRODUCER's own bag, which is what
 *   `scrubResourceRecord` redacts this record's `attributes` with;
 * - the logical id goes into `NoEchoRunState.noEchoAttributeResources`, which every
 *   later resolution consults, so a DEPENDENT that resolves an `Fn::GetAtt`
 *   here records the same plaintext into ITS bag and its resolved
 *   `properties` are masked too. Without the second half the custom resource's
 *   record would be clean while the SSM parameter that consumed it still held
 *   the plaintext — a line that cannot be explained to someone who set
 *   `NoEcho` expecting "not in state".
 *
 * Called AFTER the provider returns and BEFORE the state record is built, so
 * the needles exist by the time anything is persisted. Nothing is masked in
 * memory: `stateResources[logicalId].attributes` keeps the REAL value, which
 * is what the resolver serves to dependents in this same run.
 *
 * `ownProperties` is the resource's OWN resolved template bag, and passing it
 * is what stops a handler from masking cdkd's inputs back at it (issue #2274
 * review). Its whole string leaves are EXCLUDED from the needles: a handler
 * echoing `event.ResourceProperties` into its `Data` — the shape the CDK
 * `Provider` samples encourage — makes `Data.X` equal the resource's own
 * `ServiceToken`, and registering that rewrites `properties.ServiceToken` to
 * `***` in the record `CustomResourceProvider.delete` reads it back from,
 * which can then no longer address the handler and skips the delete
 * (go-to-k/cdkd#3938).
 * A value already present in the template is not handler-GENERATED, so
 * excluding it gives up no secrecy — and where the template value IS a
 * resolved secret it already carries a real EXPRESSION needle, which
 * `recordMaskOnlyValue` would refuse to demote anyway.
 */
export function registerNoEchoAttributes(
  run: SecretsRunState,
  deps: MaskingDeps,
  logicalId: string,
  result: {
    attributes?: Record<string, unknown>;
    noEchoAttributes?: boolean;
    noEchoAttributeNames?: readonly string[];
  },
  secrets: RecordedSecretValues,
  ownProperties?: Record<string, unknown>
): void {
  // The needles are the shared half (`recordNoEchoAttributeValues`, which the
  // rollback executor's record rebuilds call too, go-to-k/cdkd#4434); what is
  // the ENGINE's alone is remembering the declaration for dependents.
  const declared = recordNoEchoAttributeValues(result, secrets, ownProperties);
  // go-to-k/cdkd#4043 §3.3: an attribute that ECHOES a `NoEcho` value this
  // resource was given (`AWS::SSM::Parameter`'s `Value`) is declared too, so a
  // same-stack `Fn::GetAtt` reader masks it and its record persists `***`
  // there whatever the value's type or length.
  const echoed = echoedNoEchoAttributes(
    run,
    deps,
    logicalId,
    result.attributes,
    secrets,
    ownProperties,
    (result as { physicalId?: unknown }).physicalId
  );
  if (declared === true) {
    deps.noEchoRun().noEchoAttributeResources.set(logicalId, true);
  } else if (declared !== undefined || echoed.size > 0) {
    deps
      .noEchoRun()
      .noEchoAttributeResources.set(logicalId, new Set([...(declared ?? []), ...echoed]));
  }
}

/**
 * The attributes of a provider result that hold a `NoEcho` value the resource
 * itself was given in this deploy: a leaf equal to, or embedding, a fresh
 * needle of its bag, or equal to the resolved leaf at one of its `NoEcho`
 * PARAMETER positions (a `Number`, a value under the needle floor).
 */
function echoedNoEchoAttributes(
  run: SecretsRunState,
  deps: MaskingDeps,
  logicalId: string,
  attributes: Record<string, unknown> | undefined,
  secrets: RecordedSecretValues,
  ownProperties: Record<string, unknown> | undefined,
  physicalId?: unknown
): Set<string> {
  const echoed = new Set<string>();
  if (attributes === undefined) return echoed;
  const fresh = [...(freshNoEchoValuesOf.get(secrets) ?? [])].filter((value) =>
    isMaskOnlyPlaintextOf(secrets, value)
  );
  const templateProps = run.perResourceTemplateProps.get(logicalId);
  const sources = noEchoPositionSources(deps.noEchoRun());
  // A POSITIONED value (a `Number`, one under the needle floor) counts only
  // for the attribute named like the property it was given through
  // (`AWS::SSM::Parameter`'s `Value`): a short value equals unrelated
  // attributes too often to declare them on equality alone. A number may come
  // back as its string spelling.
  const positioned = new Map<string, Set<string>>();
  if (templateProps !== undefined && ownProperties !== undefined && sources !== undefined) {
    for (const coordinate of noEchoCoordinatesOf(templateProps, ownProperties, {
      parameters: sources.parameters,
      ...(sources.conditions !== undefined && { conditions: sources.conditions }),
    })) {
      const name = coordinate[0];
      if (typeof name !== 'string') continue;
      const value = valueAtCoordinate(ownProperties, coordinate);
      const spellings = positioned.get(name) ?? new Set<string>();
      spellings.add(keyOrderFreeJson(value));
      if (typeof value === 'number' || typeof value === 'boolean') {
        spellings.add(keyOrderFreeJson(String(value)));
      }
      positioned.set(name, spellings);
    }
  }
  const holds = (name: string, value: unknown): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === 'string') {
      if (value === SECRET_MASK) return false;
      // The physical id only NAMES the resource: AWS publishes it, and it
      // stays in the clear (design §3.3). So does an ARN that merely CONTAINS
      // a value; one EQUAL to a value is the value.
      if (value === physicalId) return false;
      if (fresh.includes(value)) return true;
      if (!value.startsWith('arn:') && fresh.some((needle) => value.includes(needle))) return true;
    }
    return positioned.get(name)?.has(keyOrderFreeJson(value)) === true;
  };
  for (const [name, value] of Object.entries(attributes)) {
    if (holds(name, value)) echoed.add(name);
  }
  return echoed;
}

/**
 * Refuse to provision a resource whose resolution served a REDACTED attribute
 * out of a previous deploy's state (issue #2274).
 *
 * The unavoidable cost of masking a `NoEcho` custom resource's `Data`: state
 * then holds `***`, and cdkd cannot get the value back without re-invoking
 * the handler, which is a SIDE-EFFECTING operation it must not perform just
 * to fill in a property. Since `ResourceState` carries no durable `NoEcho`
 * flag (issue #2449), there is not even a way to tell the user which
 * attribute it was without this record.
 *
 * REFUSING IS THE SAFE DIRECTION and the alternative is not "it works": the
 * literal `***` would be written to the live resource by any provider that
 * sends its desired bag wholesale (`PutParameter` and every
 * `Put*Configuration`), which is the issue #1498 / #1501 data-corruption
 * class. A loud failure naming the remedy is strictly better than a silent
 * wrong write.
 *
 * NARROW BY CONSTRUCTION. The bag is only non-empty when a resolution
 * actually served a masked value during THIS resource's resolution, so a
 * resource whose properties merely happen to contain the string `***` is
 * untouched — which is why the check is not "does `resolvedProps` hold the
 * mask". And the diff pass does not consult the bag at all, so an untouched
 * stack still reports NO_CHANGE and deploys.
 *
 * "A resolution", not "an `Fn::GetAtt`": the pushers are
 * `noteAttributeSecrecy`, `reresolveCrossStackValue` and — since the issue
 * #2847 review — `noteRefStateMask`, the `Ref` branch that reads a recovery
 * key out of the same persisted bags. {@link DeployEngine.maskedRecordRemedyFor}
 * is the authority on the full shape list.
 *
 * Keep this block DIRECTLY above its function: only the LAST of two
 * consecutive block comments attaches (the rule `cloud-control-provider.ts`'s
 * `import()` doc warns about), so a helper inserted into the gap silently
 * takes this doc.
 */
export function refuseRedactedAttributeReads(
  logicalId: string,
  resourceType: string,
  context: import('../../intrinsic-function-resolver.js').ResolverContext
): void {
  const reads = context.redactedAttributeReads;
  if (reads === undefined || reads.length === 0) return;
  // THREE POPULATIONS REACH THIS REFUSAL, and naming only the first was a
  // measured defect (issue
  // [#2847](https://github.com/go-to-k/cdkd/issues/2847) review): since
  // `CloudControlProvider.import` masks the model keys it cannot certify as
  // attributes, a Cloud-Control-IMPORTED resource trips this too — and every
  // remedy below is custom-resource-only, so the user was handed three
  // instructions that cannot apply and none that can. The record carries no
  // durable marker saying WHICH population a mask came from (issue #2449 is
  // that gap), so the message names each rather than guessing.
  //
  // ARM (2), the `Fn::Base64` encoding of a secret, is issue
  // [#2881](https://github.com/go-to-k/cdkd/issues/2881)'s. `resolveBase64`
  // registers that encoding as a mask-only needle (issues #2759 / #3119), and
  // `scrubResourceRecord` redacts a record's `attributes` with the same bag as
  // its `properties` — so a provider echoing the property as an attribute
  // (`AWS::SSM::Parameter`'s `Value`, which CDK's `StringParameter.stringValue`
  // reads through `Fn::GetAtt`) persists `***` there, and a later deploy
  // reading it from state lands here through `noteAttributeSecrecy`
  // (`deploy-engine-base64-attribute-refusal.test.ts` drives that route end
  // to end). An Output built over the encoding is the cross-stack twin: the
  // outputs pass records the needle into the bag {@link redactOutputs} folds
  // in, so a consumer deployed in a LATER run reads `***` through
  // `reresolveCrossStackValue`. The encoding is never recorded, so a deploy
  // that leaves its holder unchanged reads the mask again, and a re-import
  // cannot supply it either (the SSM provider's `import()` records `Value`
  // only for a plain literal). The one remedy true of every shape is the
  // consumer building the value itself.
  //
  // ARM (3) NAMES ONE ACTION AND DOES NOT ENUMERATE CAUSES, and that shape is
  // the point rather than brevity. Successive review rounds each rewrote this
  // arm as a cause list with a remedy per cause, and each list was wrong in a
  // NEW way — a remedy that could not apply, then a cause that cannot produce
  // this refusal, then a remedy necessary but not sufficient. Do not re-expand
  // it into a list: the causes are not enumerable from here —
  // `getTopLevelAttributeNames` answers `undefined` for any failure at
  // all — so any list written here is a claim the code cannot support.
  //
  // THE TARGET IDS ARE COMPUTED, NOT DESCRIBED, and that is the fix for a
  // defect class rather than for one sentence. This method's `logicalId` is
  // the resource being PROVISIONED — the consumer that read the attribute —
  // while the masked record belongs to the READ's target. Successive rounds
  // tried to convey that in prose and each attempt was wrong for a `reads`
  // shape it had not considered: interpolating `logicalId` named the consumer
  // and told the user to `--force`-overwrite the wrong row; "the name to the
  // left of the dot" reads as `Outputs` for `nested stack Child Outputs.Foo`,
  // as `Cr.Endpoint` for a dotted attribute path like `Cr.Endpoint.Password`,
  // and has no referent at all for the `Fn::ImportValue` /
  // `Fn::GetStackOutput` forms. The population is heterogeneous, so no single
  // instruction describes it — `maskedRecordRemedyFor` PARTITIONS it instead,
  // and each arm says only what is true of its own shape. Adding a `reads`
  // shape means extending that helper, not this prose.
  //
  // THE COMMAND IS SELECTIVE AND CARRIES `--force`, and both halves were
  // traced through `cdkd import` rather than reasoned about. A BARE re-run is
  // actively destructive here: `CloudControlProvider.import` is
  // explicit-override-only, so with no `--resource` the resource resolves to
  // `skipped-not-found`, and auto mode rebuilds the resource map from
  // `{}` — the row is DROPPED from state and the next deploy tries to CREATE
  // a live resource. (Auto mode refuses without `--force` at all, so the user
  // would hit that wall first.) Selective mode merges onto the existing map,
  // and `--force` is required because the listed id already HAS a state entry
  // — the one holding the mask. `import.ts`'s own two refusals are the
  // authority for both clauses. A test pins this string per `reads` shape;
  // the rewrite history above is why it is pinned rather than trusted.
  //
  // ONE CASE THE COMMAND DOES NOT HEAL, narrow but real: if the re-import's
  // `GetResource` again yields no usable model, `import()` returns
  // `attributes: {}`, and `buildStackState`'s same-physical-id carry-over
  // keeps the PREVIOUS masked bag rather than replacing it — so the refusal
  // repeats. Deliberately: dropping the mask would make the read resolve to
  // the physical id instead. The import warns naming each kept key (issue
  // [#2927](https://github.com/go-to-k/cdkd/issues/2927)).
  // go-to-k/cdkd#2449: every read names an attribute its producer DECLARED
  // `NoEcho` (schema v11's `noEchoAttributeNames`), so the cause is known and
  // only its remedy applies. Still a refusal: cdkd never re-runs the producer
  // (maintainer decision on #2449).
  if (reads.every((read) => read.kind === 'attribute' && read.declaredNoEcho === true)) {
    const producers = [
      ...new Set(reads.map((read) => read.logicalId).filter((id): id is string => !!id)),
    ];
    throw new ProvisioningError(
      safeMsg`Cannot resolve ${reads.map((read) => read.display).join(', ')} for ${logicalId}: ` +
        safeMsg`${producers.map((id) => displayIdent(id)).join(', ')} declared ${reads.length === 1 ? 'that attribute' : 'those attributes'} NoEcho, ` +
        safeMsg`so cdkd's recorded state holds only the redaction mask for ${reads.length === 1 ? 'it' : 'them'}, ` +
        `and cdkd does not re-run a producer to recover a value. Remedy: deploy a change to the ` +
        safeMsg`producer in the SAME run as ${logicalId} (for a custom resource, change one of its ` +
        `properties, e.g. a nonce / version property, so its handler runs again and supplies the ` +
        `value), or stop declaring the value NoEcho.`,
      resourceType,
      logicalId
    );
  }
  throw new ProvisioningError(
    safeMsg`Cannot resolve ${reads.map((read) => read.display).join(', ')} for ${logicalId}: cdkd's recorded state holds only the ` +
      `redaction mask there, and the value is not recoverable from state. There are four ways a ` +
      `record comes to hold the mask. (1) A custom resource handler declared its response ` +
      `NoEcho: true — the value is generated by the handler, so cdkd has nothing to re-derive ` +
      `it from and must not write the literal mask to AWS. Remedies: force that custom resource ` +
      `to update (change one of its properties, e.g. a nonce / version property) so its handler ` +
      `runs again and supplies the value in this same run; or stop setting NoEcho on that ` +
      `response. If the value comes from ANOTHER stack, the producer and this stack must deploy ` +
      `in ONE run (cdkd deploy --all, or cdkd deploy '**' when either is inside a CDK Stage) ` +
      `with the producer's custom resource actually running — ` +
      `re-deploying the producer by itself does not help, because it re-masks the value on the ` +
      `way into its own state. (2) The value holds the Fn::Base64 encoding of a secret value ` +
      `(a {{resolve:...}} dynamic reference under Fn::Base64, such as EC2 UserData), which cdkd ` +
      `never records — so a deploy that leaves the resource or output holding it unchanged ` +
      `reads the mask again, and a re-import does not recover it. Remedy: have this resource ` +
      `build the value itself from the SECRET's own reference (the ` +
      `{{resolve:secretsmanager:...}} or {{resolve:ssm-secure:...}} reference, or a ` +
      `{{resolve:ssm:...}} of a SecureString parameter, that the encoding was made from) under ` +
      `its own Fn::Base64, instead of reading it from another resource's attribute or another ` +
      `stack's output — not by a {{resolve:ssm:...}} read of a String parameter holding the ` +
      `encoding, which cdkd treats as public and would record in state in the clear. ` +
      `(3) The resource is recorded through the Cloud Control fallback (by a deploy or by ` +
      `'cdkd import'), which keeps in the clear only the Fn::GetAtt attributes it can vouch ` +
      `for and masks the rest. If the name above is not an Fn::GetAtt attribute CloudFormation ` +
      `accepts for that resource type, no record will ever hold it: stop reading it. If it ` +
      `is one, 'cdkd import' masked it because it could not vouch for the value, or could not ` +
      `read the schema and warned about it when it happened (if that warning named a missing ` +
      `cloudformation:DescribeType permission, grant it first); a deploy that creates or ` +
      `updates the resource records it, unless its value came from a secret. ` +
      `(4) Two secret values cdkd resolved overlap inside the value, so no single ` +
      `{{resolve:...}} reference renders it and cdkd stored the mask rather than part of a ` +
      `secret: change the producer's value (or rotate one of the secrets) so that they no ` +
      `longer overlap, and deploy the producer in the same run as this resource. ` +
      `See https://github.com/go-to-k/cdkd/issues/2449. ` +
      // LAST: the remedy ends in labelled command lines, and prose after them
      // lands on the final command's line (go-to-k/cdkd#3436).
      `${DeployEngine.maskedRecordRemedyFor(reads, context.resources, true)}`,
    resourceType,
    logicalId
  );
}
