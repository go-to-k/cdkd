import { displayIdent, displaySafe, truncateCodePoints } from '../../../utils/display-safe.js';
import { type Tag as CfnTag } from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { cdkdRemedy, proseQuoted } from '../../../utils/pasteable-command.js';
import { type ImportPlanEntry } from './plan-types.js';
import { plainOrNotShown, quotedOrNotShown, rowIdent, showRecordValue } from './render.js';

/**
 * Mutates `template['Resources']` so every entry has a `DeletionPolicy`
 * attribute. Resources already carrying any `DeletionPolicy` value
 * (Delete / Retain / Snapshot) are untouched; resources missing the
 * attribute get `DeletionPolicy: Delete` injected.
 *
 * Required by CloudFormation `ChangeSetType=IMPORT`, which rejects the
 * changeset if any resource in the template lacks `DeletionPolicy`.
 * CDK-synth templates only emit the attribute when the user sets
 * `RemovalPolicy` explicitly, so most resources are missing it.
 *
 * **Why `Delete` (not `Retain`)**: a CDK resource without explicit
 * `RemovalPolicy` defaults to `Delete` at CFn level (the type-default
 * delete behavior). Injecting `Delete` matches that intent verbatim —
 * the user is saying "treat this like the AWS default" and cdkd does
 * exactly that. Injecting `Retain` would be an opinionated override
 * that surprises users (their CFn template suddenly has a `Retain` they
 * never asked for) and adds a "transient injection" concept to the
 * mental model.
 *
 * The narrow scenario where `Retain` would help (cdkd export's phase-2
 * fails AND the user picks `delete-stack` as the recovery path) is not
 * unique to cdkd export and is not the documented recovery path (the
 * phase-2-failure error message walks the user through a manual
 * UpdateStack retry instead). The asymmetric-risk argument doesn't
 * justify the UX cost of the "transient Retain" mental model.
 *
 * `UpdateReplacePolicy` is intentionally NOT injected — only
 * `DeletionPolicy` is required for IMPORT.
 *
 * Returns the number of resources that received an injection.
 *
 * Exported for unit testing.
 */
export function injectDeletionPolicyForImport(template: Record<string, unknown>): number {
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return 0;
  }
  let injected = 0;
  for (const [, resource] of Object.entries(resources as Record<string, unknown>)) {
    if (!resource || typeof resource !== 'object' || Array.isArray(resource)) continue;
    const r = resource as Record<string, unknown>;
    if (r['DeletionPolicy'] === undefined) {
      r['DeletionPolicy'] = 'Delete';
      injected++;
    }
  }
  return injected;
}

export function filterTemplateForImport(
  template: Record<string, unknown>,
  plan: ImportPlanEntry[],
  // Forwarded to `overlayResourceIdentifierOnProperties`. The nested path
  // builds a phase-1 template TWICE over the same entries (1A then 1B), so the
  // second pass must stay silent or every LIST->scalar rewrite is announced
  // twice — the single-stack path has only one pass and keeps the default.
  warnOnRewrite = true
): Record<string, unknown> {
  const allow = new Map(plan.map((p) => [p.logicalId, p] as const));
  const original = template['Resources'] as Record<string, unknown>;
  const filteredResources: Record<string, unknown> = {};
  for (const [logicalId, resource] of Object.entries(original)) {
    const entry = allow.get(logicalId);
    if (!entry) continue;
    filteredResources[logicalId] = overlayResourceIdentifierOnProperties(
      resource,
      entry,
      warnOnRewrite
    );
  }

  const result: Record<string, unknown> = { ...template, Resources: filteredResources };

  // CloudFormation IMPORT changesets do NOT allow Outputs — AWS rejects
  // the changeset with "As part of the import operation, you cannot
  // modify or add [Outputs]". This applies even to Outputs that only
  // reference imported resources. Strip them entirely here; phase 2
  // UPDATE re-submits the full synth template and restores Outputs
  // along with the non-importable resources.
  delete result['Outputs'];

  return result;
}

