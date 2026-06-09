# Design: Per-resource region (multi-region resources in a single stack)

Tracking issue: _none yet._ Status: **Shelved — design complete, deferred on positioning grounds (see §6). Reopen conditions in §7.**

## 1. Idea

Today cdkd's deploy region is per-stack: a stack synthesizes to one region
(`stackInfo.region`, falling back to CLI `--region` / `AWS_REGION` /
`us-east-1`), and every resource in that stack is provisioned there. The
proposal is to let an **individual resource** declare its own target region,
so a single stack can hold resources spread across regions (the motivating
example: a stack whose home region is `ap-northeast-1` but whose CloudFront /
ACM cert / WAF live in `us-east-1`).

The intended authoring path: cdkd ships (exports) a small CDK extension
helper; the user imports it in their CDK app and applies it to a construct;
cdkd reads the resulting annotation at deploy time and routes that resource's
provisioning to the named region.

This would NOT be CDK-compatible behavior — it is an explicit cdkd extension.
That property is the crux of the decision to shelve it (see §6).

## 2. Feasibility findings (the architecture already leans this way)

Research during the design session found the runtime cost is smaller than it
first appears, because several seams already exist:

- **State bucket is account-scoped, not region-scoped.** State lives at
  `s3://cdkd-state-{accountId}/cdkd/{stackName}/{region}/state.json`; the
  bucket region is auto-detected via `GetBucketLocation`
  (`src/utils/aws-region-resolver.ts`). So a multi-region stack can still
  keep ONE state file at its home region; only a per-resource region field is
  needed in the record (see §3).
- **The delete path already threads a per-resource region.**
  `src/provisioning/region-check.ts` defines `DeleteContext.expectedRegion`
  (optional) + `assertRegionMatch`, already wired through CloudControl,
  DynamoDB, Cognito, EventBridge, SSM, RDS, S3Tables, etc. Its supply source
  is the stack's `state.region`. Per-resource region just generalizes the
  supply source from stack-level to resource-level, and flips the delete-time
  behavior from "assert match / refuse" to "route to that region".
- **Asset publishing already supports per-destination region.** Both
  `src/assets/file-asset-publisher.ts` and
  `src/assets/docker-asset-publisher.ts` read `dest.region` from the asset
  manifest and build an `S3Client` / `ECRClient` for that region. The Docker
  image build is region-independent (built once, then tagged + pushed to
  `{account}.dkr.ecr.{destRegion}.amazonaws.com/...`). So cross-region S3 and
  ECR publishing are symmetric and the machinery exists — ECR is NOT
  meaningfully harder than S3.
- **Cross-region output reads already work.** `Fn::GetStackOutput` accepts an
  explicit `Region` argument and reads the producer's state from the correct
  `(stackName, region)` key (`src/deployment/intrinsic-function-resolver.ts`).
- **Metadata is already parsed.** `src/analyzer/template-parser.ts` already
  reads `resource.Metadata` (today only for dependency extraction), so adding
  a `cdkd:region` reader is a localized change.

## 3. Design we converged on

- **Mechanism: CloudFormation `Metadata`.** A cdkd-provided CDK helper
  (an Aspect or a thin `cfnResource.addMetadata('cdkd:region', '<region>')`
  wrapper) stamps the region onto the resource. The analyzer builds a
  per-resource region map from `cdkd:region`. This stays valid CDK that
  `cdk synth` accepts (CDK is oblivious to the key); vanilla `cdk deploy`
  simply ignores it.
- **Client routing: `AwsClients` becomes a region-keyed pool.** Today
  `getAwsClients()` returns a process-global singleton with a single region,
  and `switchRegion()` (`src/cli/commands/deploy.ts`) mutates
  `process.env.AWS_REGION` per stack. That mutation is NOT safe for
  concurrent per-resource regions (the DAG executor runs a stack's resources
  in parallel). Replace it on the per-resource path with a pool keyed by
  region; `region === undefined` returns the existing default (= stack
  region), so existing behavior is byte-identical.
