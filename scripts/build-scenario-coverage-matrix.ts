#!/usr/bin/env node
/**
 * scripts/build-scenario-coverage-matrix.ts
 *
 * Builds a `(canonical real-AWS scenario tag) -> (integ fixture)`
 * coverage map by reading per-fixture sidecar `.scenarios.json` files
 * and producing a markdown + json report.
 *
 * Mirrors the structural shape of build-integ-coverage-matrix.ts (the
 * provider-coverage Phase 1 tool). Differences:
 *
 *   - Phase 1 (provider-coverage) covers "did anyone exercise THIS AWS
 *     resource type at all?" — axis is the type registry.
 *   - Phase 2B (this script) covers "did anyone exercise THIS real-AWS
 *     regression pattern?" — axis is a curated taxonomy of patterns
 *     cdkd has historically broken (Lambda ENI release, NAT GW cleanup,
 *     cross-stack ImportValue, etc.).
 *
 * The two are complementary: a fixture can register-cover the AWS::Lambda
 * type without exercising the VPC-Lambda-ENI-release pattern, and a
 * pattern can affect multiple resource types at once.
 *
 * Inputs:
 *   - tests/integration/<fixture>/.scenarios.json (optional):
 *       { "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"] }
 *     Empty `[]` = "intentionally no canonical scenario applies".
 *     Absent file = "not yet annotated"; surfaced as un-annotated.
 *   - KNOWN_SCENARIOS (this file): the canonical taxonomy. Each entry
 *     has a one-line description. A sidecar tag not in this set is
 *     rejected at parse time as a typo.
 *
 * Outputs:
 *   - docs/_generated/scenario-coverage.json: machine-readable matrix.
 *   - docs/scenario-coverage.md:              markdown report.
 *
 * Run from the repo root:
 *   node --experimental-strip-types scripts/build-scenario-coverage-matrix.ts
 *   (or: vp run scenario-coverage)
 *
 * Why a visibility report and not a commit-time gate:
 *   - Many cdkd fixtures legitimately exercise no canonical scenario
 *     (they're per-service smoke tests). Gating commits on "every new
 *     fixture must tag a scenario" would force false annotations or
 *     add per-fixture allowlist friction.
 *   - The intended consumer is the contributor reviewing "does THIS
 *     real-AWS pattern have a backstop?" — a question that benefits
 *     from a periodic regen + read rather than a fail-the-commit gate.
 *
 * CI auto-regen check (mirrors #399 for integ-coverage / #422 for
 * audit-provider-coverage): `vp run scenario-coverage` + `git diff
 * --quiet docs/_generated/scenario-coverage.json docs/scenario-coverage.md`
 * fails CI if a fixture sidecar was added without regenerating the
 * report. Wired in .github/workflows/ci.yml.
 *
 * Adding a new scenario:
 *   1. Add an entry to KNOWN_SCENARIOS with a one-line description.
 *   2. Tag the existing fixtures that exercise it (sidecar JSON or
 *      a new fixture).
 *   3. `vp run scenario-coverage` to regenerate.
 *
 * Removing a scenario (rare):
 *   - Remove from KNOWN_SCENARIOS. Any sidecar still referencing it
 *     will fail the parse-time validator on the next CI / pre-commit
 *     regen, surfacing the cleanup site list.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');

const INTEG_DIR = join(REPO_ROOT, 'tests/integration');
const OUTPUT_JSON = join(REPO_ROOT, 'docs/_generated/scenario-coverage.json');
const OUTPUT_MD = join(REPO_ROOT, 'docs/scenario-coverage.md');
const SIDECAR_NAME = '.scenarios.json';

/**
 * Canonical taxonomy of real-AWS regression patterns cdkd has
 * historically broken or that warrant explicit backstops. Each tag
 * names a CONCRETE failure mode, not a service. Adding a tag should
 * answer the question "what bug would surface if the only fixture
 * carrying this tag stopped exercising it?".
 *
 * Tag naming convention:
 *   - lowercase-hyphenated.
 *   - prefix the affected subsystem when the scope is local (`local-`,
 *     `state-`, `multi-stack-`).
 *   - describe the PATTERN, not the resource type (e.g.
 *     `vpc-lambda-eni-release`, not `lambda-vpc-config`).
 */
