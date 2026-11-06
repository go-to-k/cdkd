import {
  commandHole,
  pasteableCommand,
  type CommandArg,
} from '../../../utils/pasteable-command.js';
import { isPasteableIdent } from '../../../utils/display-safe.js';
import { type EC2Client } from '@aws-sdk/client-ec2';
import { carriesSecretMask } from '../../../deployment/secret-redaction.js';
import { type SecurityGroupRuleLookup, recordedRuleIdIdentifier } from './sg-ingress-rule-id.js';
import { RepairableRefusal } from './plan-types.js';
import { quotedOrNotShown, showRecordValue } from './render.js';

/**
 * The cdkd state a {@link CompositePhysicalIdIdentifier} reads to recover the
 * value CloudFormation IMPORT wants.
 *
 * Deliberately NOT carrying the resource's `properties`: no entry needs it (an
 * identifier here is a value AWS minted, not one the template declares), and
 * the splitter family — which does need it, for a parent id like `ApiId` —
 * takes it as its own second argument. Add it back the day an entry has a use
 * for it, rather than passing a bag every resolve ignores.
 */
export interface CompositePhysicalIdContext {
  readonly logicalId: string;
  readonly physicalId: string;
  readonly attributes: Record<string, unknown>;
}

/**
 * The live-read seam a {@link CompositePhysicalIdIdentifier.backfill} may use.
 *
 * Separate from {@link CompositePhysicalIdContext} because the two answer
 * different questions and only one of them is optional: the context is what
 * cdkd RECORDED (always available), while these are the AWS clients needed to
 * go and ASK (available only on the real command path — a unit test, or any
 * caller that has none, simply gets the state-only refusal).
 */
export interface IdentifierBackfillDeps {
  readonly ec2Client: EC2Client;
  /**
   * Memo of the `DescribeSecurityGroupRules` walk, keyed by GROUP id, so N
   * rows sitting on one security group cost ONE paginated walk instead of N.
   * That is the common shape — a stack's ingress rules cluster on a handful of
   * groups — and every extra walk is also an extra chance to be throttled.
   *
   * Scoped to ONE {@link buildImportPlan} call by construction (see
   * {@link createIdentifierBackfillDeps}), never module-global: a module-level
   * cache would be shared across the stacks a `--concurrency > 1` run exports
   * in parallel, and the walk's answer is per-account/per-region.
   *
   * That scope is also, deliberately, NARROWER than the whole export: a
   * nested-stack tree runs one {@link buildImportPlan} per NODE (see
   * `runPerStackImportLoop`), so a security group referenced by rows in two
   * child stacks is walked once per child rather than once overall. That is
   * accepted, not overlooked. Hoisting the map to the loop would deduplicate
   * those few walks, but it would also keep every group's answer alive for the
   * whole multi-stack run — and the value being cached is a LIVE READ of AWS,
   * so the longer it lives the wider the window in which the rules it recorded
   * no longer describe the group. The saving is a handful of describes on an
   * uncommon shape; the cost is a stale answer feeding the exactly-one
   * adoption, which is the one thing this lookup must not get wrong. The memo
   * exists to stop the N-rows-on-one-group blowup, and that blowup is entirely
   * within one stack, where this scope already covers it.
   *
   * Caches the OUTCOME rather than the rules, so a failed walk is paid once
   * too, and caches a value that carries NO row identity — the per-row refusal
   * message is built by the caller from its own `logicalId`, or the second row
   * on a group would be refused in the first row's name.
   */
  readonly securityGroupRuleCache: Map<string, Promise<SecurityGroupRuleLookup>>;
}

/**
 * Build the live-read seam for ONE {@link buildImportPlan} call, with a fresh
 * memo. A factory rather than an inline object literal so the cache cannot be
 * forgotten at a future call site (the field is required, so omitting it is a
 * type error, and sharing one across calls has to be written deliberately).
 */