/**
 * Conditionally overlay `ResourceIdentifier` fields onto the resource's
 * `Properties` to match upstream `cdk import` behavior: pass the synth
 * template through as-is, and let CFn match resources by
 * `ResourcesToImport[].ResourceIdentifier` (the changeset API parameter)
 * regardless of whether `Properties[<IdField>]` is present.
 *
 * **Pre-v0.95 behavior**: cdkd unconditionally wrote every overlay field
 * into `Properties[<IdField>]` (even when synth produced no name property
 * at all). For auto-generated names this baked the cdkd-prefixed value
 * into the post-export CFn template (`Properties.BucketName:
 * 'cdksamplestack-...'`) while CDK synth produced `Properties: {}` (name
 * absent) — so the next `cdk diff` proposed REPLACE on every immutable
 * Name property and the very next `cdk deploy` recreated everything.
 * This defeated the "AWS resources are unchanged across the cdkd→CFn
 * migration" value proposition. Closes [#319].
 *
 * **Post-v0.95 behavior** (this function): override only when synth
 * already carries a *literal* value for the field AND it differs
 * from `ResourceIdentifier`. Four cases (the fourth added by issue #1787,
 * which also widened "literal" past `typeof === 'string'` — see
 * {@link classifyOverlayCurrentValue} for the full classification):
 *
 * - **Absent** (auto-generated names — user did NOT declare a physical
 *   name in CDK code): `Properties[field]` stays absent. Matches
 *   upstream `cdk import`, which submits the synth template untouched
 *   and CFn accepts the IMPORT changeset using `ResourceIdentifier`
 *   alone (verified empirically against AWS SQS in upstream's
 *   `import.test.ts`). Post-export `cdk diff` is clean because both
 *   CFn-managed template and CDK synth have the property absent.
 *
 * - **Intrinsic** (`{Ref: ...}` / `{Fn::GetAtt: ...}` — composite-id
 *   sub-resources whose synth template references the parent via
 *   intrinsic): the intrinsic is preserved. CFn resolves it during
 *   changeset processing — when the referenced parent is in the same
 *   IMPORT changeset, the parent's `ResourceIdentifier.<id>` value is
 *   used — so the resolved value equals the child's
 *   `ResourceIdentifier.<id>` and CFn accepts. Post-export `cdk diff`
 *   stays clean (both sides keep the intrinsic shape).
 *
 * - **Literal-mismatch** (pre-v0.94.0 prefix-on-user-declared-name
 *   legacy: user wrote `roleName: 'foo'` in CDK code; cdkd's deploy
 *   prefixed it to `'CdkSampleStack-foo'` on AWS): override
 *   `Properties.RoleName` from the unprefixed CDK value to the
 *   prefixed AWS value. CFn's identifier-match check requires this
 *   (`Properties[<IdField>]` must equal `ResourceIdentifier[<IdField>]`
 *   when both are literal strings — otherwise AWS rejects with "The
 *   Identifier [<Field>] for resource [...] does not match the
 *   identifier value for the resource in the template"). The override
 *   persists into the CFn-managed template; the next `cdk deploy`
 *   proposes REPLACE because CDK synth still emits the unprefixed
 *   name — same caveat as upstream `cdk import` with mismatched-name
 *   CDK code, and same caveat the prefix-migration pre-flight (PR
 *   #300 / `prefix-migration-check.ts`) is meant to surface before
 *   export. v0.94.0+ stacks with the default `--no-prefix-user-supplied-
 *   names` flip are no longer in this case — Properties.RoleName matches
 *   the AWS name without override.
 *
 * - **Unrepresentable** (a list carrying an intrinsic / a nested list / an
 *   empty list): REFUSED with a message naming the resource, the property and
 *   the scalar to declare instead. Preserving ANY of the three reproduces the
 *   opaque `CreateChangeSet` rejection; what makes OVERRIDING wrong differs per
 *   shape, so {@link refusalReason} says which rather than asserting one cause
 *   for all — only a list actually carrying an object element has an intrinsic
 *   to discard. Either way the command stops before submitting anything
 *   (issue #1787).
 *
 * For literal-match (Properties already has the right value), the
 * override is a no-op.
 */