const KNOWN_SCENARIOS: Record<string, string> = {
  // ---- Real-AWS DAG / eventual-consistency patterns ----
  'vpc-lambda-eni-release':
    'Lambda hyperplane ENI cleanup after DeleteFunction (5-30 min eventually consistent).',
  'nat-gateway-cleanup':
    'NAT Gateway destroy + dependent route cleanup (unconditional `waitUntilNatGatewayDeleted` on destroy).',
  'lambda-vpc-subnet-sg-deletion-order':
    'Subnet/SecurityGroup must delete AFTER Lambda::Function to avoid ENI DependencyViolation.',
  'elbv2-listener-tg-lb-deletion-order':
    'ELBv2 destroy ordering web: Listener/ListenerRule before TargetGroup (ResourceInUse), TG + Listener before the LoadBalancer, and the LB hyperplane ENI + registered-target ENI release before Subnet/SecurityGroup delete (DependencyViolation).',
  'iam-policy-propagation-retry':
    'CREATE retry with exponential backoff after IAM-EC2/Lambda eventual-consistency race.',
  'sg-circular-dependency':
    'Circular Security Group reference (SG-A ingress from SG-B AND SG-B ingress from SG-A) modeled via standalone AWS::EC2::SecurityGroupIngress resources. DAG builder must not raise a false cycle; destroy must revoke both ingress rules BEFORE deleting either SG (SecurityGroup-after-SecurityGroupIngress implicit-delete-dep) or AWS rejects DeleteSecurityGroup with DependencyViolation.',
  'iam-fresh-role-immediate-assume':
    'Race detector: SEVERAL brand-new IAM roles each consumed within ~1s by a DIFFERENT service in ONE deploy (Lambda exec role -> CreateFunction; SFN role -> CreateStateMachine; EventBridge target role -> PutTargets; fresh principal -> SQS QueuePolicy + SNS TopicPolicy). Deploy SUCCESS is the pass condition — a failure is an unprotected consumer racing IAM propagation (the narrow #794/#805/#756 fixes cover only a few consumers).',
  'fresh-principal-consumer-race':
    'A consumer resource created moments after the fresh principal/resource it references in the SAME deploy: IAM InstanceProfile -> EC2 Instance (RunInstances validates the profile), Lambda::Permission granting a fresh S3 source (AddPermission validates SourceArn + function), S3 BucketPolicy referencing a fresh role principal ("Invalid principal in policy"), KMS key policy referencing a fresh role (CreateKey validates principals). Each is a distinct propagation-race edge from the original IAM-propagation-stress integ (Lambda exec role / SFN role / EventBridge target / SQS+SNS policy, #839). Pass condition = deploy SUCCEEDS, so the fixture is a race detector for missing transient-retry coverage in src/deployment/retryable-errors.ts.',
  'cdk-defensive-vpc-deps-relax':
    'CDK-defensive route DependsOn relaxation for VPC Lambda parallelization.',

  // ---- Intrinsic-function resolution patterns ----
  'intrinsic-hard-arg-shapes':
    'Resolver correctness on the harder / less-common intrinsic arg shapes feeding real resource values: `Fn::Select` over a list-returning intrinsic (`Fn::GetAZs` / `Fn::Split`), `Fn::FindInMap` enhanced 4th-arg `{DefaultValue}` + `Ref`-driven top key, `Fn::GetAtt` with a `Ref`-valued attribute name, the `Fn::Sub` `${!Literal}` escape, `Fn::Base64` of an intrinsic, a triple-nested `Fn::If`-in-`Fn::Sub`-in-`Fn::Join`, and `Fn::Cidr` IPv6. Sibling of `intrinsics-torture` (which found bug #838).',
  'deep-getatt-chain-resolution':
    'Long GetAtt chain where each resource POST-CREATE attribute (ARN / generated name only known after the AWS create call) feeds the next resource property, spanning a SDK + CC-API type mix. A wrong / late attribute resolution on either path (SDK `attributes` write or CC-API stored attributes + `constructAttribute` fallback) is pinpointed by the failing link. Critical hop: an unregistered CC-API type (`AWS::CloudWatch::CompositeAlarm`) whose `Arn` feeds downstream SDK-resource properties (issue: deep-getatt-chains fixture).',

  // ---- Cross-stack reference patterns ----
  'multi-stack-getstackoutput':
    'Cross-stack `Fn::GetStackOutput` weak reference resolution (cdkd-specific, no CFn Export).',
  'getstackoutput-cross-region':
    'Cross-REGION `Fn::GetStackOutput` (cdkd-specific): a CONSUMER stack deployed in region Y reads a PRODUCER stack output from region X via the `Region` argument. Works same-account because the cdkd state bucket is account-scoped (not region-scoped) — the resolver reads `cdkd/{Producer}/{regionX}/state.json` from the same bucket the consumer state lives in. No CFn equivalent (CFn Exports are region-scoped).',
  'multi-stack-importvalue-strong-ref':
    'Cross-stack `Fn::ImportValue` strong-reference + persistent exports index (schema v4 imports[]).',
  'multi-stack-outputs-only-export':
    'Outputs-only change on an already-deployed producer (issue #875): a downstream consumer starts referencing the producer, so CDK synth adds a new Output/Export to the producer WITHOUT changing any of its resources. The producer redeploy is a no-op at the resource level but must still persist the new export to state + the exports index, otherwise the consumer (deployed with --exclusively, so the producer is not redeployed to paper over the gap) fails to resolve its Fn::ImportValue.',
  'sdk-ccapi-crossref-boundary':
    'Heterogeneous SDK-Provider <-> Cloud Control API routing in ONE stack (a silent-drop top-level property flips a resource to the CC path per #614) with `Fn::GetAtt` cross-references crossing the boundary in BOTH directions — SDK-routed consumer reads a CC-routed producer attribute AND CC-routed consumer reads an SDK-routed producer attribute. Exercises the constructAttribute fallback for CC-API physical-id shapes (memory `feedback_silent_drop_forces_cc_api_routing`) and the CC delete path bypassing the SDK provider delete() (memory `feedback_cc_api_routing_bypasses_sdk_delete_logic`).',

  // ---- Dynamic reference patterns ----
  'dynamic-reference-resolution':
    'CloudFormation dynamic references (`{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}`) resolved by cdkd itself (`resolveDynamicReferences`) BEFORE the property reaches the provider — JSON-key (`:SecretString:<key>`), whole-secret, and version-stage forms + plaintext SSM param; the deployed resource carries the RESOLVED value, never the literal token. (`ssm-secure:` is NOT resolved by cdkd and is intentionally out of scope.)',

  // ---- Custom Resource patterns ----
  'custom-resource-async-poll':
    'Custom Resource backed by Lambda + cfn-response via S3 pre-signed URL polling.',
  'vpc-lambda-cr-race':
    'Custom Resource invocation against a VPC Lambda mid-deploy (ENI-attach race window).',
  'custom-resource-getatt-data':
    "Custom Resource response `Data` consumed via `Fn::GetAtt(CR, 'Data.<key>')` / `Fn::GetAtt(CR, '<key>')` into ANOTHER resource's property (e.g. an SSM Parameter Value) — the fragile CR response-Data attribute path (#756 / #804: CR attributes only exist after the CR Lambda runs). Asserts the dependent's on-AWS value equals the value the CR handler returned, across multiple Data keys + an explicit dependent->CR dependency.",
  'destroy-interrupt':
    'Graceful SIGINT on destroy (#816 — first Ctrl-C drains in-flight deletes, flushes trimmed state, releases the lock, exits non-zero; no 30m stranded lock) + Custom Resource replay fail-fast on re-run (#804 — the CR delete does NOT stall ~10 minutes invoking GetFunction against the already-deleted backing Lambda; the re-run resumes cleanly and quickly).',

  // ---- Migration patterns ----
  'export-to-cfn-handover':
    'cdkd → CloudFormation migration via 2-phase IMPORT changeset + phase-2 UPDATE.',
  'migrate-from-cfn-handover':
    'CloudFormation → cdkd migration via `--migrate-from-cloudformation` (UpdateStack with Retain + DeleteStack).',
  'migrate-from-bare-cfn':
    '`cdkd migrate --from-cfn-stack <name>` end-to-end: bare CFn → `cdk migrate` codegen → 2-pass resource mapping → cdkd state + optional retire.',
  'selective-import-attribute-persistence':
    'Selective `cdkd import --resource <LogicalId>=<physical>` adoption of an already-deployed resource whose provider `import()` returns a NON-EMPTY `attributes` map, asserting the map is persisted into the state row (issue #1098: `buildStackState` hardcoded `attributes: {}` and dropped it, leaving an adopted resource with no `Fn::GetAtt` backing while a deployed one had it). Uses `AWS::IAM::ManagedPolicy` (`import()` -> `{ PolicyArn }`) after a `cdkd state orphan` drops state while leaving the AWS resource live. Distinct from `migrate-from-cfn-handover`, which covers the CFn retirement path rather than the state-row shape.',
  'nested-stack-migrate-from-cfn':
    'CloudFormation → cdkd RECURSIVE nested-stack migration via `--migrate-from-cloudformation` (recursive DescribeStackResources walk, per-child v6 state writes, recursive DeletionPolicy: Retain injection, parent-side DeleteStack cascade). See #464 PR A.',
  'nested-stack-deep-deploy-cascade':
    'Recursive `cdk.NestedStack` deploy + destroy at depth >= 3 (root → child → grandchild → great-grandchild): per-level `<parent>~<logicalId>` v6 state-key derivation with populated `parentStack` / `parentLogicalId`, bidirectional cross-level refs (bottom-up `Fn::GetAtt` outputs AND top-down `Parameters` forwarding), `state list --tree` hierarchy rendering, and the full reverse-DAG destroy cascade that removes every level\'s resources + state files.',
  'cfn-macro-expansion':
    'CloudFormation macro / `Fn::Transform` expansion via transient CFn changeset round-trip (SAM, AWS::Include, AWS::LanguageExtensions, custom macros). See `docs/design/463-cfn-macros.md`.',

  // ---- Conditions / intrinsic-function patterns ----
  'conditions-and-if':
    'CloudFormation Conditions section + resource-level `Condition:` key + `Fn::If` / `Fn::Equals` / `Fn::And` / `Fn::Or` / `Fn::Not` evaluated by cdkd itself. Two deploys flip a CDK-context-driven CfnParameter Default so the SAME stack is asserted in both settings: condition-gated resource creation (PRESENT vs ABSENT on AWS), `Fn::If` property + tag branch values reaching AWS, and `Fn::If` -> `AWS::NoValue` genuinely OMITTING a property.',
  'raw-cfn-template-diff-parity':
    'Raw CloudFormation template (CfnInclude) carrying Parameters w/ defaults + Mappings + Conditions on resources AND outputs: deploy resolves them, a no-op `cdkd diff --fail` must exit 0 (no phantom replacement / phantom create — #1027), an inlined-parameter change updates in place, and a condition-false Output is skipped without a `Failed to resolve output` warn (#1028).',
  'conditions-update-semantics':
    'Harder CloudFormation-Conditions-on-UPDATE semantics beyond the simple flip in `conditions-and-if` (which surfaced #840). A CDK-context phase flip (-c phase=a|b) redeploys the SAME stack in place and asserts: a resource that MOVES gating conditions (IsPhaseA-gated -> condition-false -> DELETED) and its reverse (IsPhaseB-gated absent -> CREATED); `Fn::If` -> `AWS::NoValue` REMOVING a nested property block (SQS RedrivePolicy) on an in-place UPDATE (same physical id, not a replacement); a condition-gated OUTPUT present vs absent in cdkd state outputs; a `DependsOn` to a condition-EXCLUDED resource being dropped (the depender still deploys); and a `Ref` to a condition-excluded resource living inside another condition-excluded resource (both pruned together, no dangling-ref crash).',

  // ---- Drift / state patterns ----
  'drift-revert-roundtrip':
    'cdkd drift detection + `--revert` round-trip via each provider.update().',
  'update-replace-breadth':
    'Second-deploy property mutation exercising BOTH cdkd update paths in one stack: in-place provider.update() (S3 versioning toggle / Lambda env+memory / IAM inline-policy edit / SecurityGroup ingress add — physical id unchanged) AND replacement (S3 BucketName change per the replacement-rules registry — new physical id, old resource cleaned up). Regression net for provider update() paths + #807 replacement propagation + #809 Cloud Control write-only-property UPDATE on non-ECS types.',
  'replacement-fanout-propagation':
    'Replacement propagation (#807) at FAN-OUT scale: ONE base resource (SNS Topic, TopicName change -> new ARN) referenced by MANY (10) dependents via Fn::Sub of its Ref (10 SSM Parameters + an SNS TopicPolicy). A second deploy with `-c phase=b` replaces the base; `promoteReplacementDependents` (src/analyzer/diff-calculator.ts) must propagate the new ARN to EVERY dependent so none keeps the stale phase-a ARN. Catches fan-out gaps the narrow ECS-only #807 case cannot.',
  'update-policy-mutations':
    'Second-deploy mutation of CloudFormation template-level ATTRIBUTES (not properties) across a CDK context flip (`-c phase=a|b`): (1) `UpdateReplacePolicy: Retain` orphan-on-replace — an S3 `BucketName` change forces replacement, the OLD physical bucket must be RETAINED on AWS (not deleted) while the new one is created; (2) `DeletionPolicy` flip DESTROY->RETAIN on an SSM Parameter — the final destroy must honor the CURRENT (Retain) policy and leave it on AWS; (3) `DependsOn` add/remove between SNS topics — a metadata-only change that must update successfully without replacing either topic; (4) metadata-only / no-op identical redeploy reporting `No changes detected`. Intentional orphans (Retain bucket + Retain param) are cleaned by captured physical id in the verify.sh trap. Regression net for `diff-calculator.ts` attribute diff + `deploy-engine.ts` Retain-on-replace / DeletionPolicy destroy-skip paths.',
  'drift-revert-array-canonicalization':
    'cdkd drift no-false-positive on tag-list / resource-id / ARN array REORDER (issue #802 `drift-normalize.ts` canonicalization) while still detecting real value / Action / SG-rule drift.',
  'remove-protection-bypass':
    '`--remove-protection` flag bypassing AWS-side deletion-protection on supported types.',
  'multi-region-state-key':
    'Same stackName + different regions = independent state files (`version: 2` region-prefixed key layout).',
  'state-bucket-region-resolve':
    'State-bucket S3 clients (state backend + lock manager) auto-detect bucket region via `GetBucketLocation` regardless of caller-profile region.',
  'exports-index-region-resolve':
    'Exports index store (`Fn::ImportValue` tracking, `_index/{region}/exports.json`) auto-detects the bucket region via `GetBucketLocation` before its write/remove, so a cross-region state bucket no longer hits S3 301 PermanentRedirect (issue #819).',
  'state-schema-migration':
    'Legacy v1 / v2 state schema auto-migrates on next write; old binary fails clearly on a newer schema.',
  'import-adopt-live-resource-roundtrip':
    'End-to-end `cdkd import` adoption of a LIVE AWS resource: drop the resource from cdkd state with `cdkd orphan` (AWS untouched), re-adopt it with `cdkd import --resource <logicalId>=<physicalId>`, then destroy THROUGH the re-adopted record. Exercises the provider `import()` + `readCurrentState()` pair (the `observedProperties` baseline seeded post-import) and the selective-mode merge that must preserve unlisted sibling rows. Distinct from `nested-stack-migrate-from-cfn`, which covers the `--migrate-from-cloudformation` path; NO fixture covered the plain adopt mode before (issue #1090).',
  'legacy-bucket-name-fallback':
    'New region-free `cdkd-state-{account}` vs legacy `cdkd-state-{account}-{region}` bucket fallback resolution.',
  // NOTE: `partial-create-cleanup` (post-`Create*` wiring failure issues
  // best-effort `Delete*` before re-throwing — PRs #374 / #377 / #378 /
  // #379 / #380) is INTENTIONALLY NOT a canonical scenario tag. The
  // behavior is exercised end-to-end at the unit-test level
  // (`tests/unit/provisioning/*-partial-create-cleanup.test.ts`, ~12
  // providers covered), and mid-create-wiring failure injection on real
  // AWS is impractical — there is no AWS-side way to deterministically
  // reject `applyTags` / `PutIntegrationResponse` / `RegisterScalableTarget`
  // mid-flight after the parent `Create*Command` already succeeded. Keeping
  // the tag in the canonical taxonomy would surface as a permanent orphan
  // on every regen, which dilutes the orphan-as-signal value of the
  // matrix. The unit-test coverage IS the structural guarantee here; the
  // matrix is the real-AWS regression layer above it.
  'deletion-policy-retain':
    'DeletionPolicy: Retain skip on destroy (schema v5 recorded value wins over template).',
  'deployment-events':
    'Structured deployment events to S3 + `cdkd events` command (issue #808): per-run `deployments/{runId}.jsonl` + `index.json` (separate key family from state.json, no schema bump), events survive `cdkd destroy`, and carry error + metadata ONLY (no resource properties / secrets).',
  's3-asset-deploy':
    'File/ZIP asset publishing during `cdkd deploy`: a multi-file local directory is zipped + uploaded to the CDK bootstrap asset bucket by `FileAssetPublisher` (content-addressed, skip-if-exists), the Lambda `Code.S3Bucket`/`Code.S3Key` ref is wired to the uploaded object (CodeSize proves it is NOT inline), AND a generic `s3_assets.Asset` upload is read back at runtime via cdkd-resolved bucket/key env vars. Bootstrap-bucket asset objects persist by design across destroy.',
  'rollback-failure-injection':
    'deploy-engine ROLLBACK path on a RICH multi-resource stack (VPC+SG+IAM Role+Lambda-in-VPC+SSM Parameter): a self-contained env-gated (`ROLLBACK_INTEG_FAIL`) failing SQS Queue (out-of-range messageRetentionPeriod) wired to depend on the fast siblings forces a deploy failure AFTER siblings complete; verify.sh asserts the completed siblings are rolled back (no orphan VPC/SG/ENI/Role/Lambda/SSM, state empty) and the #808 events captured RESOURCE_FAILED + ROLLBACK_* + RUN_FINISHED=FAILED.',
  'stack-level-tag-propagation-multitype':
    'STACK-LEVEL tags (`cdk.Tags.of(app/stack).add(k, v)`) propagate to ALL taggable resources across MANY types on BOTH the SDK-provider path (S3 / SNS / SQS / SSM Parameter / IAM Role / Logs LogGroup / Lambda / DynamoDB) AND the Cloud Control API path (Athena WorkGroup, no SDK provider). Each AWS type accepts tags in a DIFFERENT wire shape ({Key,Value}[] list vs { k: v } map vs the CC-API forwarder) — notably `AWS::SSM::Parameter.Tags` is a CFn MAP (the historical `Tags.map()` deploy-crash type per feedback_ssm_parameter_tags_is_a_map). verify.sh reads live AWS tags per type via that type-specific list/describe API and asserts ALL stack-level tags landed with the right value; a dropped tag FAILs naming the type. Also asserts post-deploy `cdkd drift` is clean (no #802 tag-list-reorder false positive).',

  // ---- Multi-resource / broad-regression set ----
  'cross-cutting-deploy-destroy':
    'Broad real-AWS regression set (39+ resource VPC+NAT+CF+Lambda+SQS or comparable breadth). Refreshes the integ-broad gate.',
  'wide-dag-throttle-retry':
    'Wide (~100-resource: 80 SSM Parameters + 10 IAM Roles + 10 SNS Topics, 10-deep SSM Fn::Sub chain) single-stack burst deployed under a HIGH `--concurrency` to stress the concurrency limiter + event-driven DAG executor + throttle/retry classifier: a `TooManyRequests` / `Rate exceeded` / HTTP 429 during the burst must be RETRIED (deploy still succeeds) not fatal, the chained subset proves strict DAG ordering, and the destroy burst absorbs ~100 deletes with 0 orphans.',

  // ---- Intrinsic-function resolution patterns ----
  'intrinsics-torture':
    "Stress-test of cdkd's hand-rolled intrinsic-function resolver (`src/deployment/intrinsic-function-resolver.ts`), which resolves EVERY intrinsic itself instead of deferring to CloudFormation. Each harder intrinsic computes an `AWS::SSM::Parameter` Value read back + asserted against an independently-computed expected value: `Fn::Cidr` (carve a /16 into eight /24s), `Fn::FindInMap` (Mappings region/env lookup), `Fn::GetAZs` + `Fn::Select`, `Fn::Base64`, nested `Fn::Split` + `Fn::Select` + `Fn::Join`, deeply-nested two-arg `Fn::Sub` (literal-map var via `Fn::Join` + `${AWS::Region}` + `${Resource.Arn}` GetAtt), and ALL pseudo-parameters (AccountId / Region / Partition / StackName / URLSuffix / NotificationARNs). Goes beyond the `intrinsic-functions` fixture (which covers only Ref / GetAtt / Join / Sub).",

  // ---- Type-family-specific tricky patterns ----
  'globaltable-cross-region-replica':
    'DynamoDB GlobalTable cross-region replica add/remove serialization (AWS rejects multiple ReplicaUpdates per UpdateTable call).',
  'cloudfront-oai-attribute-enrichment':
    'CloudFront OAI `S3CanonicalUserId` attribute enrichment (the attribute is not on `GetCloudFrontOriginAccessIdentity` directly).',
  'cc-api-getatt-enrichment-elasticache-replicationgroup':
    'CC-API attribute enrichment for `AWS::ElastiCache::ReplicationGroup` (no SDK provider): `Fn::GetAtt(<RG>, PrimaryEndPoint.Address / ReaderEndPoint.* / ConfigurationEndPoint.* / ReadEndPoint.Addresses)` must resolve to the real Redis endpoint via DescribeReplicationGroups, not fall through to the physicalId (the RG id).',
  'cc-api-getatt-enrichment-redshift-cluster':
    'CC-API attribute enrichment for `AWS::Redshift::Cluster` (no SDK provider): `Fn::GetAtt(<Cluster>, Endpoint.Address / Endpoint.Port)` must resolve to the real Redshift endpoint via DescribeClusters, not fall through to the physicalId (the cluster id).',
  'cc-api-getatt-enrichment-opensearch-domain':
    'CC-API attribute enrichment for `AWS::OpenSearchService::Domain` (no SDK provider): `Fn::GetAtt(<Domain>, DomainEndpoint / Arn)` must resolve to the real `*.es.amazonaws.com` endpoint / `arn:aws:es:...:domain/...` ARN via DescribeDomain, not fall through to the physicalId (the domain name).',
  'rds-aurora-cluster-instance':
    'RDS Aurora cluster + writer instance create/destroy with the 30-min wait budget + DBProxy/DBProxyTargetGroup family.',
  'rds-full-stack':
    'Realistic single-instance RDS deployment: L2 `rds.DatabaseInstance` (db.t3.micro, single-AZ, isolated subnets, no NAT) with an EXPLICIT DBSubnetGroup + DBParameterGroup + SecurityGroup + CDK-managed Secrets Manager credentials, plus an SSM Parameter consuming the DBInstance COMPUTED endpoint via `Fn::GetAtt(<DBInstance>, Endpoint.Address)`. Stresses event-driven DAG ordering (sub-groups before the instance), slow-create propagation (~5-10 min instance create), and intrinsic resolution of a computed attribute only known post-create (the SSM value must equal the live endpoint).',
  'apigateway-cors-preflight':
    'API Gateway CORS preflight (OPTIONS) handling — CDK auto-generates `Method` with both Integration.IntegrationResponses and MethodResponses arrays.',
  'eventsourcemapping-fresh-source-race':
    '`AWS::Lambda::EventSourceMapping` created against a FRESH source (SQS/Kinesis/DynamoDB-stream) + a FRESH execution role in the SAME deploy: the ESM create races source-readiness + role/policy propagation (cdkd dispatches with no level barrier), AND the orphan-ESM-on-redeploy collision class (a killed mid-deploy leaves an out-of-state ESM that collides on the next CREATE). The fixture pre-flight-scans for orphan ESMs by stack name, asserts the ESM reaches Enabled + actually delivers a probe message to the Lambda, and asserts no orphan ESM survives destroy.',

  // ---- Asset-publishing patterns ----
  'docker-image-asset-ecr-publish':
    "cdkd's deploy-time Docker ASSET pipeline (`DockerAssetPublisher`): `docker build` of a local Dockerfile -> ECR auth -> `docker push` to the CDK-managed container-assets repo, then an `AWS::Lambda::Function` with `PackageType=Image` pointing at the pushed image. Distinct from the local-emulation container scenarios (which never touch AWS) — this verifies the real build+push happens during `cdkd deploy`, the image runs (Lambda invoke), and the pushed image is gone after destroy.",
  'multi-asset':
    "Asset-publishing layer under concurrency: MANY assets of TWO kinds publish in ONE `cdkd deploy` — 1 Docker image asset (`DockerAssetPublisher` -> ECR build+push, ARM_64-pinned) + 3 distinct multi-file directory assets (three distinct `FileAssetPublisher` S3 uploads, one per zip Lambda) + 1 generic `s3_assets.Asset` (a 4th S3 upload read back at runtime via cdkd-resolved bucket/key env). Exercises FileAssetPublisher + DockerAssetPublisher concurrency, ECR + S3 in one run, and asset-ref intrinsics. Each Lambda returns a DISTINCT marker so a cross-wired asset (wrong Code ref) fails the test — proving each distinct asset uploaded AND was wired to the correct Lambda. Clean destroy: all 4 Lambdas + OUR pushed ECR image (by tag) gone; the shared bootstrap container-assets repo + asset bucket objects persist by design.",

  // ---- Local-execution patterns ----
  'local-lambda-rie-zip':
    '`cdkd local invoke` ZIP-runtime Lambda against the AWS Lambda Runtime Interface Emulator (RIE) container.',
  'local-lambda-rie-container':
    '`cdkd local invoke` container-Lambda (Code.ImageUri) against RIE — local-build OR ECR-pull asset resolution.',
  'local-apigateway-server':
    '`cdkd local start-api` HTTP server with route discovery + per-Lambda warm container pool.',
  'local-ecs-task':
    '`cdkd local run-task` ECS TaskDefinition with docker network + AWS-published metadata sidecar.',
  'local-ecs-awsvpc':
    '`cdkd local run-task` ECS TaskDefinition declaring `NetworkMode: awsvpc` — accepted and mapped to a docker bridge network with a startup warn (#461; docker cannot emulate ENI-per-task).',
  'local-ecs-service':
    '`cdkd local start-service` long-running ECS Service emulator: replica pool, restart-on-exit, SIGINT teardown.',
  'local-ecs-service-connect':
    '`cdkd local start-service` Service Connect + Cloud Map peer discovery: ServiceConnectConfiguration + ServiceRegistries parsing, in-process Cloud Map registry, docker `--add-host` DNS overlay (Issue #460).',
  'local-from-state-substitution':
    '`cdkd local invoke|run-task --from-state` substitutes intrinsic-valued env/secret/role references against deployed cdkd state + AWS pseudo parameters.',
  'local-from-cfn-stack-substitution':
    '`cdkd local invoke|start-api|run-task|start-service --from-cfn-stack` substitutes intrinsic-valued env/secret/image references against a deployed CloudFormation stack via DescribeStackResources + ListExports — for CDK apps deployed via the upstream CDK CLI (`cdk deploy`).',
  'local-websocket-api':
    '`cdkd local start-api` WebSocket API support: ws upgrade + $connect/$disconnect/$default/custom route dispatch + @connections data plane.',
  'local-agentcore-runtime':
    '`cdkd local invoke-agentcore` Bedrock AgentCore Runtime: HTTP `/invocations` / MCP `/mcp` / A2A `/a2a` / AGUI / WebSocket `--ws` protocols + inbound JWT auth verification + container artifact + CodeConfiguration managed-runtime source build.',
  'local-agentcore-from-state':
    '`cdkd local invoke-agentcore --from-state` end-to-end against a real-AWS deployed AgentCore Runtime — verifies the cdkd-port-specific 3-arg `createLocalStateProvider` shim resolves intrinsic-valued env vars (e.g. `Ref: <S3 bucket>`) against cdkd state after a real `cdkd deploy`.',

  // ---- cdkd-owned asset storage / gc patterns ----
  'cdkd-asset-storage':
    'cdkd-owned asset storage lifecycle against real AWS: `cdkd bootstrap` creates the asset bucket + container repo + per-region marker (default or custom `--asset-bucket` / `--container-repo` names), deploy-time asset-mode detection + publish redirection into the marker-named storage, and `cdkd bootstrap --destroy` marker-driven teardown with zero residue (issues #1002 / #1007 / #1010 / #1011).',
  'cdkd-gc':
    '`cdkd gc` garbage-collection precision against real AWS: whole-bucket state-file reference scan keeps every referenced asset, an unreferenced seeded object is the only deletion candidate, `--dry-run` deletes nothing, `--older-than` age guard honored (issue #1012).',
};