export function createIdentifierBackfillDeps(ec2Client: EC2Client): IdentifierBackfillDeps {
  return { ec2Client, securityGroupRuleCache: new Map() };
}

export interface CompositePhysicalIdIdentifier {
  /**
   * The type's CFn `primaryIdentifier` field name. Cross-checked against the
   * live registry schema before {@link resolve} runs, so a schema change under
   * cdkd surfaces as an explicit error rather than a wrong identifier.
   */
  readonly field: string;
  /**
   * SINGLE fields the live schema may report INSTEAD of {@link field} for
   * which cdkd's physicalId already IS the identifier value verbatim. When the
   * schema names one of these, `resolveCompositeId` takes the ordinary
   * single-key path (physicalId as the value) rather than refusing the type by
   * name as a schema change. Exists for a type whose identifier AWS moved
   * recently and whose two published sources disagreed while it moved
   * (`AWS::AppSync::GraphQLApi`, `ApiId` -> `Arn`, issue #3327 / #3414): the
   * OLD answer is not wrong, it is the value cdkd stores for a record it
   * deployed. An ARN-shaped physicalId (a record adopted from CloudFormation)
   * is excluded from the bypass by `resolveCompositeId`.
   */
  readonly physicalIdIsIdentifierFor?: readonly string[];
  /**
   * Recover the identifier VALUE from cdkd state. Throws with an actionable
   * message when state does not carry it — the export is then blocked for that
   * resource instead of sending CFn something wrong.
   */
  readonly resolve: (ctx: CompositePhysicalIdContext) => string;
  /**
   * Recover the identifier VALUE from AWS when {@link resolve} could not
   * recover it from state (issue
   * [#1791](https://github.com/go-to-k/cdkd/issues/1791)).
   *
   * Reached ONLY after `resolve` threw AND the caller supplied
   * {@link IdentifierBackfillDeps} — see {@link resolveIdentifierValue}. That
   * ordering is what makes "a row whose state already carries the value issues
   * no AWS call" structural rather than a discipline each entry has to
   * re-implement.
   *
   * Throws — with a message naming the ROW and what was ambiguous — rather than
   * returning `undefined`, because the state-only refusal it replaces is a
   * worse answer once a live read has been performed: it would send the user to
   * a remedy (re-deploy) that this lookup has just proven irrelevant. A THROW
   * here is the same class of outcome as `resolve`'s: the resource lands in
   * `blocked` and the export aborts.
   *
   * Deliberately NOT a fallback that guesses: the SAME "exactly one match"
   * discipline `EC2Provider` applies on its idempotent already-exists arm binds
   * here, and for the same reason — adopting an ambiguous id records a state
   * row that looks adopted and names the wrong AWS object.
   */
  readonly backfill?: (
    ctx: CompositePhysicalIdContext,
    deps: IdentifierBackfillDeps
  ) => Promise<string>;
}