function overlayResourceIdentifierOnProperties(
  resource: unknown,
  entry: ImportPlanEntry,
  // The overlay runs TWICE per export (phase-1 filter + phase-2 UPDATE
  // template) over the same entries, so an unconditional warn prints every
  // rewrite twice. Phase 1 owns the message; phase 2 stays silent.
  warnOnRewrite = true
): unknown {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    return resource;
  }
  const r = resource as Record<string, unknown>;
  const existingProperties = r['Properties'];
  const properties: Record<string, unknown> =
    existingProperties &&
    typeof existingProperties === 'object' &&
    !Array.isArray(existingProperties)
      ? { ...(existingProperties as Record<string, unknown>) }
      : {};
  // Use propertiesOverlay (subset of resourceIdentifier safe to write into
  // Properties) — not resourceIdentifier itself. Sub-resource types whose
  // primaryIdentifier includes a generated-id field (e.g.
  // AWS::ApiGatewayV2::Integration.IntegrationId) narrow overlay to just the
  // writable subset; CFn rejects unknown property keys at changeset-create.
  // When the entry has no explicit overlay map, fall back to the full
  // resourceIdentifier (matches pre-PR behavior for single-key types and
  // composites whose identifier fields ARE all valid Properties).
  const overlay = entry.propertiesOverlay ?? entry.resourceIdentifier;
  for (const [field, value] of Object.entries(overlay)) {
    const current = properties[field];
    // Only override on literal mismatch. See docstring above for why absent /
    // intrinsic / matching-literal are all left alone, and
    // `classifyOverlayCurrentValue` for why a non-string LITERAL is overridden
    // rather than preserved.
    const kind = classifyOverlayCurrentValue(current);
    if (kind === 'intrinsic' || kind === 'absent') {
      continue;
    }
    if (kind === 'unrepresentable') {
      // Defense in depth. `buildImportPlan` runs the SAME classification and
      // BLOCKS the resource before any AWS write, so reaching here means the
      // pre-flight and this function disagreed — which is a cdkd bug, not a
      // user-fixable template problem. Keeping the throw means the bad value
      // still cannot reach CreateChangeSet.
      throw new Error(unrepresentableOverlayMessage(entry, field, current, value));
    }
    if (current !== value) {
      if (warnOnRewrite && typeof current !== 'string') {
        // The three cases the pre-#1787 rule handled were all string-vs-string,
        // so a rewrite was invisible by construction. Rewriting a LIST or a
        // number is a shape change the user inherits in the CFn-managed
        // template, and their next `cdk deploy` diffs against it — so say so
        // rather than truncating silently.
        getLogger().warn(
          `${rowIdent(entry.logicalId)} (${rowIdent(entry.resourceType)}): rewriting ` +
            `the identifier property ${displayIdent(field)} from ` +
            `${describeOverlayValueShape(current)} to the scalar ${showRecordValue(value)} ` +
            `recorded in cdkd state. CloudFormation types this property as a string; the ` +
            `exported template will carry the scalar.`
        );
      }
      properties[field] = value;
    }
  }
  return { ...r, Properties: properties };
}

/**
 * Why a given `unrepresentable` value is refused rather than rewritten.
 *
 * THREE shapes reach `unrepresentable`, and they are refused for two different
 * reasons — an earlier revision of this message asserted the intrinsic reason
 * for all of them, which is false for two of the three. The distinction is not
 * cosmetic: a message that names a cause the value does not have sends the user
 * looking for an intrinsic that is not there.
 */
function refusalReason(current: unknown): string {
  if (Array.isArray(current) && current.length === 0) {
    return 'cdkd will not invent a scalar where the template declared no value';
  }
  // Only a list that actually CARRIES an object element has an intrinsic to
  // protect. A nested list, or one holding `null`, has none — it is simply not
  // representable as the scalar the schema declares.
  const carriesIntrinsic =
    Array.isArray(current) &&
    current.some((e) => e !== null && typeof e === 'object' && !Array.isArray(e));
  return carriesIntrinsic
    ? 'cdkd will not rewrite it, because doing so would discard the intrinsic it carries'
    : 'cdkd will not replace a value it cannot represent as the scalar the schema declares';
}