interface ScenarioCoverageReport {
  knownScenarios: { tag: string; description: string }[];
  fixtures: {
    name: string;
    /** true when a sidecar file exists, even if scenarios is []. */
    annotated: boolean;
    scenarios: string[];
  }[];
  perScenarioCoverage: {
    scenario: string;
    description: string;
    fixtures: string[];
  }[];
  orphanScenarios: string[];
  unannotatedFixtures: string[];
  invalidTagSites: { fixture: string; tag: string }[];
}

/**
 * Read a single fixture's sidecar. Returns:
 *   - {kind: 'absent'} when the file does not exist (un-annotated).
 *   - {kind: 'present', scenarios: string[]} when the file parses.
 *   - {kind: 'malformed', reason: string} when the file exists but
 *     fails JSON / shape validation. Triggers a hard error in main()
 *     because a malformed sidecar is a contributor error worth
 *     surfacing loudly.
 *
 * The sidecar shape is `{ "scenarios": ["tag1", "tag2"] }`. Empty
 * `[]` is legal and means "intentionally no canonical scenario
 * applies to this fixture".
 */
export type SidecarResult =
  | { kind: 'absent' }
  | { kind: 'present'; scenarios: string[] }
  | { kind: 'malformed'; reason: string };

export function readFixtureSidecar(fixtureDir: string): SidecarResult {
  const sidecarPath = join(fixtureDir, SIDECAR_NAME);
  if (!existsSync(sidecarPath)) return { kind: 'absent' };
  return parseSidecarContent(readFileSync(sidecarPath, 'utf8'));
}