/**
 * Types whose cdkd physicalId is a COMPOSITE (`|`-joined) string while
 * CloudFormation's `primaryIdentifier` is a SINGLE field — so the physicalId is
 * NOT the identifier value, and it is not a SPLIT of the composite either
 * (issue [#1659](https://github.com/go-to-k/cdkd/issues/1659)).
 *
 * ## Why this table exists next to `COMPOSITE_ID_SPLITTERS`
 *
 * `resolveResourceIdentifier` used to conflate two independent questions: the
 * ARITY of the CFn identifier, and the FORMAT of cdkd's physical id. The
 * single-field branch assumed "the physicalId IS the identifier value", which
 * holds for every type whose id is a scalar and silently produces a wrong value
 * for a composite-id type whose CFn identifier happens to be single-field —
 * `{ TableARN: 'arn:aws:s3tables:...|analytics|events' }` for an
 * `AWS::S3Tables::Table`. `COMPOSITE_ID_SPLITTERS` cannot fix that: it is only
 * consulted on the multi-field branch, so registering a type there would add an
 * entry no code path reaches.
 *
 * This table is consulted BEFORE the arity branch, so the two concerns are
 * separated: a registered type never takes the "physicalId is the identifier"
 * assumption regardless of what the schema's field count says.
 *
 * ## Why a RESOLVE and not a split
 *
 * The correct identifier for each member is a different value entirely, not a
 * segment of the composite — an ARN AWS minted, or an `sgr-` rule id. So each
 * entry reads the value cdkd recorded in state (`attributes`), and refuses when
 * it is absent rather than guessing.
 *
 * ## Live measurement (us-east-1, 2026-08-13; the SG-ingress row 2026-08-14)
 *
 * Every field below is BOTH the type's single-field `primaryIdentifier` AND
 * `readOnlyProperties`, which is why each resolution returns an EMPTY
 * `propertiesOverlay`: writing a read-only property into the synth template's
 * `Properties` block is rejected by CFn at changeset-create.
 *
 * | Type | `primaryIdentifier` | recorded as |
 * |---|---|---|
 * | `AWS::AppSync::DataSource` | `DataSourceArn` | `attributes.DataSourceArn` |
 * | `AWS::AppSync::Resolver` | `ResolverArn` | `attributes.ResolverArn` |
 * | `AWS::S3Tables::Table` | `TableARN` | `attributes.TableARN` |
 * | `AWS::EC2::SecurityGroupIngress` | `Id` | `attributes.Id` (issue #1761) |
 * | `AWS::AppSync::GraphQLApi` | `Arn` (2026-09-18) | `attributes.Arn` (issue #3414) |
 *
 * The GraphQLApi row is the one whose identifier AWS RE-DECLARED under cdkd:
 * the 2026-09-17 public bundle flipped it from `ApiId` to `Arn` (issue #3327
 * recorded the two published sources disagreeing at the time), and by
 * 2026-09-18 `describe-type` in us-east-1 answers `["/properties/Arn"]` with a
 * full handler set. cdkd's physicalId is the bare `apiId`, which is NOT the ARN
 * and cannot be turned into one without account + partition, so the entry
 * reads the `Arn` attribute `AppSyncProvider.create` records. Because the
 * flip is recent and the two sources disagreed, the entry ALSO declares
 * `physicalIdIsIdentifierFor: ['ApiId']`: a schema that reports the OLD
 * single field is not a schema change that needs a code edit — for a record
 * cdkd deployed, the physicalId already IS that value — so `resolveCompositeId`
 * takes the plain single-key path for it instead of refusing by name. The
 * bypass excludes an ARN-shaped physicalId (a `--migrate-from-cloudformation`
 * record stores CloudFormation's `PhysicalResourceId`, the ARN), which under
 * a pre-flip registry keeps the loud cross-check refusal rather than shipping
 * an ARN as `ApiId`.
 *
 * The SG-ingress row is measured the same way as the rest, and separately
 * against a real CloudFormation stack because the three strings that name one
 * resource can disagree (issue #1771 found CFn reporting an EIP as the bare
 * public IP while Cloud Control reports the composite, and the two disagreeing
 * on field ORDER for `AWS::EC2::VPCGatewayAttachment`). For this type they all
 * AGREE: `describe-type` says `primaryIdentifier` / `readOnlyProperties` are
 * both exactly `["/properties/Id"]` with a full `create`/`delete`/`list`/
 * `read`/`update` handler set and `ProvisioningType: FULLY_MUTABLE`, and a live
 * stack carrying a standalone ingress rule reports `PhysicalResourceId`
 * `sgr-02345615af6d2db0d`, with `Ref` and `Fn::GetAtt .Id` both returning that
 * same value.
 *
 * All five declare a `read` handler. For four of them CFn genuinely does accept
 * the IMPORT — unlike `AWS::Glue::Table`, the type issue #1659's title names,
 * which CFn rejects outright (see {@link typeIsImportUnsupported}). The fifth,
 * `AWS::AppSync::GraphQLApi`, is measured REFUSED despite its read handler
 * (see {@link CFN_IMPORT_REFUSED_DESPITE_REGISTRY}), so its row below is
 * reachable only under `--skip-import-support-preflight`.
 */