/**
 * The shared message for a refused overlay value — used by the pre-flight in
 * {@link buildImportPlan} (which BLOCKS the resource) and by
 * {@link overlayResourceIdentifierOnProperties}'s defense-in-depth throw, so
 * the two cannot drift into describing the same defect differently.
 */
export function unrepresentableOverlayMessage(
  entry: { logicalId: string; resourceType: string },
  field: string,
  current: unknown,
  value: string
): string {
  return (
    `${rowIdent(entry.logicalId)} (${rowIdent(entry.resourceType)}): the identifier ` +
    `property ${displayIdent(field)} is ` +
    `${describeOverlayValueShape(current)}, but CloudFormation types it as a string. ` +
    `${refusalReason(current)}. ` +
    `Declare ${displayIdent(field)} as the scalar ${showRecordValue(value)} (or drop the ` +
    `addPropertyOverride that ` +
    `made it a list) and re-run ${proseQuoted(cdkdRemedy('cdkd export'))}.`
  );
}

/**
 * Every overlay field of `entry` whose value in `resource`'s `Properties` is
 * {@link classifyOverlayCurrentValue}-`unrepresentable`.
 *
 * Exists so the refusal happens during PLANNING rather than during template
 * preprocessing. `overlayResourceIdentifierOnProperties` is called from three
 * places, and two of them are past the point of no return: `--dry-run` returns
 * BEFORE any overlay call (so a dry run would report a clean plan for a
 * template the real run aborts on), and the nested-stack path calls it inside
 * the per-stack IMPORT loop — where a throw on stack N leaves stacks 1..N-1
 * already imported, outside the loop's own "stacks imported so far" recovery
 * handler. Running the same classification in `buildImportPlan` puts the
 * verdict where every other unfixable-resource verdict already lives: reported
 * for EVERY offender at once, before the lock, before dry-run's return, and
 * before any AWS write.
 */
export function unrepresentableOverlayFields(
  resource: unknown,
  overlay: Record<string, string>
): { field: string; current: unknown; value: string }[] {
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) return [];
  const props = (resource as Record<string, unknown>)['Properties'];
  if (!props || typeof props !== 'object' || Array.isArray(props)) return [];
  const bag = props as Record<string, unknown>;
  const out: { field: string; current: unknown; value: string }[] = [];
  for (const [field, value] of Object.entries(overlay)) {
    if (classifyOverlayCurrentValue(bag[field]) === 'unrepresentable') {
      out.push({ field, current: bag[field], value });
    }
  }
  return out;
}

/**
 * Classify what the synth template currently carries at an identifier field,
 * for {@link overlayResourceIdentifierOnProperties} (issue #1787).
 *
 * The pre-#1787 rule was `typeof current === 'string'`, which is correct for
 * the two cases it was designed for (an absent key, and a `Ref` / `Fn::GetAtt`
 * intrinsic that must be preserved — issue #319) and WRONG for a third,
 * reachable case: a field the template carries as a non-string LITERAL. The
 * measured instance is `AWS::S3Tables::Namespace`, whose CFn registry type is
 * `{"type": "string"}` and whose CDK L1 emits a string, but
 * `addPropertyOverride('Namespace', ['analytics'])` synthesizes
 * `"Namespace": ["analytics"]` — which cdkd deploys, because
 * `s3-tables-provider.ts` accepts both wire shapes. The array is not a literal
 * string, so the overlay left it alone and it reached `CreateChangeSet`, where
 * CFn answered with an opaque rejection.
 *
 * The classification, and why each arm is what it is:
 *
 * - `absent` (`undefined` only) — unchanged. An auto-generated name the user
 *   never declared; CFn accepts the IMPORT on `ResourceIdentifier` alone. An
 *   explicit `null` is deliberately NOT here: the key IS present, the shallow
 *   Properties copy keeps it, and `"Namespace": null` then reaches
 *   `CreateChangeSet` — the same opaque-rejection class as the array, through
 *   the same `addPropertyOverride` hatch. It is a literal, and overwritten.
 * - `intrinsic` (a non-array object) — unchanged. `{Ref: Parent}` /
 *   `{Fn::GetAtt: [...]}` resolve during changeset processing to exactly this
 *   resource's `ResourceIdentifier` value, so clobbering them would only make
 *   the post-export `cdk diff` dirty (issue #319).
 * - `literal` (string / number / boolean, or an array of those) — OVERRIDDEN
 *   with the overlay value. This is not a guess: the overlay value comes from
 *   the cdkd-recorded physicalId, which is the authority on what the resource
 *   IS, while the template side is only what CDK happened to synthesize. So a
 *   single-element `['analytics']` and a bare `analytics` both become the
 *   scalar CFn's schema declares, exactly as the pre-existing prefixed-name
 *   literal-mismatch case already does.
 * - `unrepresentable` (an array containing an object / array / null, or an
 *   EMPTY array) — REFUSED. Preserving any of them ships the same opaque CFn
 *   rejection this change exists to remove; the reason OVERRIDING is wrong
 *   differs by shape, and {@link refusalReason} splits it three ways rather
 *   than asserting one cause:
 *     - a list carrying an OBJECT element — overriding discards an intrinsic
 *       the user wrote;
 *     - a NESTED list, or one holding `null` — no intrinsic to protect, it is
 *       simply not representable as the declared scalar;
 *     - an EMPTY list — nothing to reconcile against the identifier, and
 *       materializing a scalar where the template declared "no value" is the
 *       invention this classification exists to avoid.
 *   Saying "would discard an intrinsic" for all three was the defect the
 *   #1787 review round removed; do not re-collapse it.
 */