- **Provider signatures: optional region.** Add an optional region (mirroring
  the existing optional `DeleteContext.expectedRegion`) to
  `create` / `update` / `getAttribute`. Undefined ⇒ current behavior; set ⇒
  resolve the pooled client for that region. This makes the (otherwise large)
  provider-signature change purely additive and non-breaking. Prefer this
  explicit-context approach over `AsyncLocalStorage` — it is symmetric with
  the delete path and avoids hidden shared state.
- **State: add `ResourceState.region?` (schema v8 → v9).** Keep the state
  file at the stack's home region; tag each resource with its region.
  Requires transparent auto-migration and trips the `integ-schema-migration`
  markgate gate.
- **`cdkd export` guard.** Exporting a stack whose resources carry a
  `cdkd:region` differing from the stack region must refuse / warn — CFn
  cannot express per-resource regions, so export would silently relocate the
  resource. (Do not advertise "graceful degradation" as a feature; CFn
  silently misplacing a resource is a footgun, not a bonus.)
- **CDK-validity scope (the key constraint): valid-CDK-only.** cdkd only
  honors the annotation on code that still synthesizes cleanly under CDK.
  Where an L2 construct's own region validation would error (CloudFront
  viewer cert requiring ACM in `us-east-1`, Lambda@Edge,
  `DnsValidatedCertificate`), the user drops to L1 (`CfnDistribution` etc.) +
  metadata. cdkd never requires code that `cdk synth` rejects, and never
  forks / monkeypatches `aws-cdk-lib`. This keeps cdkd a strict superset at
  the synth boundary; the only divergence is deploy-time placement.
- **MVP staging.** Start with asset-free types (S3 / DynamoDB / SQS / SNS /
  IAM / SSM …) to prove the client-pool + state-region + metadata path, then
  add asset-bearing resources (the asset destination-region rewrite + the
  "each target region must be bootstrapped" precondition + resolving the
  `${AWS::Region}` placeholder in the bucket/repo name to the destination
  region).

## 4. Heavyweight merge ceremony (why each PR is expensive)

The change touches the most cross-cutting code, so it trips multiple markgate
gates per PR: `integ-broad` (deploy-engine / register-providers /
template-parser), `integ-destroy` (provider `delete()` paths),
`integ-schema-migration` (the v8 → v9 bump), plus `verify-pr`. This is a
multi-PR effort where every PR is real-AWS-integ-gated.

## 5. CDK-compatible multi-region already exists in cdkd

CDK's own answer to multi-region is **multiple stacks** (one per region,
wired via cross-region references or Stages). cdkd already supports this:
per-stack region (`stackInfo.region`) plus cross-region `Fn::GetStackOutput`.
So the CDK-compatible multi-region story already works today as N stacks. The
proposed feature's only delta is the **single-stack packaging** — which is
exactly the part that is NOT expressible in CDK.

## 6. Why shelved

cdkd's positioning is dev/test companion to CDK-in-production. The feature
requires an authoring style (one stack with cross-region CF + ACM + WAF) that
**fails `cdk synth` in production**. A user would therefore maintain two
different stack shapes (or branch), meaning the cdkd dev environment no longer
mirrors the CDK prod template — which defeats the core value of a dev/test
tool (fidelity to prod).

Net: the feature is ergonomic sugar (cram an already-supported multi-stack
multi-region setup into a single stack) that only serves **cdkd-only** users
(those who never touch CFn/CDK — i.e. throwaway/ephemeral validation
environments), at the cost of (a) prod fidelity and (b) heavyweight
cross-cutting changes. The addressable audience is narrow and partly in
tension with cdkd's stated "use CDK CLI for production" guidance. The juice
does not justify the squeeze right now.

## 7. Reopen conditions

Revisit this design (which is complete and ready to implement as §3) if
either holds:

1. **Positioning shifts** — cdkd moves from "CDK dev/test companion" toward a
   standalone deploy tool. Then single-stack multi-region becomes a genuine
   differentiator and the prod-fidelity objection no longer applies.
2. **Demonstrated demand** — issues / users explicitly asking for cdkd-only
   single-stack multi-region.

If reopened, the §3 design stands on its own; no further spike is needed
except a time-box on the asset destination-region rewrite for asset-bearing
resources (the one part not already proven by existing code).