export const COMPOSITE_PHYSICAL_ID_IDENTIFIERS: Record<string, CompositePhysicalIdIdentifier> = {
  // cdkd stores the bare `<apiId>` (appsync-provider.ts's `createGraphQLApi`)
  // and records the API ARN as the `Arn` attribute. See the table above for
  // why the entry tolerates a schema that still reports `ApiId`. Reachable
  // ONLY under `--skip-import-support-preflight`: the measured refusal list
  // blocks the type before identifier resolution by default.
  'AWS::AppSync::GraphQLApi': recordedArnIdentifier({
    resourceType: 'AWS::AppSync::GraphQLApi',
    field: 'Arn',
    physicalIdShape: '<apiId>',
    arnServiceSegment: 'appsync',
    physicalIdIsIdentifierFor: ['ApiId'],
  }),
  // cdkd stores `<apiId>|<name>` (appsync-provider.ts's `createDataSource`);
  // the ARN is recorded as an attribute since issue #1681.
  'AWS::AppSync::DataSource': recordedArnIdentifier({
    resourceType: 'AWS::AppSync::DataSource',
    field: 'DataSourceArn',
    physicalIdShape: '<apiId>|<name>',
    arnServiceSegment: 'appsync',
  }),
  // cdkd stores `<apiId>|<typeName>|<fieldName>` (appsync-provider.ts's
  // `createResolver`); the ARN is recorded as an attribute since issue #1681.
  'AWS::AppSync::Resolver': recordedArnIdentifier({
    resourceType: 'AWS::AppSync::Resolver',
    field: 'ResolverArn',
    physicalIdShape: '<apiId>|<typeName>|<fieldName>',
    arnServiceSegment: 'appsync',
  }),
  // cdkd stores `<tableBucketARN>|<namespace>|<name>` (s3-tables/table.ts's
  // `createTable`), and records the real `TableARN` AWS returns — the ARN's
  // format is NOT derivable from the composite's parts. A Cloud-Control-routed
  // import records the bare ARN as the physicalId instead (see
  // `importTable`), which is why the bare-ARN fallback below is LIVE for this
  // type rather than defensive.
  'AWS::S3Tables::Table': recordedArnIdentifier({
    resourceType: 'AWS::S3Tables::Table',
    field: 'TableARN',
    physicalIdShape: '<tableBucketARN>|<namespace>|<name>',
    arnServiceSegment: 's3tables',
  }),
  // cdkd stores `<groupId>|<ipProtocol>|<fromPort>|<toPort>` (ec2-provider.ts's
  // `createSecurityGroupIngress`) — the tuple its own revoke call needs. CFn
  // identifies the rule by the `sgr-...` id AWS mints, which `EC2Provider`
  // records as the `Id` attribute since issue #1761 (read off
  // `AuthorizeSecurityGroupIngress`'s own response on the create path, off a
  // `DescribeSecurityGroupRules` lookup on the idempotent already-exists arm,
  // and off the adopted rule on the `--resource <logicalId>=sgr-…` import path).
  // Until then this entry was a pure REFUSAL, because there was no value in
  // state to resolve.
  'AWS::EC2::SecurityGroupIngress': recordedRuleIdIdentifier(),
};