export function parseSidecarContent(raw: string): SidecarResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'malformed', reason: `invalid JSON: ${(err as Error).message}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { kind: 'malformed', reason: 'top-level value must be an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (!('scenarios' in obj)) {
    return { kind: 'malformed', reason: 'missing required key "scenarios"' };
  }
  const scenarios = obj.scenarios;
  if (!Array.isArray(scenarios)) {
    return { kind: 'malformed', reason: '"scenarios" must be an array' };
  }
  const seen = new Set<string>();
  for (let i = 0; i < scenarios.length; i++) {
    const tag = scenarios[i];
    if (typeof tag !== 'string' || tag.trim() === '') {
      return {
        kind: 'malformed',
        reason: `"scenarios[${i}]" must be a non-empty string`,
      };
    }
    if (seen.has(tag)) {
      return {
        kind: 'malformed',
        reason: `"scenarios[${i}]" duplicates an earlier entry "${tag}"`,
      };
    }
    seen.add(tag);
  }
  return { kind: 'present', scenarios: scenarios as string[] };
}

export function listFixtures(integDir: string = INTEG_DIR): string[] {
  if (!existsSync(integDir)) return [];
  return readdirSync(integDir)
    .filter((name) => {
      // Ignore hidden directories (e.g. `.scratch/`, IDE folders); the
      // matrix is scoped to real integ fixtures only.
      if (name.startsWith('.')) return false;
      const full = join(integDir, name);
      try {
        return statSync(full).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function buildReport(integDir: string = INTEG_DIR): ScenarioCoverageReport {
  const knownScenarios = Object.keys(KNOWN_SCENARIOS).sort();
  const fixtureDirs = listFixtures(integDir);
  const invalidTagSites: { fixture: string; tag: string }[] = [];
  const malformed: { fixture: string; reason: string }[] = [];

  const fixtures: ScenarioCoverageReport['fixtures'] = [];
  for (const name of fixtureDirs) {
    const result = readFixtureSidecar(join(integDir, name));
    if (result.kind === 'absent') {
      fixtures.push({ name, annotated: false, scenarios: [] });
      continue;
    }
    if (result.kind === 'malformed') {
      malformed.push({ fixture: name, reason: result.reason });
      continue;
    }
    const validated: string[] = [];
    for (const tag of result.scenarios) {
      if (!(tag in KNOWN_SCENARIOS)) {
        invalidTagSites.push({ fixture: name, tag });
      } else {
        validated.push(tag);
      }
    }
    fixtures.push({ name, annotated: true, scenarios: validated.sort() });
  }

  if (malformed.length > 0) {
    const lines = malformed.map((m) => `  - ${m.fixture}/.scenarios.json: ${m.reason}`);
    throw new Error(
      `scenario-coverage: ${malformed.length} malformed sidecar file(s):\n${lines.join('\n')}`
    );
  }

  // Per-scenario coverage map.
  const perScenario = new Map<string, string[]>();
  for (const tag of knownScenarios) perScenario.set(tag, []);
  for (const f of fixtures) {
    for (const tag of f.scenarios) {
      perScenario.get(tag)!.push(f.name);
    }
  }

  const perScenarioCoverage = knownScenarios.map((tag) => ({
    scenario: tag,
    description: KNOWN_SCENARIOS[tag],
    fixtures: (perScenario.get(tag) ?? []).sort(),
  }));

  const orphanScenarios = perScenarioCoverage.filter((e) => e.fixtures.length === 0).map((e) => e.scenario);
  const unannotatedFixtures = fixtures.filter((f) => !f.annotated).map((f) => f.name);

  return {
    knownScenarios: knownScenarios.map((tag) => ({ tag, description: KNOWN_SCENARIOS[tag] })),
    fixtures,
    perScenarioCoverage,
    orphanScenarios,
    unannotatedFixtures,
    invalidTagSites,
  };
}

export function renderMarkdown(report: ScenarioCoverageReport): string {
  const lines: string[] = [];
  lines.push('# Scenario Coverage Matrix');
  lines.push('');
  lines.push('<!-- AUTO-GENERATED by scripts/build-scenario-coverage-matrix.ts. Do not hand-edit. -->');
  lines.push('');
  lines.push('Run `vp run scenario-coverage` to regenerate.');
  lines.push('');
  const totalScenarios = report.knownScenarios.length;
  const covered = totalScenarios - report.orphanScenarios.length;
  const annotated = report.fixtures.length - report.unannotatedFixtures.length;
  const total = report.fixtures.length;
  lines.push(
    `**${covered} / ${totalScenarios} canonical scenarios** have at least one integ fixture exercising them. **${annotated} / ${total} integ fixtures** carry a \`.scenarios.json\` sidecar (with 0+ tags); the rest are un-annotated and contributor-reviewed below.`
  );
  lines.push('');
  lines.push('## How this is computed');
  lines.push('');
  lines.push(
    'Each `tests/integration/<fixture>/.scenarios.json` sidecar declares which canonical real-AWS regression patterns the fixture exercises. The canonical taxonomy lives in [scripts/build-scenario-coverage-matrix.ts](../scripts/build-scenario-coverage-matrix.ts) as `KNOWN_SCENARIOS` — sidecar tags outside the taxonomy are rejected at parse time so typos surface immediately.'
  );
  lines.push('');
  lines.push('**Sidecar shape**:');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"]');
  lines.push('}');
  lines.push('```');
  lines.push('');
  lines.push('Empty `[]` means "intentionally no canonical scenario applies to this fixture" (per-service smoke tests). Absent file means "not yet annotated" — surfaced in the un-annotated section below.');
  lines.push('');
  lines.push('This report is a visibility tool, not a commit-time gate. Many cdkd fixtures legitimately exercise no canonical scenario, and forcing per-commit annotation would add friction without proportional value. Contrast with the provider-coverage matrix ([docs/integ-coverage.md](integ-coverage.md)) which IS gated because the "is every registered SDK Provider exercised?" question has a structural answer.');
  lines.push('');

  // --- Orphan scenarios ---
  if (report.orphanScenarios.length > 0) {
    lines.push(`## Orphan scenarios (${report.orphanScenarios.length})`);
    lines.push('');
    lines.push(
      'These canonical scenarios have NO integ fixture tagged with them. Each is a real-AWS verification gap — a regression against the named pattern would only surface in production. Either tag an existing fixture (when it already exercises the pattern) or write a new fixture.'
    );
    lines.push('');
    lines.push('| Scenario | Description |');
    lines.push('|---|---|');
    for (const tag of report.orphanScenarios) {
      const desc = KNOWN_SCENARIOS[tag];
      lines.push(`| \`${tag}\` | ${desc} |`);
    }
    lines.push('');
  } else {
    lines.push('## Orphan scenarios');
    lines.push('');
    lines.push('_None._ Every canonical scenario has at least one integ fixture tagged with it.');
    lines.push('');
  }

  // --- Per-scenario coverage table ---
  lines.push(`## Per-scenario coverage (${report.knownScenarios.length} scenarios)`);
  lines.push('');
  lines.push('| Scenario | Description | Integ Fixture(s) |');
  lines.push('|---|---|---|');
  for (const entry of report.perScenarioCoverage) {
    const fixtures = entry.fixtures.length === 0
      ? '_(orphan)_'
      : entry.fixtures.map((f) => `[\`${f}\`](../tests/integration/${f}/)`).join('<br>');
    lines.push(`| \`${entry.scenario}\` | ${entry.description} | ${fixtures} |`);
  }
  lines.push('');

  // --- Un-annotated fixtures ---
  if (report.unannotatedFixtures.length > 0) {
    lines.push(`## Un-annotated fixtures (${report.unannotatedFixtures.length})`);
    lines.push('');
    lines.push(
      'These integ fixtures have no `.scenarios.json` sidecar. They may or may not exercise a canonical scenario — contributor review needed. To opt out (per-service smoke tests with no canonical pattern), add a sidecar with `{ "scenarios": [] }`.'
    );
    lines.push('');
    for (const name of report.unannotatedFixtures) {
      lines.push(`- [\`${name}\`](../tests/integration/${name}/)`);
    }
    lines.push('');
  } else {
    lines.push('## Un-annotated fixtures');
    lines.push('');
    lines.push('_None._ Every integ fixture has a `.scenarios.json` sidecar (with 0+ tags).');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * True when the file is executed directly (`node scripts/build-...ts`),
 * false when imported by a test or another script. Mirrors the pattern
 * in scripts/build-integ-coverage-matrix.ts so importing the module
 * surface for unit tests does NOT trigger the matrix regeneration.
 */
const isMainModule = (): boolean => {
  if (!process.argv[1]) return false;
  return resolve(process.argv[1]) === __filename;
};

function main(): void {
  const report = buildReport();
  if (report.invalidTagSites.length > 0) {
    const lines = report.invalidTagSites.map(
      (s) => `  - ${s.fixture}/.scenarios.json: unknown tag "${s.tag}"`
    );
    const known = Object.keys(KNOWN_SCENARIOS).sort().map((t) => `  - ${t}`).join('\n');
    throw new Error(
      `scenario-coverage: ${report.invalidTagSites.length} invalid tag(s) — tags must be one of KNOWN_SCENARIOS in scripts/build-scenario-coverage-matrix.ts:\n${lines.join('\n')}\nKnown scenarios:\n${known}`
    );
  }
  mkdirSync(dirname(OUTPUT_JSON), { recursive: true });
  // Strip `invalidTagSites` from the on-disk JSON: `main()` throws above
  // on any non-empty value, so the committed snapshot would only ever
  // carry `invalidTagSites: []` (dead field). The report shape keeps it
  // for unit tests that exercise the validator surface directly.
  const { invalidTagSites: _, ...persistable } = report;
  writeFileSync(OUTPUT_JSON, JSON.stringify(persistable, null, 2) + '\n', 'utf8');
  writeFileSync(OUTPUT_MD, renderMarkdown(report), 'utf8');
  const annotated = report.fixtures.length - report.unannotatedFixtures.length;
  const total = report.fixtures.length;
  const orphan = report.orphanScenarios.length;
  const totalScenarios = report.knownScenarios.length;
  process.stderr.write(
    `scenario-coverage: wrote ${basename(OUTPUT_MD)} and ${basename(OUTPUT_JSON)} — ${annotated}/${total} fixtures annotated, ${totalScenarios - orphan}/${totalScenarios} scenarios covered (${orphan} orphan)\n`
  );
}

if (isMainModule()) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`scenario-coverage: failed — ${(err as Error).message}\n`);
    process.exit(1);
  }
}

// Internal exports for unit tests.
export { KNOWN_SCENARIOS };