function classifyOverlayCurrentValue(
  current: unknown
): 'absent' | 'intrinsic' | 'literal' | 'unrepresentable' {
  if (current === undefined) {
    return 'absent';
  }
  if (current === null) {
    // Present-but-null. See the `absent` note above: skipping this would leave
    // the key in the emitted template.
    return 'literal';
  }
  if (Array.isArray(current)) {
    if (current.length === 0) {
      return 'unrepresentable';
    }
    return current.every(
      (e) => typeof e === 'string' || typeof e === 'number' || typeof e === 'boolean'
    )
      ? 'literal'
      : 'unrepresentable';
  }
  if (typeof current === 'object') {
    return 'intrinsic';
  }
  return 'literal';
}

/**
 * How much of an overlay value's JSON this function is willing to quote back.
 *
 * CODE POINTS, not UTF-16 code units — see {@link boundedOverlayPreview}. The
 * number is the pre-go-to-k/cdkd#3018 one, kept so no in-range message moves.
 */
const OVERLAY_PREVIEW_MAX_CODE_POINTS = 120;

/**
 * `JSON.stringify(value)`, cut to {@link OVERLAY_PREVIEW_MAX_CODE_POINTS} code
 * points through the shared helper rather than by `slice` (go-to-k/cdkd#3018).
 *
 * `String.prototype.slice` counts UTF-16 code units, so a cut landing between
 * the halves of an astral character leaves a LONE HIGH SURROGATE at the end of
 * the preview — `JSON.stringify` emits an astral character as the raw pair
 * rather than as two `\u` escapes, so the pair really is what gets cut.
 * `truncateCodePoints` in `src/utils/display-safe.ts` owns that rule, and this
 * is the site go-to-k/cdkd#3018 was opened over. Other `slice`-based display
 * truncations remain elsewhere (`src/local/websocket-server.ts` among them);
 * closing this one is not a claim about them.
 *
 * Deliberately NOT applied to the SCALAR branch below, which is the arm that
 * cannot exceed the cap: tracing the two call sites, it is reachable only with
 * a NUMBER or a BOOLEAN. A string `current` never reaches the rewrite warning
 * (`typeof current !== 'string'` gates it) and never reaches the refusal (only
 * a list classifies `unrepresentable`), and a number arriving from a parsed
 * template is a double, so its JSON is a couple of dozen characters. Capping it
 * anyway would be behaviour no test can distinguish from not capping it, which
 * is worse than the asymmetry: it reads as a guard while pinning nothing.
 */