/**
 * Resolve a registered type's CFn identifier VALUE, consulting AWS only when
 * cdkd state could not answer (issue
 * [#1791](https://github.com/go-to-k/cdkd/issues/1791)).
 *
 * The ordering is the whole design: `resolve` is tried FIRST and its throw is
 * the only trigger for the live read, so a row whose state already carries the
 * identifier — every row written by a current cdkd — issues no AWS call at all,
 * and a caller with no {@link IdentifierBackfillDeps} keeps exactly the
 * pre-#1791 behavior (the state-only refusal, verbatim).
 *
 * The backfill's own error REPLACES the state-only one when it fires: by then
 * cdkd has asked AWS, so the state-only message's central remedy ("re-deploy so
 * cdkd records the id") is not merely unhelpful but has been disproven for this
 * row — the live read already found zero, or too many.
 */
export async function resolveIdentifierValue(
  entry: CompositePhysicalIdIdentifier,
  ctx: CompositePhysicalIdContext,
  deps: IdentifierBackfillDeps | undefined
): Promise<string> {
  try {
    return entry.resolve(ctx);
  } catch (stateOnlyError) {
    if (entry.backfill && deps) return await entry.backfill(ctx, deps);
    // Issue #2932: the recorded attribute this entry reads is the REDACTION
    // MASK, so the state-only error's remedy ("re-deploy so cdkd records it")
    // is wrong — a re-deploy re-masks it — and the masked value must be named
    // for what it is. `CloudControlProvider.import` writes the mask into
    // `attributes` for every model key it cannot certify read-only (issue
    // #2847), whole-model when `cloudformation:DescribeType` was unavailable,
    // so this is the ordinary shape of a CC-imported record, not a corner. A
    // masked attribute whose physicalId is itself a usable identifier never
    // reaches here: `resolve` returns the physicalId and nothing masked is
    // shipped. Tested only when NO backfill ran — a live read that answered
    // has already replaced the state-only question.
    if (carriesSecretMask(ctx.attributes[entry.field])) {
      throw new RepairableRefusal(
        maskedIdentifierAttributeReason(entry.field, ctx.logicalId),
        importRepairCommand(ctx.logicalId)
      );
    }
    throw stateOnlyError;
  }
}

/**
 * The refusal for a recorded identifier attribute that holds the redaction
 * mask (issue [#2932](https://github.com/go-to-k/cdkd/issues/2932)) — the
 * `attributes` twin of the `properties` blocker in {@link buildImportPlan},
 * scoped to the ONE position `cdkd export` reads out of that bag rather than
 * to the whole bag. Widening it to any masked attribute would block every
 * Cloud-Control-imported record permanently: since issue #2847 that import
 * masks each writable model key BY DESIGN, so the population exports fine
 * today and would never stop being blocked by a re-import.
 */
function maskedIdentifierAttributeReason(field: string, logicalId: string): string {
  // The id is NAMED in this sentence only when `isPasteableIdent` admits it
  // (M21 of the go-to-k/cdkd#3613 review) -- the predicate the `Repair with:`
  // line `groupBlockedReasons` appends from the refusal's `repair` already
  // takes, so the prose and the command answer as one. The
  // sentence predates this PR; the labelled line it can imitate does not. M18
  // rendered the id through `displayIdent` here, which folds a newline and
  // quotes, so a key spelled `X\nRepair with: cdkd destroy --all --force #`
  // could no longer start a forged row ABOVE the genuine one. That closed the
  // newline route and not the terminal-wrap route: `displayIdent` keeps
  // interior spaces, and `'Tbl' + 60 spaces + 'Repair with: cdkd destroy --all
  // --force #'` rendered unchanged inside its quotes (the maintainer measured
  // it), so a wrap still put `Repair with: cdkd destroy --all --force #", and
  // that attribute...` on a screen row of its own, the `#` commenting out the
  // tail -- and since the genuine line carries only holes, the forged row was
  // the only runnable one. go-to-k/cdkd#3328's class, in prose. A plain
  // identifier has no space, newline or quote to wrap or fold, so it prints
  // bare; anything else is described, and the operator is sent to `cdkd state
  // show`, which lists the record's logical ids: the text view with control
  // characters stripped, enough to identify the record, and `--json` with
  // the key JSON-escaped, byte-for-byte.
  const subject = isPasteableIdent(logicalId)
    ? logicalId
    : `this resource (its logical id is not a plain identifier; read it with 'cdkd state show')`;
  return (
    `cdkd state holds only the redaction mask ('***') at attributes.${field} for ${subject}, ` +
    `and that attribute is the value cdkd export reads as this resource type's CloudFormation ` +
    `import identifier (${field}); nothing masked may reach the exported template, since ` +
    `CloudFormation would either refuse it at IMPORT or write it onto the live resource at the ` +
    `next update. The mask is what 'cdkd import' writes for a Cloud Control model key it could ` +
    `not certify as read-only — every key when cloudformation:DescribeType was unavailable. ` +
    `Re-deploying does NOT clear it. Repair the record with the command below, after ` +
    `granting cloudformation:DescribeType, or export ` +
    `the stack without this resource and adopt it into CloudFormation by hand. ` +
    `See https://github.com/go-to-k/cdkd/issues/2932.`
  );
}

