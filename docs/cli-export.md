---
title: cdkd export
description: "Hand a cdkd-managed stack over to CloudFormation with cdkd export."
---

## `cdkd export` (hand a stack over to CloudFormation)

`cdkd export <stack>` is the mirror of `cdkd import` (AWS → cdkd) in
the reverse direction (cdkd → CloudFormation). It builds a CFn
`ChangeSetType=IMPORT` changeset from cdkd state + the synthesized
template, executes it, and deletes cdkd state on success. AWS resources
are unchanged across the migration.

```bash
cdkd export MyStack                              # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn
cdkd export MyStack --dry-run                    # print the import plan, no CFn calls
cdkd export MyStack --template path.json         # pre-rendered template (JSON or YAML — format auto-detected, skip synth)
cdkd export                                       # auto-detect single-stack apps
```

**Flow**:

1. Synthesize the CDK app (or read `--template <path>`) to get the
   CloudFormation template.
2. Load cdkd state for the target stack; build the
   `(logicalId, physicalId, resourceType)` map.
3. Refuse if a CFn stack with the destination name already exists, or
   if any template resource is in the **blocked** set (template
   resources without a cdkd state entry; resources whose recorded
   properties hold the redaction mask `***`, i.e. a `NoEcho`
   custom-resource value cdkd cannot re-derive. Forcing that
   custom resource to update does NOT clear this block: the handler
   supplies the value to the DEPLOY and cdkd re-masks it on the way into
   state, which is what the export reads. Stop setting `NoEcho` on that
   response and re-deploy, then export again; or export the stack
   without that resource and adopt it by hand. Or
   `AWS::CloudFormation::Stack`
   rows whose parent cdkd state has no matching nested-stack entry). Lambda-backed Custom Resources (`Custom::*` AND
   `AWS::CloudFormation::CustomResource` — the latter is what
   `new cdk.CustomResource(...)` synthesizes when no `resourceType` is
   passed) are NOT blocked but require `--include-non-importable` to
   run the 2-phase flow described below. `AWS::CloudFormation::Stack`
   rows whose parent state has a matching nested-stack entry are
   classified into a dedicated `nestedStackRows` list and exported via
   the **per-stack IMPORT loop**: the
   orchestrator recursively walks the cdkd state tree via
   `buildCdkdStateStackTree` and submits IMPORT changesets per
   cdkd-managed stack in leaf-first order. Leaf stacks get a single
   CREATE-via-IMPORT changeset; non-leaf parents get two per parent
   (Phase 1A CREATE-via-IMPORT for the parent's leaf resources only,
   then Phase 1B UPDATE-via-IMPORT against the now-existing parent to
   adopt the already-IMPORTed children via the AWS-docs "Nest an
   existing stack" pattern). Phase 1B injects
   `DeletionPolicy: Retain` plus
   `ResourceIdentifier: { StackId: <child arn> }` plus a `TemplateURL`
   rewritten to point at the child's AWS-canonicalized template
   fetched via `GetTemplate(Processed)` post-IMPORT plus child Tags
   forwarded from `DescribeStacks` (AWS's "Nested stack import
   validation" rejects tag mismatches). Between phases each non-root
   stack is flipped from `IMPORT_COMPLETE` to `UPDATE_COMPLETE` via a
   no-op tag-only `UpdateStack` (AWS rejects `IMPORT_COMPLETE` as a
   non-importable status for nesting; the flip adds a transient
   `cdkd:nested-export-flip` tag that Phase 1B then forwards verbatim
   into the parent template). Each
   child cdkd stack `<parent>~<childLogicalId>` becomes its own CFn
   stack named `<parent>-<childLogicalId>` by default (`~` is illegal
   in CFn stack names); per-child overrides via
   `--cfn-child-stack-name '<cdkdName>=<cfnName>'` (repeatable).
   Per-child Parameters are forwarded from the parent template's
   `AWS::CloudFormation::Stack.Properties.Parameters` block — literal
   string / number / boolean values pass through, and intrinsic-valued
   Parameters (`{Ref: <ParentParam>}` / `{Fn::GetAtt: [ParentResource,
   Attr]}`) are resolved at IMPORT time against the parent's resolved
   Parameters + cdkd state (a root-first pre-pass, since a child's
   Parameters resolve against its parent's). A value cdkd cannot resolve
   degrades to a warning and the child template's Parameter `Default`
   must cover it. The original "one atomic `--include-nested-stacks` IMPORT
   changeset" design was found infeasible by the 2026-05-24 AWS spike —
   AWS rejects that flag combination with
   `ValidationError: IncludeNestedStacks is not supported for changeSet type: IMPORT`;
   see the [nested-stack export/import design note](design/464-nested-stacks-export-import.md)
   §4.0 / §4.3 for the per-stack-loop algorithm. `--dry-run` prints
   the per-stack plan summary without acquiring child locks or
   submitting any changeset.
4. Resolve each resource type's primary identifier property name(s) via
   `cloudformation:DescribeType` (with a hardcoded fallback table for
   ~30 single-key types). **Composite primary identifiers**
   (`primaryIdentifier.length > 1`) are supported for
   `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`,
   `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Stage`,
   `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Model`,
   `AWS::ApiGateway::RequestValidator`,
   `AWS::EC2::VPCGatewayAttachment`, `AWS::ApiGatewayV2::Integration`,
   `AWS::ApiGatewayV2::Route`, `AWS::S3Tables::Namespace`, and
   `AWS::Lambda::Permission` via a
   per-type splitter that maps cdkd's `physicalId` (plus the resource's
   recorded `properties` for sub-resource types where the parent
   identifier — `ApiId` / `FunctionName` — lives in `properties`, not
   in `physicalId`) to the field map `ResourceIdentifier` expects.
   Sub-resource types whose primaryIdentifier includes an AWS-generated
   id (`IntegrationId` / `RouteId` / Lambda::Permission's `Id`) narrow
   the `Properties` overlay to the writable subset so CFn doesn't reject
   the changeset with "Encountered unsupported property". Other composite
   types abort with a clear error pointing at where to register a new
   splitter in `src/cli/commands/export.ts`. **IMPORT-unsupported
   types** (CFn schema lacks the handlers needed for IMPORT lookup —
   either `handlers: []` outright, or no `read` / `list` handler so CFn
   can't look the resource up by identifier) are auto-handled via a
   pre-delete + phase-2-CREATE dance: cdkd skips the resource from
   phase 1, deletes the AWS-side resource between phases via the
   appropriate SDK call, and lets CFn re-CREATE in phase 2.
   Currently registered:
   - `AWS::ApiGatewayV2::Stage` (`handlers: []`; auto-emitted by CDK's
     `HttpApi` construct as `$default`; pre-delete via
     `apigatewayv2:DeleteStage`). Brief unavailability window ~10s;
     HttpApi endpoint URL is unchanged because it embeds ApiId, not
     StageName.
   - `AWS::IAM::Policy` (`handlers: ['create', 'delete', 'update']` — no
     `read` / `list` because inline policy attachments have no
     first-class AWS resource id; auto-emitted by CDK L2 grants such as
     ECS Task Execution Role ECR pull policy and Lambda execution role
     inline policies; pre-delete via `iam:DeleteRolePolicy` /
     `DeleteUserPolicy` / `DeleteGroupPolicy` per attachment target).
     The inline policy attachment is dropped from each Role / User /
     Group between phases — any in-flight AWS API call that depends on
     the granted permission will fail with `AccessDenied` until CFn
     re-CREATEs in phase 2.

   Pass `--no-recreate-import-unsupported` to block instead of
   auto-handling. Per-type config lives in `IMPORT_UNSUPPORTED_RECREATABLE_TYPES`
   and `PRE_DELETE_HANDLERS` in `src/cli/commands/export.ts`.

   **Types whose cdkd physical id is composite while the CFn identifier
   is a single field** are resolved from the value cdkd RECORDED, not
   from the id. CFn identifies
   an `AWS::S3Tables::Table` by its `TableARN` and an
   `AWS::AppSync::DataSource` / `::Resolver` by its `DataSourceArn` /
   `ResolverArn`, while cdkd's physical id for each is the
   pipe-joined tuple its provider needs
   (`<tableBucketARN>|<namespace>|<name>`, `<apiId>|<name>`,
   `<apiId>|<typeName>|<fieldName>`) — and the correct identifier is
   not a segment of that tuple, so the composite-id splitters above
   cannot produce it. cdkd reads the ARN from the resource's recorded
   `attributes` instead, and blocks the resource with an actionable
   message when state does not carry it (a record written before cdkd
   started recording the ARN — re-deploy the stack once to heal it, as
   [State Management](state-management.md#the-composite-id-is-not-what-ref-returns)
   describes). `AWS::EC2::SecurityGroupIngress` is the fourth member and
   works the same way: CFn identifies a rule by the `sgr-...` id AWS
   mints, which cdkd records as the rule's `Id` attribute while its
   physical id stays the `<groupId>|<ipProtocol>|<fromPort>|<toPort>`
   tuple the revoke path needs. Its remedies differ from the other
   three, because there are two ways to lack the attribute. A rule
   declaring **more than one source** (both `CidrIp` and `CidrIpv6` on
   one resource) makes AWS mint one rule per source, and cdkd records
   neither id — neither is "the" identifier — so re-deploying never
   heals it; split it into one ingress resource per source. A rule
   whose record simply **predates that recording** carries no `Id` at all, and a *no-op*
   re-deploy does not heal that one either, since AWS returns the rule
   id only from `AuthorizeSecurityGroupIngress` itself. **`cdkd export`
   recovers it for you**: a row with no
   usable recorded `Id` triggers a paginated
   `DescribeSecurityGroupRules` on the group the physical id names, and
   the rule is adopted only when EXACTLY ONE ingress rule on that group
   carries the composite's `(protocol, port range)` tuple. Zero matches
   is REFUSED naming the row and the tuple cdkd searched for — nothing
   matched, so there are no candidates to name; more than one is
   REFUSED naming the row and every candidate `sgr-…` id, since two
   rules sharing that tuple are two rules cdkd's own physical id
   cannot tell apart either. Matching rules are counted BEFORE any is
   set aside, so a rule AWS reports without a usable `sgr-…` id refuses
   too rather than letting its sibling pass as "exactly one" — and when
   more than one rule matched, that refusal carries the two-cause
   remedy below as well. "More than one" has two causes: the
   multi-source rule above (split the resource), and two DISTINCT
   ingress resources differing only by SOURCE, which the composite
   carries none of — those are already one resource per source, so
   repair the row's `attributes.Id` or remove the row before
   exporting. The lookup needs `ec2:DescribeSecurityGroupRules`;
   without that permission the row is blocked with a message saying
   so, while a THROTTLED lookup is retried with backoff and reported
   as a throttle, not as a missing permission. A row whose state
   already records the `Id` — everything a current cdkd deploys —
   issues no live read at all.

   **Types CloudFormation cannot IMPORT at all are refused up front.**
   A type whose registry schema declares no `read` handler AND reports
   `ProvisioningType: NON_PROVISIONABLE` is rejected by
   `CreateChangeSet` with
   `ResourceTypes [<T>] are not supported for Import` — `AWS::Glue::Table`,
   `AWS::Route53::RecordSet`, `AWS::Route53::RecordSetGroup`,
   `AWS::AppSync::ApiKey`, `AWS::EC2::NetworkAclEntry`,
   `AWS::SQS::QueuePolicy` and `AWS::SNS::TopicPolicy` are all in this
   class (measured live, us-east-1, 2026-08-13). cdkd surfaces them
   from the schema it already fetches for the identifier and names
   EVERY offending resource in one message — AWS's own error is not
   exhaustive (a probe carrying three unsupported types named two of
   them). Both signals must agree before cdkd refuses, so a partial or
   unusual `DescribeType` response falls back to letting AWS answer.

   The whole plan — this refusal and every other `blocked` reason — is
   built BEFORE the stack lock is acquired, so a stack that cannot be
   exported says so without first locking out concurrent `cdkd deploy`
   / `cdkd destroy`. Planning issues no AWS write (it reads cdkd state
   and `DescribeType`), and the nested-stack path has always planned
   before locking.

   Remove the resource from the stack before exporting (it stays in AWS
   and can be re-declared in CloudFormation afterwards), or destroy it
   first and let CloudFormation create it fresh. The verdict is a
   registry HEURISTIC rather than AWS's published supported-for-import
   list, so `--skip-import-support-preflight` is the escape hatch if
   AWS has since made the type importable — the changeset is then
   submitted and CloudFormation answers for itself.
5. Acquire the stack lock so concurrent `cdkd deploy` cannot race.
6. Confirm with the user (skipped with `-y` / `--yes`).
7. **Preprocess the phase-1 template** (automatic; required by CFn IMPORT
   contract):
   - **Strip Outputs entirely.** CFn rejects IMPORT changesets that
     declare ANY Outputs with "you cannot modify or add [Outputs]".
     Phase 2 UPDATE re-submits the full synth template and restores
     Outputs along with the non-importable resources.
   - **Inject `DeletionPolicy: Delete`** on resources that lack the
     attribute. CFn IMPORT requires `DeletionPolicy` on every imported
     resource, and CDK synth only emits it when `RemovalPolicy` is
     explicitly set. cdkd injects `Delete` (not `Retain`) so the
     post-export CFn template matches the CFn type-default — same as
     what plain CFn would have applied for a resource without explicit
     `RemovalPolicy`. The user sees no surprising `Retain` attribute
     and the post-export `cdk diff` has no DeletionPolicy noise.
     `UpdateReplacePolicy` is intentionally NOT injected (only
     `DeletionPolicy` is required for IMPORT).
   - **Conditional overlay of `ResourceIdentifier` onto `Properties`.**
     Mirrors upstream `cdk import` behavior: pass the synth template
     through and let CFn match resources via
     `ResourcesToImport[].ResourceIdentifier` (the changeset API
     parameter) alone, except when the synth template carries a
     *literal* value for the field that *differs* from
     `ResourceIdentifier`. Four cases:
     - **Absent** (auto-generated names — user did NOT declare a
       physical name in CDK code): `Properties[<NameField>]` stays
       absent. CFn accepts the IMPORT changeset using
       `ResourceIdentifier` alone (verified against AWS in upstream
       `cdk import`). Post-export `cdk diff` is clean because both
       CFn-managed template and CDK synth have the property absent.
     - **Intrinsic** (composite-id sub-resources whose synth references
       the parent via `{Ref: ...}` / `{Fn::GetAtt: ...}` — Integration /
       Route / Lambda::Permission / API Gateway Method etc.): the
       intrinsic is preserved. CFn resolves it during changeset
       processing against the parent's own `ResourceIdentifier` (the
       parent is imported in the same changeset), so the resolved value
       equals `ResourceIdentifier[<field>]` and CFn accepts. Post-export
       `cdk diff` stays clean (both sides keep the intrinsic shape).
     - **Literal-mismatch** (pre-v0.94.0 prefix-on-user-declared-name
       legacy: user wrote `roleName: 'foo'` in CDK code; cdkd's deploy
       prefixed it to `'CdkSampleStack-foo'` on AWS): override
       `Properties.RoleName` from the unprefixed CDK value to the
       prefixed AWS value. CFn's identifier-match check requires this
       — otherwise AWS rejects with `The Identifier [<Field>] for
       resource [...] does not match the identifier value for the
       resource in the template`. The overlay persists into the
       post-import CFn template; the next `cdk deploy` proposes
       REPLACE — same caveat as upstream `cdk import` with
       mismatched-name CDK code (see the "Replacement risk on next
       deploy" caveat below). The prefix-migration pre-flight
       is meant to surface this before export. v0.94.0+ stacks with the
       default `--no-prefix-user-supplied-names` flip are NOT in this
       case — `Properties.RoleName` matches the AWS name without
       override.
     - **Unrepresentable** (a list carrying an intrinsic, a nested
       list, or an empty list): the export REFUSES, naming the
       resource, the property and the scalar to declare instead.
       "Literal" was widened
       past `typeof === 'string'` for the three cases above,
       because a field the template carries as an ARRAY is neither
       absent nor an intrinsic and used to survive into the phase-1
       template, where CFn answered with an opaque rejection — reachable
       via `addPropertyOverride('Namespace', ['analytics'])` on
       `AWS::S3Tables::Namespace`, which cdkd deploys because the
       provider accepts both wire shapes. A plain literal (string,
       number, boolean, or an array of those) is now OVERWRITTEN with
       the scalar identifier, which is not a guess: the overlay value
       comes from the cdkd-recorded physicalId, the authority on what
       the resource IS. Only the shapes above are refused, because
       preserving any of them reproduces the opaque rejection, while what
       makes overwriting wrong differs per shape — only a list that
       actually carries an object element has an intrinsic to discard, so
       the message says which reason applies.

     Pre-v0.95 cdkd unconditionally injected
     `ResourceIdentifier` values into `Properties` even when the synth
     had no value for that field, baking cdkd-prefixed auto-gen names
     AND composite-id literals into the post-export CFn template →
     post-export `cdk diff` proposed REPLACE on every auto-named
     resource and every composite-id sub-resource (defeating the
     migration's "AWS resources unchanged" promise). v0.95+ overlay is
     conditional; only the literal-mismatch legacy case still carries
     the documented post-export caveat.
8. `CreateChangeSet --change-set-type IMPORT` → wait → `ExecuteChangeSet`
   → `waitUntilStackImportComplete`. On failure cdkd fetches
   `DescribeStackEvents` and surfaces the per-resource failure reasons
   (the waiter alone only reports the high-level rollback state).
9. Delete cdkd state for the migrated stack.
10. Release lock.

**MVP scope** (intentional cuts; lift in follow-up PRs):

- **JSON and YAML templates supported.** Both formats round-trip through
  cdkd's CFn-aware codec (`src/cli/yaml-cfn.ts`), which preserves every
  CFn shorthand intrinsic (`!Ref`, `!Sub`, `!GetAtt`, `!Join`, …) across
  the parse → preprocess → re-serialize cycle. The phase-1 IMPORT and
  phase-2 UPDATE changesets emit in the same format as the source
  template — a YAML-authored CFn stack stays YAML on the wire.
- **Cross-stack consumer scan** runs at synth time when other stacks in
  the same CDK app reference the exporting stack via
  `Fn::GetStackOutput`. Those consumers
  keep resolving after the migration via the CloudFormation fallback
  (weak reference), so by default cdkd warns that the references become
  fallback-dependent (they break only for consumers deployed with
  `--no-cfn-fallback`); `--strict-cross-stack` refuses instead. Without
  `Fn::GetStackOutput` (or with consumer stacks outside the CDK app), no
  scan can run and the user is responsible for the check.
- **Drift baseline pre-flight** surfaces a warning when cdkd state lacks
  `observedProperties` for one or more resources. Without that baseline
  `cdkd drift` cannot reliably compare against AWS, so the next
  `cdk deploy` post-migration may surface unexpected changes if AWS has
  drifted from the synth template. Resolve by running
  `cdkd state refresh-observed <stack>` (or any redeploy) before
  exporting, then `cdkd drift <stack>` to verify. Non-blocking by
  design — the user decides whether to proceed.
- **Template Parameters** in the synthesized template are forwarded to
  both phase-1 and phase-2 changesets. Each parameter is resolved in
  order: (1) `--parameter Key=Value` CLI override (repeatable), then
  (2) the template's `Default`. A parameter with neither override nor
  default aborts with a clear error listing which keys are missing.
  A `--parameter` override for a key the template does not declare is
  also rejected (catches typos). CDK-generated templates typically only
  carry `BootstrapVersion` with a default; `cdkd export` works without
  any `--parameter` for those.
- **Lambda-backed Custom Resources** (`Custom::*` AND
  `AWS::CloudFormation::CustomResource`) require `--include-non-importable`
  to opt into the 2-phase flow: phase 1 IMPORT changeset for the
  importable resources, then phase 2 UPDATE changeset for the full
  template — CFn CREATEs the Custom Resources, which re-invokes each
  backing Lambda's onCreate handler. The handler must be (1) idempotent
  (same `PhysicalResourceId` / `Data` on every event type) AND
  (2) correctly do the cfn-response protocol (PUT a Status/PhysicalResourceId
  payload to `event.ResponseURL`). cdkd's deploy path also accepts a
  return-value fast path for handler responses, but CFn-side phase-2
  UPDATE / future rollback / future `cdk deploy` against the imported
  stack all require the actual ResponseURL POST — a CR backed by a
  return-only Lambda will time out at the CFn 1-hour Custom Resource
  ceiling. Without the flag, the CR types in the template cause the
  command to abort. `AWS::CloudFormation::Stack` (nested stacks) is
  fully supported: the dedicated branch + `buildCdkdStateStackTree` walker
  recursively loads every child state file, validates the tree shape,
  and `runPerStackImportLoop` submits one IMPORT changeset per
  cdkd-managed stack in the tree in leaf-first order. Non-leaf parents
  adopt their just-imported children via the AWS-docs "Nest an
  existing stack" pattern (the original
  `--include-nested-stacks` design was found infeasible by the
  2026-05-24 AWS spike — see the
  [nested-stack export/import design note](design/464-nested-stacks-export-import.md)
  §4.0 / §4.3 for the per-stack-loop algorithm). On per-stack failure,
  cdkd state for the failed stack and every yet-to-be-imported stack
  is preserved; the error message names which stacks moved and which
  remain so the user can re-run `cdkd export <parent>` after fixing
  the underlying cause (already-imported children will be re-adopted
  as nested references on retry). On phase-2 failure, cdkd state is
  preserved and the error message includes the recovery procedure
  (`aws cloudformation create-change-set --change-set-type UPDATE ...`
  followed by `cdkd state orphan`).
- **Inline `TemplateBody` only** (51,200-byte cap). Templates larger than
  that require S3 upload via `TemplateURL`; not yet implemented.
- **Synth template used verbatim**: cdkd does NOT substitute `observedProperties`
  into the template. If the CDK code has drifted from the AWS-current state,
  the next `cdk deploy` after migration will update the resource. Run
  `cdkd drift` before exporting if drift matters.

**Context preservation (CLI `-c` is refused by default)**:

CDK reads context from `cdk.json` and `cdk.context.json` on every
synth. CLI `-c key=value` overrides are NOT persisted to either file
— they apply only to the current invocation. If you run `cdkd export
-c env=prod` and later run `cdk deploy` without the same `-c env=prod`,
CDK synthesizes a different template, which CFn sees as drift / a
replacement on the first post-migration deploy.

`cdkd export` refuses by default when CLI `-c` overrides are present.
Two ways forward:

- **Recommended**: move the overrides into `cdk.json`'s `"context": { ... }`
  field, then re-run `cdkd export` without `-c`. Subsequent `cdk deploy`
  invocations read `cdk.json` automatically.
- **Escape**: pass `--accept-transient-context`. cdkd proceeds and emits
  a warn that names every override. You are then responsible for passing
  the SAME `-c` flags to every future `cdk deploy` for this stack (or
  moving them to `cdk.json` before then). On success, cdkd prints the
  exact `cdk diff` / `cdk deploy` command including the captured flags.

**Caveats**:

- **Replacement risk on next deploy** (post-v0.95, only one residual
  case):
  - **Pre-v0.94.0 prefix legacy** (`--prefix-user-supplied-names` opt-in,
    or stacks deployed before v0.94.0 flipped the default): cdkd's deploy
    prefixed user-declared physical names with the stack name for
    cross-stack uniqueness (e.g. `roleName: 'my-role'` became
    `MyStack-my-role` on AWS). The phase-1 IMPORT preprocessing rewrites
    the template's name field to the prefixed value (otherwise CFn
    IMPORT rejects the identifier mismatch), and this prefixed value
    persists into the post-import CFn template. The next `cdk deploy`
    will see `MyStack-my-role` (CFn-recorded) vs `my-role` (CDK-declared)
    as a property change on an immutable name field → REPLACEMENT.
    Before the first post-export deploy, either change the CDK code to
    the prefixed value (`roleName: 'MyStack-my-role'`) or accept the
    replacement. The prefix-migration pre-flight
    (`prefix-migration-check.ts`) is meant to surface this before export.

  **No longer in this category as of v0.95**:
  - Auto-generated names (user did NOT declare `bucketName: '...'` etc.):
    cdkd's overlay used to bake the cdkd-prefixed name into the
    post-export CFn template, causing every auto-named resource to be
    proposed for REPLACE on next `cdk deploy`. Post-v0.95 the overlay is
    conditional and skipped for this case → post-export `cdk diff` is
    clean for auto-gen names.
  - Composite-id sub-resources (`AWS::ApiGateway::Method` /
    `AWS::ApiGatewayV2::Integration` / `AWS::ApiGatewayV2::Route` /
    `AWS::Lambda::Permission` etc.): cdkd's overlay used to overwrite
    `Properties.ApiId` (intrinsic `{Ref: ...}`) with the resolved literal
    parent id, causing every composite sub-resource to be proposed for
    REPLACE on next `cdk deploy`. Post-v0.95 intrinsics are preserved →
    post-export `cdk diff` is clean for composite sub-resources.

  When the legacy prefix case applies, check the post-import changeset
  (`aws cloudformation create-change-set --change-set-type UPDATE`) for
  surprises before executing your first post-export `cdk deploy`.
- **Cross-stack `Fn::GetStackOutput` consumers** in other cdkd stacks
  keep working after the export via the CloudFormation fallback: the exported
  stack's outputs move to CloudFormation, and the consumers' next
  resolve reads them from there (`DescribeStacks`) after the cdkd-state
  miss. The reference stays weak either way. Only when deploying
  consumers with `--no-cfn-fallback` does the pre-fallback constraint
  return — plan multi-stack migrations from the leaves up in that case.

Exits `0` on success, `1` on any failure (changeset rejection, AWS
auth, lock contention, etc.). cdkd state is deleted only after the
import changeset completes successfully; a mid-flow failure leaves
cdkd state intact and the user can re-run the command.