function boundedOverlayPreview(value: unknown): string {
  // SANITIZED as well as cut. `JSON.stringify` escapes C0, which is why this
  // looked safe, but it leaves `U+0085`, the C1 range, `U+2028` / `U+2029` and
  // the Trojan-Source bidi overrides verbatim — every mechanism that forges a
  // line or reorders one in a terminal or a JSON log viewer. The value is a
  // TEMPLATE's rather than a state record's, so it is less exposed than an
  // identifier, but the text lands in an error a failed export persists and
  // sanitizing costs nothing. The DENYLIST rather than `asciiOnly`: this is
  // JSON of arbitrary user content, not an identifier with a known charset.
  const { text, truncated } = truncateCodePoints(
    displaySafe(JSON.stringify(value)),
    OVERLAY_PREVIEW_MAX_CODE_POINTS
  );
  return truncated ? `${text}…` : text;
}

/**
 * Human-readable shape of an overlay value, for the refusal error and the
 * rewrite warning. Bounded: the value is user-supplied and lands in an error
 * message that a failed export persists, so a large value is summarized rather
 * than serialized whole.
 */
function describeOverlayValueShape(current: unknown): string {
  if (Array.isArray(current)) {
    if (current.length === 0) return 'an empty list';
    return `a ${current.length}-element list (${boundedOverlayPreview(current)})`;
  }
  if (current === null) return 'an explicit null';
  return `a ${typeof current} (${JSON.stringify(current)})`;
}

/**
 * Build the phase-2 UPDATE template: full synth template with the same
 * conditional overlay applied to every phase-1 import. Phase-1 and
 * phase-2 must stay symmetric — when `overlayResourceIdentifierOnProperties`
 * touches a field in phase 1, phase 2 must also have that touch — or
 * CFn sees a "property removed / changed" diff between the phase-1
 * IMPORT'd state and a raw phase-2 synth template, triggering silent
 * REPLACEMENT of every imported resource whose touched property is
 * immutable (see PR #316 for the silent-REPLACE bug that first
 * surfaced this asymmetry).
 *
 * Closes [#319]: as of v0.95 the overlay is **conditional** — it only
 * fires when synth has a literal-string value for the field that differs
 * from `ResourceIdentifier` (the pre-v0.94.0 prefix-on-user-declared-name
 * legacy case). For auto-generated names (Properties absent) and
 * composite-id intrinsics (`{Ref: ...}`), no overlay is applied — and
 * since both phase-1 and phase-2 walk the same `overlayResourceIdentifier
 * OnProperties` logic, the symmetry holds with no extra phase-2 handling
 * required. Post-export `cdk diff` is clean for the no-overlay cases
 * (matches upstream `cdk import` behavior).
 *
 * Resources outside `phase1Imports` (phase-2 CREATE Custom Resources,
 * pre-delete + recreate targets like IAM::Policy) are passed
 * through unchanged — they get CREATEd from synth and don't have any
 * pre-existing Properties state to preserve.
 *
 * Exported for unit testing.
 */
export function applyImportOverlayForPhase2(
  template: Record<string, unknown>,
  phase1Imports: ImportPlanEntry[]
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(template)) as Record<string, unknown>;
  const resources = result['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) {
    return result;
  }
  const resourcesMap = resources as Record<string, unknown>;
  for (const entry of phase1Imports) {
    const r = resourcesMap[entry.logicalId];
    if (r !== undefined) {
      resourcesMap[entry.logicalId] = overlayResourceIdentifierOnProperties(r, entry, false);
    }
  }
  return result;
}

/**
 * A `Fn::GetStackOutput` reference found in another stack's template,
 * pointing at the stack being exported. Produced by `scanCrossStackReferences`.
 */
export interface CrossStackReference {
  /** Logical ID of the stack that contains the reference. */
  consumerStackName: string;
  /** OutputName from the `Fn::GetStackOutput` call. */
  outputName: string;
  /** Where in the consumer template the reference appears (Resources / Outputs path). */
  location: string;
}

/**
 * One row of the cross-stack-reference list (go-to-k/cdkd#3371). Every part
 * comes from a synthesized template or the stack selection: the names through
 * {@link quotedOrNotShown}, and the template PATH through
 * {@link plainOrNotShown}: bare when it is a plain identifier inert on a
 * command line (`Resources.X.Properties.Y`), described otherwise — including
 * a `Tags[0]`-style path, whose `[` a shell treats as a glob. Exported for unit
 * testing.
 */