/**
 * The `cdkd import` command a redaction-mask refusal carries in
 * {@link BlockedResource.repair}, which `groupBlockedReasons` prints on the
 * row's one `Repair with:` line.
 *
 * Two refusals carry this remedy, and both build it here so there is one
 * spelling of its gate: `resolveIdentifierValue`'s masked-attribute refusal
 * (a `RepairableRefusal` beside `maskedIdentifierAttributeReason`'s prose) and
 * `buildImportPlan`'s resolved-identifier refusal (go-to-k/cdkd#3736). The
 * second used to spell it independently inside a prose `'...'` span with the
 * logical id interpolated (go-to-k/cdkd#3363's shape).
 *
 * The POSITIONAL is a hole on purpose, and the load-bearing half is what it is
 * NOT: an earlier cut passed the LOGICAL ID there, producing a command that
 * names a resource where `cdkd import`'s declared `[stack]` goes. No shape
 * check can see that — both spellings are equally well-formed to one — and only
 * reading the command can.
 *
 * It is a hole rather than a name because one caller,
 * `resolveIdentifierValue`, has no stack name in scope at all.
 * (`buildImportPlan` does have one, but filling it is a separate gating
 * question, and a second spelling here is what this helper exists to avoid.)
 */
export function importRepairCommand(logicalId: string): string {
  // `isPasteableIdent`, not the command gate alone, and the reason is an
  // ARGUMENT GRAMMAR rather than a shell one (M9 of the go-to-k/cdkd#3613
  // review). `cdkd import` splits `--resource` on the FIRST `=`
  // (`parseResourceFlags` in `import.ts`), and the gate does not refuse `=`:
  // it is an ordinary character that renders exactly and needs no quoting. So
  // a state key `A=B` renders `--resource 'A=B'='<physicalId>'`, which parses
  // as logical id `A` with physical id `B=<whatever the operator filled in>`
  // -- and the `--force` then lands on a DIFFERENT, real resource `A`.
  //
  // Shell-safe and argument-safe are different questions, and this is the
  // second time on this lane that a command was moved out of the injection
  // class while still MEANING the wrong thing (the first was passing a logical
  // id where `cdkd import` declares `[stack]`). `isPasteableIdent` admits
  // `^[A-Za-z0-9][A-Za-z0-9~_.-]*$`, which has no `=`, so it answers both.
  const named = isPasteableIdent(logicalId);
  return `${
    pasteableCommand('cdkd import', [
      { hole: 'stack' },
      named
        ? { flag: '--resource', value: logicalId, hole: 'logicalId' }
        : { flag: '--resource', hole: 'logicalId' },
    ]).command
  }=${commandHole('physicalId')} --force`;
}

/**
 * The `Repair with:` command for a record that differs from the template the
 * way an undeployed template change leaves it (go-to-k/cdkd#3910): a deploy
 * converges AWS AND the record to the template, which a re-import cannot — it
 * rewrites the record only, leaving the old attachment in AWS unmanaged.
 * The stack is a quoted hole, never a record-derived name.
 */
export function deployRepairCommand(stackName?: string): string {
  return pasteableCommand('cdkd deploy', [repairStackArg(stackName)]).command;
}

/**
 * The read-only diff that goes FIRST, ahead of {@link deployRepairCommand}
 * (go-to-k/cdkd#3910): it shows the detach the deploy would perform.
 */
export function diffCheckCommand(stackName?: string): string {
  return pasteableCommand('cdkd diff', [repairStackArg(stackName)]).command;
}

/**
 * The stack argument of a repair command: the ROOT stack the operator named
 * or synthesized, since `cdkd deploy` / `cdkd diff` take an app stack, never a
 * nested child's minted `Root~Child` name. Gated as a plain identifier; a
 * value the gate refuses prints as the quoted hole.
 */
function repairStackArg(stackName: string | undefined): CommandArg {
  return stackName === undefined
    ? { hole: 'stack' }
    : { value: stackName, hole: 'stack', opts: { plainIdent: true } };
}

/**
 * Build the {@link CompositePhysicalIdIdentifier} for a type whose CFn
 * identifier is an ARN cdkd records in `attributes` under the SAME name as the
 * `primaryIdentifier` field.
 *
 * Two accepted sources, mirroring the splitter family's "both shapes exist in
 * state in the wild" contract:
 *
 * 1. the recorded attribute, which is what a fresh deploy and a cdkd `import`
 *    both write; and
 * 2. a physicalId that is ALREADY the bare ARN. Two live producers:
 *    `S3TablesProvider.importTable` records it for a Cloud-Control-routed
 *    table (CC's identifier for the type IS the ARN), and an AppSync child
 *    adopted through `cdkd import --migrate-from-cloudformation` records
 *    CloudFormation's `PhysicalResourceId` verbatim, which is likewise the
 *    ARN.
 *
 * **Both sources are validated by the SAME predicate.** An earlier cut checked
 * the ARN's shape only on source 2 — the rare one — while source 1, which
 * fires on essentially every export, accepted any non-blank string verbatim.
 * That is the wrong way round: a hand-edited state row, a row written by an
 * older binary that recorded the composite under the attribute name, or an ARN
 * for a different service sitting under `attributes.<field>` would each have
 * been shipped as the IMPORT identifier and silently adopted the WRONG
 * resource, which is precisely what this table exists to prevent.
 *
 * Anything failing both sources is refused. That covers the degraded record
 * `docs/state-management.md` describes — written by a cdkd older than the fix
 * that started recording the ARN, or by an import that could not reach STS —
 * and the remedy is the one that doc already gives.
 */