export function crossStackRefLine(ref: CrossStackReference, exportingStackName: string): string {
  return (
    `  ${quotedOrNotShown(ref.consumerStackName)} → output ${quotedOrNotShown(ref.outputName)} ` +
    `of ${quotedOrNotShown(exportingStackName)} at ` +
    plainOrNotShown(ref.location)
  );
}

/**
 * Walk every stack other than `exportingStackName` looking for
 * `Fn::GetStackOutput` calls that target the exporting stack. Used as a
 * safety pre-flight before `cdkd export`: after the exporting stack
 * moves to CloudFormation, its outputs live in CFn (not cdkd state), so
 * cdkd's `Fn::GetStackOutput` resolver — which reads cdkd state — can
 * no longer find them.
 *
 * Implementation: recursive walk of each non-exporting stack's template,
 * collecting every `{"Fn::GetStackOutput": {StackName: <exporting>, OutputName: <name>}}`
 * entry. The intrinsic accepts either an object form
 * (`{StackName: ..., OutputName: ...}`) or — historically — an array
 * form (`[stackName, outputName]`); we accept both.
 *
 * Exported for unit testing.
 */
export function scanCrossStackReferences(
  stacks: Array<{ stackName: string; template: unknown }>,
  exportingStackName: string
): CrossStackReference[] {
  const refs: CrossStackReference[] = [];
  for (const stack of stacks) {
    if (stack.stackName === exportingStackName) continue;
    walkForGetStackOutput(stack.template, '', (ref) => {
      if (ref.stackName === exportingStackName) {
        refs.push({
          consumerStackName: stack.stackName,
          outputName: ref.outputName,
          location: ref.location,
        });
      }
    });
  }
  return refs;
}

function walkForGetStackOutput(
  node: unknown,
  jsonPath: string,
  emit: (ref: { stackName: string; outputName: string; location: string }) => void
): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkForGetStackOutput(item, `${jsonPath}[${i}]`, emit));
    return;
  }
  const obj = node as Record<string, unknown>;
  const intrinsic = obj['Fn::GetStackOutput'];
  if (intrinsic !== undefined) {
    // Object form (current, documented): { StackName: "...", OutputName: "..." }.
    if (intrinsic && typeof intrinsic === 'object' && !Array.isArray(intrinsic)) {
      const i = intrinsic as Record<string, unknown>;
      const stackName = typeof i['StackName'] === 'string' ? i['StackName'] : undefined;
      const outputName = typeof i['OutputName'] === 'string' ? i['OutputName'] : undefined;
      if (stackName && outputName) {
        emit({ stackName, outputName, location: jsonPath });
      }
    } else if (Array.isArray(intrinsic) && intrinsic.length === 2) {
      // Defensive: legacy array form [stackName, outputName].
      const arr = intrinsic as unknown[];
      const stackName = arr[0];
      const outputName = arr[1];
      if (typeof stackName === 'string' && typeof outputName === 'string') {
        emit({ stackName, outputName, location: jsonPath });
      }
    }
    // Fall through: the intrinsic's value may contain other intrinsics
    // (e.g. Fn::Sub'd StackName). Walk into it so nested calls still surface.
  }
  for (const [key, value] of Object.entries(obj)) {
    walkForGetStackOutput(value, jsonPath ? `${jsonPath}.${key}` : key, emit);
  }
}

export function printPlan(plan: ImportPlanEntry[], cfnStackName: string): void {
  const logger = getLogger();
  logger.info('');
  logger.info(`Import plan for CloudFormation stack ${quotedOrNotShown(cfnStackName)}:`);
  for (const entry of plan) {
    // Every value on this row is rendered with its own boundary: the plan is
    // printed directly above the destructive confirmation, and each identifier
    // VALUE is the state record's `physicalId` (or a segment of it), which
    // nothing validates on read (go-to-k/cdkd#3375). The key and the row's
    // logical id and type are template- or schema-supplied and plain in every
    // real template, so they render unchanged there.
    const idStr = Object.entries(entry.resourceIdentifier)
      .map(([k, v]) => `${displayIdent(k)}=${showRecordValue(v)}`)
      .join(', ');
    logger.info(`  ${rowIdent(entry.logicalId)} (${rowIdent(entry.resourceType)}) ← ${idStr}`);
  }
  logger.info('');
}

/**
 * Helper for {@link runPerStackImportLoop}: pull a single resource out of
 * a template's Resources block by logical id, returning `undefined` if
 * the template is malformed or the resource is absent.
 */
export function getResourceFromTemplate(
  template: Record<string, unknown>,
  logicalId: string
): Record<string, unknown> | undefined {
  const resources = template['Resources'];
  if (!resources || typeof resources !== 'object' || Array.isArray(resources)) return undefined;
  const r = (resources as Record<string, unknown>)[logicalId];
  if (!r || typeof r !== 'object' || Array.isArray(r)) return undefined;
  return r as Record<string, unknown>;
}

/**
 * Helper for {@link runPerStackImportLoop}'s non-leaf-parent branch:
 * mutate-clone a nested-stack resource row to (a) inject `DeletionPolicy:
 * Retain` (AWS-docs "Nest an existing stack" requirement so a parent-side
 * rollback does NOT cascade-delete the just-imported child stack), (b)
 * overwrite `Properties.TemplateURL` to the uploaded child template's S3
 * URL, and (c) overwrite `Properties.Tags` with the child stack's actual
 * current tags. The Tags overwrite is required by AWS's "Nested stack
 * import validation": "The tags for the nested AWS::CloudFormation::Stack
 * definition in the parent stack template match the tags for the actual
 * nested stack resource." Without the overwrite, the parent's IMPORT
 * changeset fails with `Tags of resource [<id>] defined in the template
 * don't match with the actual tags of <arn>` — most commonly when
 * {@link flipStackToUpdateComplete} added a `cdkd:nested-export-flip`
 * tag to the child to escape the IMPORT_COMPLETE status. All other
 * Properties (Parameters, NotificationARNs) are preserved from the
 * original row.
 *
 * `childActualTags` is the result of `DescribeStacks(<child>).Stacks[0].Tags`
 * (empty array if the child has no tags). When the child has no actual
 * tags AND the original row has no Tags Properties either, the
 * Properties.Tags key is omitted from the output so the parent template
 * stays minimal (matches the CDK-synth shape for tag-free stacks).
 *
 * Exported for unit testing.
 */
export function injectRetainAndRewriteTemplateUrl(
  originalRow: Record<string, unknown>,
  newTemplateUrl: string,
  childActualTags?: ReadonlyArray<CfnTag>
): Record<string, unknown> {
  const cloned: Record<string, unknown> = { ...originalRow };
  cloned['DeletionPolicy'] = 'Retain';
  const existingProps = cloned['Properties'];
  const properties: Record<string, unknown> =
    existingProps && typeof existingProps === 'object' && !Array.isArray(existingProps)
      ? { ...(existingProps as Record<string, unknown>) }
      : {};
  properties['TemplateURL'] = newTemplateUrl;
  if (childActualTags && childActualTags.length > 0) {
    // Forward every user-set tag verbatim — AWS validates the full list,
    // not a subset. EXCLUDE tags whose Key starts with `aws:` (e.g.
    // `aws:cloudformation:stack-id` / `aws:cloudformation:stack-name`
    // auto-added by AWS Service Catalog / StackSets to their managed
    // stacks). CFn rejects user-supplied tags whose Key starts with
    // `aws:` with `Tags starting with 'aws:' are reserved`, so a child
    // re-imported into cdkd from a Service-Catalog-deployed source
    // would otherwise break Phase 1B's adoption changeset with a
    // confusing rejection. AWS's "Nested stack import validation"
    // accepts the absence of system tags from the parent template
    // (they live only AWS-side and are auto-reattached). Also strip
    // undefined Key/Value entries (defensive: SDK types these as
    // optional even though AWS never returns them blank).
    const forwardable = childActualTags.filter(
      (t) => t.Key !== undefined && t.Value !== undefined && !t.Key.startsWith('aws:')
    );
    if (forwardable.length > 0) {
      properties['Tags'] = forwardable.map((t) => ({ Key: t.Key, Value: t.Value }));
    }
  }
  cloned['Properties'] = properties;
  return cloned;
}