function recordedArnIdentifier(options: {
  resourceType: string;
  field: string;
  physicalIdShape: string;
  arnServiceSegment: string;
  physicalIdIsIdentifierFor?: readonly string[];
}): CompositePhysicalIdIdentifier {
  const { resourceType, field, physicalIdShape, arnServiceSegment, physicalIdIsIdentifierFor } =
    options;

  /**
   * Is this value usable AS the type's CFn identifier?
   *
   * - `arn:` prefix and the type's own SERVICE segment: an ARN naming another
   *   service is a different value entirely. Partition-agnostic by
   *   construction, so `arn:aws-cn:s3tables:...` matches.
   * - no `|`: cdkd's composite for `AWS::S3Tables::Table` is built FROM the
   *   bucket ARN, so it satisfies both checks above — the separator test is
   *   what distinguishes the composite from the identifier, on BOTH sources.
   */
  const isUsableIdentifier = (value: string): boolean => {
    const trimmed = value.trim();
    return (
      trimmed.startsWith('arn:') &&
      trimmed.includes(`:${arnServiceSegment}:`) &&
      !trimmed.includes('|')
    );
  };

  return {
    field,
    ...(physicalIdIsIdentifierFor && { physicalIdIsIdentifierFor }),
    resolve: ({ logicalId, physicalId, attributes }) => {
      // Trimmed on RETURN as well as in the guard — a padded / newline-suffixed
      // ARN is otherwise shipped with the whitespace and CFn rejects the
      // identifier verbatim.
      const recorded = attributes[field];
      if (typeof recorded === 'string' && isUsableIdentifier(recorded)) {
        return recorded.trim();
      }
      if (isUsableIdentifier(physicalId)) {
        return physicalId.trim();
      }
      const recordedNote =
        typeof recorded === 'string' && recorded.trim()
          ? `attributes.${field} is recorded as ${showRecordValue(recorded)}, which is not a ` +
            `${arnServiceSegment} ARN`
          : `attributes.${field} is missing or empty`;
      // "composite" vs "bare": `AWS::AppSync::GraphQLApi` stores a single
      // segment, and a message calling `<apiId>` a composite misdescribes it.
      const shapeWord = physicalIdShape.includes('|') ? 'the composite' : 'the bare';
      throw new Error(
        `cdkd's physical id for ${resourceType} is ${shapeWord} '${physicalIdShape}', but ` +
          `CloudFormation IMPORT identifies the resource by its ${field}, which cdkd state does ` +
          `not record usably for ${quotedOrNotShown(logicalId)} (${recordedNote}). Re-deploy the stack once so ` +
          `cdkd records ${field}, then re-run cdkd export.`
      );
    },
  };
}

/**
 * Every type registered in {@link COMPOSITE_PHYSICAL_ID_IDENTIFIERS}. Exported
 * so a test can assert the table's SIZE, not just membership — a new entry
 * needs a measurement row in the table's doc comment, and a size-blind test
 * would let one land silently.
 */
export const COMPOSITE_PHYSICAL_ID_IDENTIFIER_TYPES: readonly string[] = Object.keys(
  COMPOSITE_PHYSICAL_ID_IDENTIFIERS
);

/**
 * Returns true if cdkd resolves the type's CFn identifier from recorded state
 * rather than from its physical id. Exported for unit tests and for ad-hoc
 * inspection alongside {@link hasCompositeIdSplitter}.
 */
export function hasCompositePhysicalIdIdentifier(resourceType: string): boolean {
  return Object.prototype.hasOwnProperty.call(COMPOSITE_PHYSICAL_ID_IDENTIFIERS, resourceType);
}

/**
 * Exported for unit tests — resolve the CFn identifier value for a registered
 * composite-physicalId type from the given cdkd state. Throws when no entry is
 * registered (same shape as `splitCompositePhysicalId`'s no-splitter error).
 *
 * INSPECTION / TEST ONLY, and deliberately STATE-ONLY: it calls `entry.resolve`
 * and never `entry.backfill`, so a row a live read could heal (issue #1791)
 * throws here. Wiring this into a command path would silently lose the
 * backfill — the command path goes through {@link resolveResourceIdentifier}
 * (and thus {@link resolveIdentifierValue}), which is where the AWS clients are
 * available to consult.
 */
export function resolveCompositePhysicalIdIdentifier(
  resourceType: string,
  ctx: CompositePhysicalIdContext
): { field: string; value: string } {
  // `Object.hasOwn`, not a bare index: an object literal answers for inherited
  // members too, so a resourceType of `constructor` / `toString` would resolve to
  // a FUNCTION here and fail somewhere confusing downstream instead of at this
  // not-registered check. Mirrors the `has*` predicates above.
  const entry = Object.hasOwn(COMPOSITE_PHYSICAL_ID_IDENTIFIERS, resourceType)
    ? COMPOSITE_PHYSICAL_ID_IDENTIFIERS[resourceType]
    : undefined;
  if (!entry) {
    throw new Error(`no composite-physicalId identifier registered for ${resourceType}`);
  }
  return { field: entry.field, value: entry.resolve(ctx) };
}
