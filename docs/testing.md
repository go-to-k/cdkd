# How to Test cdkd

## Prerequisites

1. AWS Account
2. AWS CLI configured (`aws configure`)
3. Node.js 20 or higher
4. cdkd built (`vp run build`)

## 1. Create Test S3 Bucket

cdkd uses an S3 bucket for state management. You can easily create one using the `bootstrap` command:

### Method A: Using bootstrap command (Recommended)

```bash
# Set cdkd path (auto-resolves to the cdkd repo root when run from inside it;
# otherwise replace with an absolute path to your local cdkd checkout)
CDKD_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Bucket name must be globally unique
export STATE_BUCKET="cdkd-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # Change to your preferred region

# Create bucket with bootstrap command
node ${CDKD_PATH}/dist/cli.js bootstrap \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

echo "State bucket created: ${STATE_BUCKET}"
```

### Method B: Using AWS CLI (Traditional method)

```bash
# Bucket name must be globally unique
export STATE_BUCKET="cdkd-state-$(whoami)-$(date +%s)"
export AWS_REGION="us-east-1"  # Change to your preferred region

# Create S3 bucket
aws s3 mb s3://${STATE_BUCKET} --region ${AWS_REGION}

echo "State bucket created: ${STATE_BUCKET}"
```

## 2. Prepare Test CDK Application

cdkd provides multiple test examples:

### Option A: Use Existing Examples (Recommended)

The cdkd repository includes several examples:

#### Basic Example (Simple S3 Bucket)

```bash
cd "${CDKD_PATH}/tests/integration/basic"
vp install
```

#### Intrinsic Functions Example (Testing Built-in Functions)

```bash
cd "${CDKD_PATH}/tests/integration/intrinsic-functions"
vp install
```

#### Intrinsics Torture Example (Stress-testing the intrinsic resolver)

A real-AWS regression net for cdkd's hand-rolled intrinsic-function resolver
(`src/deployment/intrinsic-function-resolver.ts`) that goes beyond the basic
`intrinsic-functions` fixture (Ref / GetAtt / Join / Sub). Each harder
intrinsic — `Fn::Cidr`, `Fn::FindInMap`, `Fn::GetAZs` + `Fn::Select`,
`Fn::Base64`, nested `Fn::Split`/`Fn::Select`/`Fn::Join`, deeply-nested
two-arg `Fn::Sub`, and ALL pseudo-parameters — computes an `AWS::SSM::Parameter`
Value that `verify.sh` reads back from AWS and asserts against an
independently-computed expected value, so a wrong resolution pinpoints the
offending intrinsic.

```bash
cd "${CDKD_PATH}/tests/integration/intrinsics-torture"
vp install
STATE_BUCKET="your-cdkd-state-bucket" AWS_REGION="us-east-1" bash verify.sh
```

#### Lambda Example (Lambda + DynamoDB + IAM) ✅ Recommended

A practical integration example with Lambda functions and DynamoDB tables:

```bash
cd "${CDKD_PATH}/tests/integration/lambda"
vp install
```

**Tested features**:

- Lambda asset publishing (code upload to S3)
- ARN resolution via Fn::GetAtt
- Ref resolution in environment variables
- Automatic IAM Role/Policy creation

#### Multi-Resource Example (Complex example)

Event-driven architecture with S3 + Lambda + DynamoDB + SQS + IAM:

```bash
cd "${CDKD_PATH}/tests/integration/multi-resource"
vp install
```

#### Parameters Example (CloudFormation Parameters) ✅ Implemented

```bash
cd "${CDKD_PATH}/tests/integration/parameters"
vp install
```

**Tested features**:

- Parameter default values
- Type coercion (String, Number, List)
- Parameter usage in resource properties

#### Conditions Example (CloudFormation Conditions) ✅ Implemented

```bash
cd "${CDKD_PATH}/tests/integration/conditions"
vp install
```

**Tested features**:

- Condition evaluation (Fn::And, Fn::Or, Fn::Not, Fn::Equals)
- Conditional resource creation
- AWS::NoValue pseudo parameter

#### Cross-Stack References Example (Fn::ImportValue) ✅ Implemented

```bash
cd "${CDKD_PATH}/tests/integration/cross-stack-references"
vp install
```

**Tested features**:

- Stack outputs with Export
- Fn::ImportValue for cross-stack references
- S3 state backend for sharing exports between stacks

#### ECR Example (Docker Image Lambda with ECR)

```bash
cd "${CDKD_PATH}/tests/integration/ecr"
vp install
```

**Tested features**:

- Docker image Lambda functions
- ECR asset publishing

#### Docker Image Asset Example (deploy-time ECR build + push)

```bash
cd "${CDKD_PATH}/tests/integration/docker-image-asset"
vp install
```

**Tested features** (requires a running Docker daemon — the `verify.sh`
SKIPs gracefully when `docker info` fails):

- cdkd's deploy-time Docker ASSET pipeline (`DockerAssetPublisher`):
  `docker build` of the local Dockerfile, ECR auth, `docker push` to the
  CDK-managed container-assets repo during `cdkd deploy`
- `lambda.DockerImageFunction` (`PackageType=Image`) pointing at the pushed
  ECR image; the `verify.sh` invokes the function to prove the pushed image
  actually runs, then destroys and asserts the pushed image is gone from ECR
- Distinct from the `local-invoke-container` family (which only exercises the
  LOCAL emulation build path and never touches AWS)

#### API Gateway Example (REST API + Lambda)

```bash
cd "${CDKD_PATH}/tests/integration/apigateway"
vp install
```

**Tested features**:

- REST API with API Gateway
- Lambda integration

#### ECS Fargate Example

```bash
cd "${CDKD_PATH}/tests/integration/ecs-fargate"
vp install
```

#### EventBridge Example

```bash
cd "${CDKD_PATH}/tests/integration/eventbridge"
vp install
```

#### SNS + SQS Event Example

```bash
cd "${CDKD_PATH}/tests/integration/sns-sqs-event"
vp install
```

#### DynamoDB Streams Example

```bash
cd "${CDKD_PATH}/tests/integration/dynamodb-streams"
vp install
```

#### Step Functions Example

```bash
cd "${CDKD_PATH}/tests/integration/stepfunctions"
vp install
```

#### IAM Propagation Stress Example (race detector)

```bash
cd "${CDKD_PATH}/tests/integration/iam-propagation-stress"
vp install
```

**Tested behavior** — a race detector for IAM-propagation bugs on cdkd's fast
SDK path. cdkd creates an IAM role and has a service assume it within ~1s,
before IAM finishes propagating; CloudFormation tolerates this via deployment
latency, cdkd does not. The race is handled narrowly today (RDS #794, ECS
CapacityProvider #805, Custom Resource #756) but many consumers are
unprotected:

- Four brand-new IAM roles, each consumed IMMEDIATELY by a DIFFERENT service
  in ONE deploy: Lambda exec role -> `CreateFunction`; SFN role ->
  `CreateStateMachine`; EventBridge target role -> `PutTargets`; fresh
  principal -> `AWS::SQS::QueuePolicy` + `AWS::SNS::TopicPolicy`.
- **The pass condition is: deploy SUCCEEDS.** A failure is a real cdkd finding
  (an unprotected consumer racing IAM propagation); `verify.sh` prints which
  resource failed + the error for triage, then still cleans up.
- On success it asserts each role consumer works (invoke the Lambda, run an
  SFN execution to `SUCCEEDED`, confirm the rule's SFN target + role, confirm
  the queue/topic resource policies), then destroys clean.

#### EC2 VPC Example

```bash
cd "${CDKD_PATH}/tests/integration/ec2-vpc"
vp install
```

#### S3 + CloudFront Example

```bash
cd "${CDKD_PATH}/tests/integration/s3-cloudfront"
vp install
```

#### CloudWatch Example

```bash
cd "${CDKD_PATH}/tests/integration/cloudwatch"
vp install
```

#### RDS Aurora Example

```bash
cd "${CDKD_PATH}/tests/integration/rds-aurora"
vp install
```

#### Bedrock AgentCore Example

```bash
cd "${CDKD_PATH}/tests/integration/bedrock-agentcore"
vp install
```

#### CloudFront + Lambda Function URL Example

```bash
cd "${CDKD_PATH}/tests/integration/cloudfront-function-url"
vp install
```

**Tested features**:

- CloudFront distribution with Lambda Function URL origin
- Lambda FunctionUrl attribute enrichment (GetFunctionUrlConfig API)
- 6 resources: CREATE + DESTROY verified

#### VPC Lookup Example (Context Provider Loop)

```bash
cd "${CDKD_PATH}/tests/integration/vpc-lookup"
vp install
```

**Tested features**:

- Context provider loop (missing context → SDK resolution → cdk.context.json save → re-synthesis)
- `Vpc.fromLookup()` triggers VPC context provider
- Verifies `cdk.context.json` is generated with resolved VPC info
- Deploy uses the resolved VPC ID in SSM Parameter

```bash
# Synth (generates cdk.context.json on first run)
node ../../../dist/cli.js synth --region us-east-1

# Verify cdk.context.json was created
cat cdk.context.json

# Deploy
node ../../../dist/cli.js deploy --region us-east-1 --state-bucket <your-state-bucket>

# Destroy
node ../../../dist/cli.js destroy --region us-east-1 --state-bucket <your-state-bucket> --force
```

#### CDK Provider Framework Example (isCompleteHandler/onEventHandler)

```bash
cd "${CDKD_PATH}/tests/integration/custom-resource-provider"
vp install
```

**Tested features**:

- CDK Provider framework with isCompleteHandler/onEventHandler
- Async pattern detection and polling
- Pre-signed URL for cfn-response (2hr validity)
- A delete handler that RETURNS `Status: FAILED` (env-gated by
  `CDKD_TEST_UPDATE=cr-delete-fails`, issue
  [#2054](https://github.com/go-to-k/cdkd/issues/2054)): the destroy must exit 2,
  report the row as skipped, KEEP the state record and leave the handler's
  resource live -- a handler that says it did not delete must never be recorded
  as deleted. The arm cleans that resource up out of band, since cdkd
  deliberately will not.
- The synthetic `StackId` handed to the handler carries the REAL account and
  region (issue [#1866](https://github.com/go-to-k/cdkd/issues/1866)); the arm
  asserts the exact ARN and explicitly rejects the pre-fix fabricated pair.

This fixture runs through its own `verify.sh` (it was a `standard`-flow test
before the go-to-k/cdkd#2054 arm landed), so drive it with `/run-integ
custom-resource-provider` rather than by hand.

For details on each example, refer to the README.md in each directory.

### Option B: Create a New CDK Application

You can also create and test a simple CDK application:

```bash
# Create test directory
directory="/tmp/cdkd-test"
mkdir -p ${directory}
cd ${directory}

# Initialize CDK project
npx aws-cdk@latest init app --language typescript

# Change to a simple stack
cat > lib/cdkd-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class CdkdTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create a simple S3 bucket
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false, // Custom::S3AutoDeleteObjects is not supported
    });

    // Output bucket name to verify (supports CloudFormation intrinsic functions)
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Name of the test bucket',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'ARN of the test bucket',
    });
  }
}
EOF

# Build
vp run build
```

### Fixture convention: `verify.sh` signal traps

Every fixture that provisions real AWS resources arms a `cleanup` trap so a
failed run tears its resources down. That trap MUST be armed for the signal
paths as well, in the exiting form:

```bash
cleanup() { ... }             # destroy + state/orphan sweep
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM
```

Two forms are wrong and both let a run leak billable resources:

- **No `INT` / `TERM` handler.** Ctrl-C or a harness timeout terminates the
  script without running the `EXIT` trap, so the stack survives.
- **`trap cleanup EXIT INT TERM`** (the bare-function form). A bash signal
  handler *returns to the interrupted point* instead of exiting, so `cleanup`
  runs and the script then **resumes the interrupted phase**, walks into the
  next one and can `exit 0` — reporting PASS. Worse, when only the script PID
  is signalled the `node deploy` child survives, so `cleanup` deletes resources
  concurrently with a live deploy.

The `(exit N)` seed is load-bearing, not decoration. Many fixtures' `cleanup`
opens with `rc=$?` and gates the whole teardown on it:

```bash
cleanup() { rc=$?; if [ "${rc}" -eq 0 ]; then exit 0; fi; ...destroy...; }
```

Inside a signal handler `$?` is the **interrupted command's** status, not the
signal. Without the seed, an interrupted run can see `rc=0`, skip the teardown
entirely and exit 0 — reintroducing the very bug the signal trap was added to
prevent. `(exit N)` sets `$?` to the signal's code, so both `rc=$?` and
`${1:-$?}` cleanups tear down correctly.

A disarm must release the signal traps too — `trap - EXIT INT TERM`, not
`trap - EXIT` — otherwise a Ctrl-C after the fixture's own successful teardown
re-runs `cleanup`.

`tests/unit/scripts/integ-verify-signal-traps.test.ts` enforces this across the
whole fixture tree (issue #1097).

### Fixture convention: `verify.sh` gone-probes

A "resource is gone after destroy" assertion must never be built on a silenced
AWS CLI read probe. Both of these are the same bug (issue #1097 pattern 2):

```bash
# WRONG: ANY probe failure (throttle, expired credentials, network) lands in
# the else-branch and reports "gone" -- a leaked resource passes silently.
if aws lambda get-function --function-name "${FN}" >/dev/null 2>&1; then
  echo "FAIL: function still exists after destroy" >&2; exit 1
fi

# WRONG (inverse spelling): any failure is read as "gone".
if ! aws dynamodb describe-table --table-name "${TABLE}" >/dev/null 2>&1; then
  TABLE_GONE=1
fi
```

The list-operator spellings (`aws <probe> ... && { FAIL still exists; }` and
`aws <probe> ... || { GONE=1; break; }`) are the same bug and equally banned.

Instead, every fixture that asserts deletion carries the canonical helper block
(verbatim; see `scripts/check-integ-probe-not-found.ts` for the source of
truth) and routes probes through it:

```bash
# Simple leak assertion: fails on "still exists" AND on an undetermined probe.
assert_gone "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"

# Branching form (orphan counters, wait-until-gone polls, status checks):
# 0 = confirmed not-found, 1 = still exists, hard-FAIL on anything else.
if ! gone_probe aws iam get-role --role-name "${ROLE}"; then
  ORPHANS=$((ORPHANS + 1))
fi
```

The helpers grep the probe's stderr for the ONE canonical not-found signature
(`'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'`, case-insensitive)
and refuse to report PASS on any other failure. Notes:

- Only READ-verb probes (`describe|get|head|list|batch-get`, `aws s3 ls`) used
  as existence checks are in scope. A mutation such as
  `if ! aws fsx delete-backup ...` legitimately treats non-zero as "the delete
  failed" and stays as-is; so do fail-closed existence checks
  (`if ! aws ...; then FAIL`), pre-flight "already exists, clean up first"
  guards, and best-effort cleanup guards.
- Probe state files with `aws s3api head-object --bucket ... --key ...`, not
  `aws s3 ls`: `s3 ls` exits 1 with EMPTY output for "no keys", which is
  indistinguishable from a silenced error.

The same defect hides in two more spellings, both banned (issue #1120):

- **Capture-form fallbacks**: a read-verb command substitution with an
  error-swallowing fallback, e.g. `N=$(aws ... --output text 2>/dev/null ||
  echo 0)` or `... || true`, reads a throttle as "0 remaining" / "None" /
  empty. Drop the silencing and the fallback (a plain `VAR=$(aws ...)` under
  `set -e` hard-fails loudly on a probe error), or, when not-found is a
  legitimate outcome (async deletes, recovery-window secrets), branch on
  `gone_probe` first and then read the value with a strict capture. A plain
  silenced capture with no fallback and the strict stderr-capture idiom
  (`$(cmd 2>&1 >/dev/null || true)`, error text lands in the value for
  inspection) stay legal.
- **Function wrappers**: a function body carrying a silenced read probe whose
  error cannot fail loudly — the exit-status shape (`ssm_exists() { aws ssm
  get-parameter ... >/dev/null 2>&1; }`) or a value wrapper with a swallow
  tail (`... --output text 2>/dev/null || true`). Both make `$(fn)` /
  `if fn` read a throttle as "gone". Tail-less value wrappers are legal
  **only when the probe is the LAST command of the body**: `$(fn)` returns the
  last command's status, so `set -e` fails the caller loudly.

**Intermediate captures inside a value wrapper need `|| return 1`.** Bash
clears errexit inside `$( )` command substitutions (no
`shopt -s inherit_errexit`), so in a multi-statement wrapper called as
`V="$(fn)"` an intermediate `out="$(aws ...)"` failure does NOT abort the
body: the remaining statements run and the function returns the last
command's status (typically 0 via a `|| true` formatting tail), silently
reading a throttle as "nothing found":

```bash
find_ids() {
  local out
  out="$(aws ec2 describe-vpcs ... --output text)" || return 1  # load-bearing
  printf '%s\n' "${out}" | tr '\t' '\n' | grep -v '^$' || true
}
```

The `|| return 1` routes the probe error through the function's exit status to
the caller's `set -e`. (A `local V=$(aws ...)` declaration-assignment masks
the status entirely, since `local` exits 0, so split the declaration from the
assignment. A status-consuming tail like `out="$(aws ...)" && rc=0 || rc=$?`
is already strict.)

When a `gone_probe` branch precedes a strict value requery, guard the requery
against the probe-to-requery race (TOCTOU): on a requery failure whose stderr
matches the canonical not-found signature, treat it as gone; hard-fail on
anything else (`elif ! v=$(aws ... 2>&1); then printf '%s' "$v" | grep -qiE
'<canonical signature>' && v=GONE || { echo FAIL...; exit 1; }`).

Best-effort cleanup code is exempt structurally: lines inside a
`set +e`/`set +eu` ... `set -e`/`set -eu` span (bounded by the enclosing
function) are skipped, matching the cleanup convention above — mark a
best-effort cleanup helper with `set +eu` rather than silencing its probes.
Run the helper's body in a subshell (`fn() { ( set +eu; ... ) }`) so calling
it from a `set +eu` cleanup trap can never RE-ARM strict mode in the caller
(a trailing `set -eu` in a plain body would abort the rest of the sweep on
the next probe error).

`tests/unit/scripts/integ-verify-probe-not-found.test.ts` enforces all of this
across the whole fixture tree (issue #1097 pattern 2 + issue #1120), including
bash-level behavioral tests against a stubbed `aws` (helpers: success /
not-found / throttle; strict captures: value propagation vs loud throttle
failure).

### Fixture convention: `verify.sh` CLI flags

Every flag a fixture passes must be declared on the **subcommand it targets**.
The originating case: a fixture passed `--region` to `cdkd import`, which died
with `error: unknown option '--region'` — so the import round-trip that fixture
exists to exercise had never executed once. `--region` is declared in
`src/cli/options.ts` and accepted by roughly ten sibling commands (`deploy`,
`destroy`, `diff`, `drift`, `export`, `events`, `list`, `synth`, `orphan`, and
every `state` subcommand); `import` is the only one that never attaches it, so
the flag looked correct by analogy with its neighbours.

Two traps when auditing this by hand:

- **Hidden options do not appear in `--help`**, so help text alone is not
  decisive — the option set has to come from the command tree itself.
- **`--region` is not a no-op** on the commands that accept it. It is the
  highest-precedence region source (see [cli-reference.md](cli-reference.md)),
  so "cleaning up" deprecated `--region` flags would silently change region
  resolution.

`tests/unit/scripts/integ-cli-flags.test.ts` enforces this across the fixture
tree. It reads the real Commander tree through `buildProgram()`
(`src/cli/program.ts`) — not `--help`, and not `src/cli/options.ts`, which is a
flat global list with no command attachment and therefore cannot express this
class of bug at all. A flag counts as accepted when the target command **or any
ancestor** declares it, matching Commander's own lookup (`cdkd events prune
--state-bucket` is valid because `events` declares it).

The check also asserts coverage floors — total invocations parsed, flags seen,
distinct subcommands reached, plus at least one invocation of each supported
call shape — so a parser regression that stops matching fails loudly rather than
passing vacuously. That is not hypothetical: two separate iterations of this
lint were green while silently skipping most of the tree (first every
env-prefixed `CDKD_TEST_UPDATE=true ...` deploy, then every
`node "${LOCAL_DIST}" ...` call site — 135 of 195 fixtures). Current coverage:
195 fixtures, ~830 invocations, ~2,160 flags, 25 command paths.

### Fixture convention: no Lambda published-version literals

Lambda version counters are monotonic per function name (and per layer name)
and never reset — not even across a delete + re-create. A fixture with a fixed
function name that probes `"${FN}:1"` or asserts an alias's `FunctionVersion`
equals `"2"` therefore passes exactly once (the first run ever in the account)
and fails every re-run with `ResourceNotFoundException` while the deploy itself
is clean. Three fixtures shipped this trap before it was made mechanical
(issue #1324).

The correct shape reads the published version from the live alias and asserts
the rotation relatively:

```bash
V1="$(aws lambda get-alias --function-name "${FN}" --name live \
  --query 'FunctionVersion' --output text)"
case "${V1}" in ''|*[!0-9]*) echo "FAIL: non-numeric version" >&2; exit 1 ;; esac
# ... update deploy ...
EXPECTED=$((V1 + 1))
V2="$(aws lambda get-alias --function-name "${FN}" --name live \
  --query 'FunctionVersion' --output text)"
[ "${V2}" = "${EXPECTED}" ] || { echo "FAIL: expected ${EXPECTED}" >&2; exit 1; }
```

`tests/unit/scripts/integ-verify-version-literals.test.ts` enforces this across
the fixture tree (classifier: `scripts/check-integ-version-literals.ts`). It
flags digits-literal qualifiers on `aws lambda` commands (`--function-name
"${FN}:1"`, ARN `...:function:fn:3`, `--qualifier 5`), digits-literal
`--version-number` args, and integer-literal comparisons of variables captured
from a version-ish `--query` (`FunctionVersion`, `.Version`). Alias qualifiers
(`:live`, `:$LATEST`), variable qualifiers, relative compares, count queries
(`length(...)`), and non-Lambda commands stay legal. For a genuinely fixed
version (e.g. a public cross-account layer ARN pinned by its owner), append
`# allow-version-literal: <reason>` to the line. The check carries per-shape
coverage floors and was verified to fail against real injected regressions
before landing, per the checker rules above.

### Fixture convention: a mode-gated resource must survive the later steps

Multi-step fixtures drive each phase with
`CDKD_TEST_UPDATE=<comma,separated,modes>`, and the fixture stack branches on
`updateMode.includes('x')`. Adding a scenario by gating a **new resource** on a
**new token** is the natural spelling, and it is wrong whenever a later deploy
in the same `verify.sh` uses a mode list that omits the token: the resource
leaves the synthesized template and cdkd correctly issues a DELETE for it. A
per-step conditional in a long fixture is really a *step function over the whole
run*, not a flag scoped to your step.

The originating case (issue #1512), caught by review before the run reached it:
the new `OnDemandReplicaTable` gated its `eu-west-1` replica on
`cross-region-ondemand*`, used by steps 12g/h/i. The fixture then deploys six
more times (`deletion-protection,autoscaling,ttl,tags`, then five `ttl,tags,...`
rounds), none carrying the token — so step 12f would have removed the replica
**from a still-live table**. That is precisely the operation that arms
DynamoDB's 24-hour source-region delete lock; an earlier probe wedged a table in
`UPDATING` for over 90 minutes that way (#1442). The fixture's own comments, the
commit message and the issue comment had already claimed the design "only ever
ADDs" — nothing would have contradicted them.

Make the token **monotonic** by carrying it forward in a shell suffix: set the
variable once the resource exists, and append it to the mode list of every later
deploy.

```bash
OD_MODE_SUFFIX=""                               # seeded with the other run vars
...
OD_MODE_SUFFIX=",cross-region-ondemand-dropped" # set right after the rounds
...
CDKD_TEST_UPDATE=ttl,tags${OD_MODE_SUFFIX} ${CLI} deploy ...
```

The suffix stays empty when the scenario is not gated on, so the default flow is
byte-for-byte unchanged. Only `cdkd destroy` then removes the resource — which
for a GlobalTable deletes every replica as one resource and never issues a
standalone replica-delete.

Do **not** instead key presence on a run-scoped environment variable. It is the
tempting one-line fix and it stops the deletion, but it silently changes what
the test tests: the resource is then declared from step 1, so it is created
*with* its parent and the step you meant to exercise becomes an UPDATE. That is
how this very fixture briefly stopped covering `addReplica` while its assertion
still passed — the assertion only checks the resulting value. Reserve the
env-var form for presence that no step needs to transition.

Before adding a mode-gated resource, enumerate every deploy and read the mode
list of each one that runs **after** your steps; any that omits your token
deletes your resource there. Grep for the invocation rather than for a
single-line pattern — fixtures wrap long mode lists with a trailing `\`, so the
env prefix and `${CLI} deploy` land on different lines and a one-line
`grep 'CDKD_TEST_UPDATE=.*deploy'` misses them. That gap is what let a run
report PASS while still performing the live replica-delete.

Then weigh what the deletion costs — free for a plain queue, the whole problem
for a DynamoDB replica, RDS instance or stateful store. Verify by synthesizing
the **later** modes: the check that catches this is `cdk synth` under `ttl,tags`
showing the resource still intact, not `cdk synth` under your own mode showing
it created. Finally, make sure some assertion would *notice* a drop — a
post-destroy "it is gone" check passes vacuously when the resource was deleted
mid-run, so it is not a guard.

Mechanically enforced since issue
[#1543](https://github.com/go-to-k/cdkd/issues/1543). Unlike the
order-insensitivity convention above, this one is a genuine checker rather than
a judgment call — the ordered mode lists and the token-gated declarations are
both statically extractable.

`scripts/check-integ-mode-gated-resources.ts` reads the ordered per-deploy mode
lists out of `verify.sh` (resolving the monotonic-suffix `${VAR}` idiom above in
source order) plus the condition behind each gated declaration in the fixture
stack, and reports any declaration that is present at one step and absent at a
later one. Only create-shaped gates block — a construct, or an entry in a
resource list such as `replicas: [...]`; a scalar property gate is reported for
visibility only, since flipping a property back off is an ordinary update test.
A deliberate removal is marked on the declaration with
`// allow-mode-gated-drop: <reason>`; the reason is mandatory.

### Fixture convention: stateful L2 constructs need an explicit removalPolicy

Stateful CDK L2 constructs — `kinesis.Stream`, `dynamodb.Table` / `TableV2`,
`s3.Bucket`, `logs.LogGroup`, `kms.Key`, `rds.DatabaseInstance` /
`DatabaseCluster`, `efs.FileSystem`, `opensearchservice.Domain`,
`ecr.Repository`, `cognito.UserPool`, `backup.BackupVault` — default to
`RemovalPolicy.RETAIN`, which synthesizes `DeletionPolicy: Retain`. Both
CloudFormation and cdkd honor it, so a fixture that omits the policy leaks the
resource on **every** deploy/destroy cycle while the destroy still reports
success. The originating incident (issue #1326): the `sqs-cloudwatch` fixture's
Kinesis Stream carried no `removalPolicy`, and a month of benchmark runs in
`us-west-2` accumulated 14 billed PROVISIONED streams before a cleanup sweep
caught them. The lint then immediately found a second live case — the
`log-pipeline` fixture's Stream, present since the initial commit.

Every instantiation of those constructs under `tests/integration/*/{lib,bin}`
must do one of:

- pass an explicit `removalPolicy` in its props (an intentional `RETAIN` is
  fine — it has to be a visible decision, not a silent default);
- call `applyRemovalPolicy(...)` on the assigned variable / property elsewhere
  in the same file;
- carry an `// allow-default-removal-policy: <reason>` comment on the
  statement, for fixtures that intentionally exercise the default (the test
  caps how many of these may exist, so the escape hatch stays rare).

A props object passed as a same-file variable is resolved through the variable;
a spread (`{ ...base }`) does **not** count — restate the policy visibly. L1
`Cfn*` constructs are out of scope because their template default is `Delete`.

`tests/unit/scripts/integ-fixture-removal-policy.test.ts` enforces this across
the fixture tree (classifier: `scripts/check-fixture-removal-policy.ts`), with
coverage floors per constructor-reference shape and per construct kind so a
parser regression fails loudly rather than passing vacuously. Baseline
2026-07-31: 523 fixture files scanned, 120 stateful-L2 instantiations.

### Fixture convention: a `PendingDeletion` KMS key is not an orphan

A customer-managed KMS key cannot be deleted synchronously. Seven days is the
AWS **minimum** pending window, and `RemovalPolicy.DESTROY` schedules the
deletion rather than performing it — so `PendingDeletion` is the terminal state
of a *successfully deleted* key, not a leak.

A fixture that needs a CMK may therefore just create one per run:

```ts
const key = new kms.Key(this, 'Key', {
  description: 'cdkd <what this covers> integ',
  removalPolicy: cdk.RemovalPolicy.DESTROY,
  pendingWindow: cdk.Duration.days(7), // the minimum; the default is 30
});
```

and assert the state after destroy, accepting `GONE` for a window that already
elapsed in an earlier run:

```bash
KEY_STATE="$(aws kms describe-key --key-id "${KEY_ARN}" --region "${REGION}" \
  --query 'KeyMetadata.KeyState' --output text 2>&1)" || {
  if echo "${KEY_STATE}" | grep -q "NotFoundException"; then
    KEY_STATE="GONE"
  else
    echo "FAIL: describe-key failed unexpectedly: ${KEY_STATE}" >&2
    exit 1
  fi
}
[ "${KEY_STATE}" = "PendingDeletion" ] || [ "${KEY_STATE}" = "GONE" ] || {
  echo "FAIL: expected PendingDeletion after destroy, got '${KEY_STATE}'" >&2
  exit 1
}
```

`loggroup-kms-associate`, `propagation-races-2` and `s3-vectors` have done this
since issue #958; `cloudtrail-trail` and `s3-replication-and-filter` joined them
in issues #1533 / #1523. Do **not** build a long-lived, alias-referenced key and
an account-bootstrap step to avoid the pending window — that makes every
affected fixture fail on a fresh account in order to dodge a non-problem.

Two caveats. The key does keep **billing** through its pending window; that is
a cost, not an orphan, and is not a reason to skip coverage. And the `/cleanup`
sweep's caution still applies to keys it did not create: only ever schedule
deletion for `KeyManager == CUSTOMER` + `KeyState == Enabled` keys with a
cdkd-shaped description, never one carrying live grants or aliases.

### Fixture convention: never call an `aws` verb the CLI does not have

A `verify.sh` must not call an `aws <service> <verb>` that is not a real AWS
CLI subcommand. The trap is that such a verb can look completely legitimate:
the AWS CLI **removes** a set of operations from its command table
(`awscli/customizations/removals.py`) that still exist in the API, so the AWS
SDKs, the API reference, and anything generated from them all offer it.

The originating case (2026-08-09) is `aws emr list-instance-groups`, which
forced two EMR fixtures to be rewritten. Its symptom was misleading:

```text
Warning: Input is not a terminal (fd=0).
aws: [ERROR]: [Errno 22] Invalid argument
```

and, without a `</dev/null`, a hang. That reads like an interactive
"customization", and it was originally written up that way — but the real cause
is simpler and more general:

1. `list-instance-groups` is on the CLI's removal list, so the CLI's answer is
   just `Found invalid choice 'list-instance-groups'`.
2. The `Errno 22` / hang is what `cli_auto_prompt` (`on-partial` in the
   maintainer's `~/.aws/config`) does to **any** invalid-choice error: the CLI
   tries to open its interactive prompter, which cannot attach to a
   non-terminal stdin. With `AWS_CLI_AUTO_PROMPT=off` the same call fails fast
   and legibly.

The corollary matters when picking a replacement verb: **the neighbours are
usually fine.** `aws emr list-instance-fleets` and `aws emr list-instances` are
NOT removed and work non-interactively, so "the `list-instance-*` family is
suspect" was the wrong generalization. The unit of the defect is the
(service, verb) pair.

Enforced by `tests/unit/scripts/integ-aws-commands.test.ts` (classifier:
`scripts/check-integ-aws-commands.ts`), which checks every `aws <service>
<verb>` in the fixture tree against the captured removal table
`tests/fixtures/aws-cli-removed-commands.json`. The table is a checked-in
capture rather than a live `aws` invocation so the check stays offline and
deterministic — a checker that skips when its oracle is missing is a vacuous
pass. Refresh it with `vp run gen:aws-cli-removals` after an AWS CLI upgrade.
Escape hatch (only when you have PROVEN the call works):
`# allow-unavailable-aws-command: <reason>` on the invocation's line or the
line above.

When the verb you wanted is unavailable, call the AWS SDK directly from
`verify.sh` rather than substituting a different CLI verb that happens to work
but returns less data. The repo root already depends on every
`@aws-sdk/client-*` cdkd uses, so a `node --input-type=module -e` one-liner run
from the repo root needs no extra install. Two details in the reference shape
are load-bearing: a `|| return 1` so an SDK failure reaches the caller's
`set -e` (otherwise an empty result silently satisfies a `// empty`-defaulted
`jq` assertion), and a pagination loop matching whatever the provider under
test does (a partial first page is a silent false pass). See
`tests/integration/emr-cluster/verify.sh` and
`tests/integration/emr-instance-configs/verify.sh` for the full helper.

A pager invoked non-interactively is a separate route to a hang, so
`export AWS_PAGER=""` near the top of a fixture is cheap insurance. Treat this
as a recommendation for new and affected fixtures rather than a tree-wide
invariant — most existing fixtures do not set it and are fine.
`tests/integration/emr-instance-configs/verify.sh` is the reference.

### Fixture convention: pin and resolve a fixture-local `cdk` CLI

A fixture whose `verify.sh` shells out to the upstream `cdk` CLI must be
hermetic about which `cdk` it gets. Four requirements (enforced by
`tests/unit/scripts/integ-cdk-cli-pins.test.ts`, classifier
`scripts/check-integ-cdk-cli-pins.ts`):

1. Pin `aws-cdk` in the fixture's `package.json` at a real version range
   whose cloud-assembly schema support covers the fixture's `aws-cdk-lib`
   (`*` / `latest` are rejected — they re-admit the skew).
2. Install the **fixture's own** deps. `node_modules` is gitignored and the
   repo-root `pnpm install` does not populate fixture dirs, so a root install
   alone leaves the pin inert.
3. Guard a conditional install on the cdk **binary**, not on the directory: a
   `node_modules` left from before the pin exists but contains no `cdk`, so
   `[ -d node_modules ]` skips the very install that would fix it. An
   unconditional install needs no guard.
4. Resolve the local CLI on every invocation, by PATH prepend or an explicit
   local bin path:

   ```bash
   [ -x "${TEST_DIR}/node_modules/.bin/cdk" ] || (cd "${TEST_DIR}" && npm install)
   export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
   ```

Why: a bare `cdk deploy` (or `npx cdk` with no local install) silently takes
the machine's global CLI. When that CLI lags the fixture's `aws-cdk-lib`, the
run fails with `Cloud assembly schema version mismatch` — which is how
`import-nested-stack` failed on the 2026-08-10 staleness sweep even though its
`package.json` pinned `aws-cdk` (the pin was never on the resolution path).

The check reads code, never prose: heredoc bodies and comments (including
trailing ones) are stripped, and each line is split quote-aware into
command-position segments, so a `cdk deploy` inside an `echo` string or a
`grep` pattern is not an invocation — and equally, an `npm install` mentioned
in a comment does not satisfy requirement 2.

### Fixture convention: sort both sides of a list readback

AWS does not preserve the submitted order of list-valued members when you read
them back, so an assertion that string-compares a joined list against the order
you sent is flaky — and because it fails on a correct implementation, its error
message accuses the fix. Seen 2026-08-09 in the `lambda-esm-self-managed-kafka`
fixture: cdkd submitted two Kafka bootstrap servers in one order,
`list-event-source-mappings` returned them in the other, and the run reported
"issue #1384 NOT closed" while the fix was working.

Sort both sides in the query, unless the list is genuinely order-significant:

```bash
--query "join(' ', sort(Path.To.List || `[]`))"
```

This mirrors what `src/analyzer/drift-normalize.ts` does for the drift
comparator — it canonicalizes tag lists and resource-id/ARN arrays on both
sides for the same reason. The same caveat applies too: a list whose order
carries meaning (DNS resolver lists, preference orders) must NOT be sorted,
because sorting would hide a real regression rather than reveal one.

### Fixture convention: `state destroy` must pass `--state-bucket`

The harness exports the state bucket as `STATE_BUCKET`, but the CLI's own
environment fallback is `CDKD_STATE_BUCKET` — a **different** name. So a
`cleanup()` sweep spelled

```bash
node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes
```

never reads the harness's bucket at all. Resolution is CLI flag >
`CDKD_STATE_BUCKET` > `cdk.json` `context.cdkd.stateBucket` > STS-derived
default, so the omission lands in one of two wrong places:

- **109 fixture `cdk.json` files declare `context.cdkd.stateBucket`**, and
  `verify.sh` runs the CLI from the fixture directory — so the sweep resolved
  that name (`your-cdkd-state-bucket`, `cdkd-state-test`) and died with
  `StateError: State bucket '...' does not exist`, swallowed by the call's own
  `>/dev/null 2>&1`. Those cleanups had been failing on **every run**,
  invisibly.
- **The rest** fell through to the STS default `cdkd-state-{accountId}`, which
  is the harness bucket on a default setup — so they worked by coincidence.
  Point `STATE_BUCKET` anywhere else (a per-run isolated bucket, a
  second-account run, the legacy region-suffixed bucket) and the sweep silently
  no-ops: destroys nothing, reports success, and only the fixture's own
  tag-based AWS sweeps clean up.

Either way the state record survives and wedges the next run of that fixture.

Pass the bucket explicitly, in the `set -u`-safe form:

```bash
node "${LOCAL_DIST}" state destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
```

`"${STATE_BUCKET:-}"` rather than `"${STATE_BUCKET}"` is load-bearing: `cleanup`
is trap-installed, so it can run **before** the script's own
`if [ -z "${STATE_BUCKET:-}" ]` guard has rejected an unset variable, and a
cleanup that only does `set +e` (not `set +eu`) would abort teardown mid-sweep
on the unguarded form. An empty value is safe — the resolver treats `''` as "not
supplied" and falls back exactly as omitting the flag does, so the guarded form
is never worse than the status quo.

Note the asymmetry this convention corrects: `deploy` (335 call sites) and
`destroy` (228) already passed the flag everywhere; only `state destroy` had
drifted, at 96 of 171 call sites across 94 fixtures. `deploy` deliberately keeps
the strict `"${STATE_BUCKET}"` form — there an unset bucket is a harness
misconfiguration that should fail loudly rather than silently target the default.

Enforced by `tests/unit/scripts/integ-state-bucket.test.ts` (classifier:
`scripts/check-integ-state-bucket.ts`), which evaluates code only — heredoc
bodies, comments and `echo` arguments are stripped, so a remediation hint that
prints the command is not treated as an invocation.

### Fixture convention: sweep S3 OBJECT VERSIONS, and assert the count is zero

`cdkd bootstrap` turns **versioning on** for the state bucket
(`src/cli/commands/bootstrap.ts`). On a versioned bucket `aws s3 rm` writes a
DELETE MARKER; it removes nothing. So this, which most fixtures end with,

```bash
assert_gone "state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
```

is a statement about the CURRENT object only. Every earlier version of that key
is still readable by anyone with `s3:GetObjectVersion`.

For most fixtures that is litter. For a fixture that puts a **known secret
plaintext** into state it is a disclosure that outlives the run — and several
do, for good reasons: an `unsafePlainText` secret in the fixture's own template,
a literal `masterUserPassword`, an IAM `SecretAccessKey` cached in `attributes`,
or a deliberately seeded pre-GHSA record. Measured 2026-08-20 for issue
[#2096](https://github.com/go-to-k/cdkd/issues/2096), right after green runs:

| key | surviving entries | carrying the fixture's plaintext |
| --- | --- | --- |
| `cdkd/CdkdSecretsDynamicRefExample/us-east-1/state.json` | 304 versions + 43 markers | yes (`cdkd-known-pw-123`) |
| `cdkd/CdkdSecretsArrayNestedExample/us-east-1/state.json` | 7 versions + 3 markers | 5 of the 7 (`cdkd-array-nested-pw-789`) |
| `cdkd/CdkdDocdbNeptuneExample/us-east-1/state.json` | 64 | 16 of them (`TempPass1234!`) |
| `cdkd/CdkdEventbridgeApiDestinationExample/us-east-1/state.json` | 18 | 15 of them (`cdkd-integ-api-key`) |
| `cdkd/CognitoResourceServerStack/us-east-1/state.json` | 18 | 3 of them (a live Cognito `ClientSecret`) |
| `cdkd/AppSyncStack/us-east-1/state.json` | 557 | 17 of versions 12..45 (a live `da2-…` AppSync key) |
| `cdkd/CdkdApigwUsagePlanKeyExample/us-east-1/state.json` | 16 | 2 of them (a live 40-char API Gateway key `Value`) |

Twelve fixtures do this today.

**When measuring a key, sample across the RANGE or grep the whole thing — never
the newest N.** The last two rows were each cleared as "no key material" by a
newest-N probe before being caught: AppSync's 12 newest versions carry nothing
while versions 12..45 do, and the API Gateway key sits in versions 7 and 8 of
16. The newest versions come from the most recent run, which is the one most
likely to be already-fixed or to have failed early — so a newest-N sample is
biased towards exactly the answer you do not want.

It is also not enough to grep `src/provisioning/providers/**` for a credential.
`AWS::ApiGateway::ApiKey` is registered to no provider, so it takes the generic
Cloud Control readback, whose resource model includes `Value`: the live key
lands in `attributes` with no provider code naming it. Note the third row's stack name: it is
`CognitoResourceServerStack`, **not** `CdkdCognitoResourceServerExample`. Read
the stack name from `verify.sh`'s `STACK=` line when auditing — several fixtures
do not follow the `Cdkd…Example` convention, and probing the convention-derived
name returns a clean-looking `0` for a key that does not exist.

Use the shared helpers in
[`tests/integration/s3-versions.sh`](../tests/integration/s3-versions.sh)
rather than open-coding a sweep — the three traps below are written down there
once instead of once per fixture. Source it after the `cd` into the fixture dir:

```bash
cd "$(dirname "$0")"
. ../s3-versions.sh
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
```

**Sweep the PREFIX, never a list of keys.** Sweeping `state.json` by name is the
natural first instinct and it under-sweeps, because the plaintext is not only
there. `rollback-journal.json` stores
`failedOperations[].attemptedProperties` — the properties of the failed write,
verbatim — and four measured versions of
`CdkdDeletionPolicySnapshotHeavyExample`'s journal carried a literal
`"MasterUserPassword"`. `lock.json` accumulates faster than anything else (452
versions on one key), and `deployments/**` is not delete-markered by
`cdkd destroy` at all, so its objects survive as CURRENT ones. One prefix covers
all four; a key list covers whichever ones its author thought of.

One blind spot to know: a nested-stack child lives at
`cdkd/<Parent>~<Child>/<region>/`, a SIBLING prefix rather than a descendant, so
this does not reach it. No fixture in the swept set has one today.

In `cleanup`, purge NONCURRENT versions only — that function also runs from the
pre-run sweep and from the failure / INT / TERM traps, where a live `state.json`
may be the only record of resources that are still standing:

```bash
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
```

On the SUCCESS path, do the full sweep and **assert**:

```bash
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "<fixture> state teardown"
```

Three traps make a sweep silently PARTIAL while the run still exits 0. Each was
observed live, and none is visible from reading the script:

1. **Sweeping only from the EXIT trap.** A fixture that ends with
   `trap - EXIT INT TERM` disarms the trap on the success path, so a trap-only
   sweep runs on the failure path and never on the normal one. One key reached
   30 versions that way (2026-08-19). Sweep on the success path too.
2. **Iterating with `printf '%s' | tr | while read`.** `out=$(aws ...)` strips
   the trailing newline, so the last field has no terminator, `read` returns
   non-zero on it, and the loop body never runs for it. Verified against real
   S3: on a key holding one version the broken form swept 0 of 1; on a
   347-entry listing it swept 346. Repeated passes take a key to 1 and stop.
   Use `printf '%s\n'` plus a `|| [ -n "${key}" ]` guard — both.
3. **Counting with `length(...)` under `--output text`.** The AWS CLI applies
   `--query` PER PAGE and concatenates, so a listing over 1000 entries prints
   one number per page — measured `1000\n189`, not `1189` — and `[ "$n" -ne 0 ]`
   on that is a bash error, not a count. Count ROWS of a `[Key,VersionId]`
   projection instead; the pages concatenate into one row stream.

Two more details the helpers encode. The query is
`([Versions, DeleteMarkers][])[...]` and the **parentheses are load-bearing**:
`[Versions, DeleteMarkers][][?...]` returns empty because the flatten projection
swallows the filter (measured: 0 where the parenthesised form reported 347).
And the teardown sweep must NOT be `noncurrent` — after `aws s3 rm` the delete
marker is the entry carrying `IsLatest == true`, so a noncurrent-only sweep
leaves one marker per key behind forever and the zero-assertion never passes.

**Every entry point refuses a prefix that is not `cdkd/<stack>/<region>/` with
both segments non-empty** — the purge, the count, and the assertion alike. That
is a safety guard, not style, and it is needed on the READ side for a reason
that is easy to miss: `cdkd///` names no stack, so S3 lists nothing for it and
the count is a truthful `0` **about the wrong key space**. Combined with every
caller wrapping the purge in `|| true`, a mis-derived `STATE_PREFIX` would print
a refusal to stderr and let the fixture exit 0 with the plaintext intact — the
same vacuous green the whole convention exists to remove, one level up. On the
purge side the guard also stops an unset `STACK` (recall `cleanup` runs under
`set +eu`) from widening the prefix and deleting another stack's LIVE state.

Deletes go through `DeleteObjects` in batches of 1000, the API maximum, so a
347-version key costs one CLI process rather than 347. A key or version id
carrying a quote or a backslash falls back to a single-object `delete-object`,
because the payload is assembled without `jq` — sourcing this file must not add
a `jq` dependency to twelve fixtures. `Quiet: true` means a fully successful call
returns `{}`, so any `Errors` in the output is a per-object failure that the
call reported as overall success; it is surfaced as a WARN and the retry loop
plus the zero-assertion are the backstop. The call pins `--output json`, which
is load-bearing rather than tidy: the CLI's format is ambient
(`AWS_DEFAULT_OUTPUT`, or `output =` in the active profile), and under `text` /
`yaml` that same failure arrives as `ERRORS<TAB>…` / `Errors:`, the check never
matches, and the WARN is swallowed. On the success path the zero-assertion would
still catch the under-sweep; from `cleanup`, which purges `noncurrent` and
asserts nothing, it would not. Neither reader may inherit a format it does not
parse — which is why the listing pins `--output text` for the same reason.

Note also that the listing keeps **stderr out of the row stream**: a `2>&1`
there turns any benign CLI warning into a phantom surviving version, so an empty
bucket counts 1 and the assertion fails for no reason — and on the delete side
that warning text would be handed to `delete-object --key`.

Two lints see the helper. `tests/unit/scripts/integ-verify-bash-compat.test.ts`
scans the shared helpers in `tests/integration/*.sh` alongside every `verify.sh`
— a bash-4-ism in a file twelve fixtures source is where it does the most damage
and is least likely to be noticed. `scripts/check-integ-aws-commands.ts` scans
them too, since a verb removed from the AWS CLI here breaks twelve fixtures at
once. Both carry a per-shape floor, so a total swamped by 280 fixtures cannot
hide the helper going unread. `tests/unit/scripts/integ-s3-versions-helper.test.ts`
executes the guard directly, asserting a malformed prefix can never produce a
pass and that no AWS call is even attempted for one.

`tests/unit/scripts/integ-secret-fixture-sweep.test.ts` enforces the convention
itself: a fixture whose `bin/**` or `lib/**` TypeScript declares secret material
— `unsafePlainText`, a hand-supplied `secretStringValue` / `secretObjectValue`,
a templated `masterUserPassword`, `generateSecret: true`, or an
`iam.AccessKey` — must source the helper AND call `s3_assert_versions_swept`.
Both predicates read comment-stripped CODE: an early cut matched the explanatory
comment, so deleting the `source` line still read as compliant.

It exists because a hand audit is not enough, and that is measured rather than
assumed: the #2096 audit read every fixture's `verify.sh` and still missed
`docdb-neptune`, `eventbridge-api-destination` and `cognito-resource-server` —
each the structural twin of one it did find — because the secret is declared in
`lib/*.ts`, where that audit never looked.

The lint names what it cannot see, and so should you: raw CloudFormation
fixtures whose template is a checked-in `.json` / `.yaml`; secrets seeded by the
SCRIPT rather than the app (`dynamic-ref-cross-region` writes a plaintext state
record with `aws s3 cp`); and service-generated credentials with no marker in
the source at all — Cognito's `ClientSecret` was that class and was found by
grepping the BUCKET, not the source. The per-fixture zero-assertion plus
periodic bucket inspection remain the backstop.

### Unit-test convention: prime exactly what the code path consumes

`vi.clearAllMocks()` clears call RECORDS but does **not** drain the queue seeded
by `mockResolvedValueOnce` and its siblings. So a test that primes more
responses than its code path consumes leaves the remainder queued, and a later
test in the same file receives that leftover as one of its own responses — with
every later call shifted by the same offset.

The shifted test does not error. It reads a response describing a different
resource, takes a different branch, and then satisfies its own assertions,
because the assertions on that branch are usually ABSENCE assertions
(`toBeUndefined()`, `toHaveLength(0)`, `not.toHaveBeenCalled()`) and an absence
assertion is satisfied both by "the guard correctly declined" and by "the code
never got there". In issue #1588 the only symptom was a `logger.warn` that was
mysteriously never called, and locating it took a full instrumentation pass.

A runtime detector catches this (issue #1618). It is **off by default** so the
ordinary `vp run test` is unaffected; the CI job `once-leak-detect` runs the
suite a second time with it armed:

```bash
vp run test:once-leak        # the unit suite with the detector armed
```

What it flags is precisely a value **consumed by a different test than the one
that primed it**. The failure lands on the test whose result is corrupt, and
names the earlier test that primed the stale value:

```text
This test consumed a mock response primed by an EARLIER test.

  - primed by: over-primes and clearAllMocks does not drain it
  - mock: vi.fn()
```

Fix the EARLIER test: prime exactly what its code path consumes. If the extra
priming is deliberate, drain it with `mockReset()` in `beforeEach` (again:
`clearAllMocks` does not drain it).

Two things it deliberately does NOT flag, because neither corrupts a result: an
over-priming that no later test ever consumes, and a value primed in `beforeAll`
(which has no owning test to cross a boundary from).

The detector carries a canary — `tests/unit/scripts/once-leak-canary.test.ts`
leaks on purpose, and a CI step requires that running it with the allow-list
ignored still FAILS. That is what stops a silently-broken detector from looking
identical to a clean tree. Do not "fix" that suite's priming.

Three pre-existing files leaked when the detector landed and were grandfathered in
`tests/once-leak-allowlist.json`. All three were fixed by
[issue #1655](https://github.com/go-to-k/cdkd/issues/1655) and dropped from the
list, so it now holds nothing but the canary — the goal state. Fixing a file and
dropping its entry is the intended direction; adding an entry is not, and a new
test file that leaks fails CI. Regenerate the list with
`vp run gen:once-leak-allowlist`.

Worth knowing before you fix one, from the #1655 pass: in all three files the
over-priming described a call the code path never makes at all — a
`ListTagsForResource` gated on a field the mocked response omitted, three
policy/tag no-op responses for helpers that issue zero sends, and a
`DescribeTags` that `update()` never calls because it derives the tag diff from
the property bags. So the reliable fix is to MEASURE what the path consumes
rather than to trust the priming's own comment, all three of which were wrong.
Pinning the count with `expect(mockSend).toHaveBeenCalledTimes(N)` next to the
existing assertions is worth adding, but know what it does: it catches the code
path CHANGING how many calls it makes (the thing that silently invalidates a
priming), NOT a surplus primer — an unconsumed response leaves the count
unchanged. The detector is what catches the surplus, which is why dropping the
file from the allow-list is the load-bearing half of the fix.

Note what this deliberately does NOT do: it does not require `mockReset()` in
every suite that uses a `*Once` primer. That was the original proposal, and
measurement rejected it — 182 of the 265 `*Once`-using files have no reset, the
mechanical swap to `resetAllMocks()` breaks 1181 tests, and the presence of
`mockReset` is only a PROXY for the defect. Checking the defect directly
implicated a handful of files rather than 182, and needed no remediation batch
at all.

## 3. Deploy Using cdkd

```bash
# Set cdkd path (auto-resolves to the cdkd repo root when run from inside it;
# otherwise replace with an absolute path to your local cdkd checkout)
CDKD_PATH="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# First, check changes with diff
# --app and --state-bucket can be omitted if set via env vars or cdk.json
node ${CDKD_PATH}/dist/cli.js diff \
  --app "node bin/cdkd-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# Execute deployment (first time will create all resources)
# Stack name is a positional argument (auto-detected if single stack)
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "node bin/cdkd-test.ts" \
  --output cdk.out \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose
```

## 4. Verify Deployment Results

```bash
# Check if bucket was created via AWS Console or CLI
aws s3 ls | grep cdkd-test-bucket

# Check state files
aws s3 ls s3://${STATE_BUCKET}/cdkd/ --recursive
```

## 5. Test UPDATE Operations (JSON Patch)

cdkd supports resource updates via Cloud Control API JSON Patch (RFC 6902). Test UPDATE operations to verify changes are applied without recreating resources:

### Method A: Using the basic example with environment variable

```bash
cd "${CDKD_PATH}/tests/integration/basic"

# First deployment (CREATE)
# Stack name is positional; auto-detected if single stack
node ../../../../dist/cli.js deploy CdkdBasicExample \
  --app "node bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Second deployment with UPDATE test tag (UPDATE)
CDKD_TEST_UPDATE=true node ../../../../dist/cli.js deploy CdkdBasicExample \
  --app "node bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Verify the output shows UPDATE operations:
# Expected: "Changes: +0 ~1 -0" (1 resource updated)
```

The `CDKD_TEST_UPDATE=true` environment variable adds an additional tag to the S3 bucket without modifying the code. This allows testing UPDATE operations repeatedly.

### Removal testing (CDKD_TEST_REMOVAL)

`CDKD_TEST_REMOVAL=true` is the third env toggle a fixture stack can read, and
it exists for a bug class `CDKD_TEST_UPDATE` structurally cannot reach: the
**absent-field removal silent drop** (issue
[#1160](https://github.com/go-to-k/cdkd/issues/1160)). CloudFormation resets a
property REMOVED from the template to its default, while most AWS `Update*` /
`Modify*` APIs read an absent input field as "no change" — so a provider that
passes template properties straight through keeps the old live value, reports
success, and drops the field from state, after which `cdkd diff` says "No
changes" forever. Only a redeploy whose template genuinely LACKS the property
exercises that path, which is what this toggle produces.

The fixture branches on it when building the stack, and its `verify.sh`
redeploys with the toggle set after the baseline phase:

```bash
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
```

Two conventions make the result meaningful rather than vacuous:

- **Assert the baseline is live first.** A phase that only checks "the value is
  gone" passes identically when the value never reached AWS at all, so the
  baseline phase asserts the property IS set before the removal phase asserts
  it is not.
- **Keep a sibling that is NOT removed.** A reset that clears everything is as
  wrong as one that clears nothing; the retained sibling is what distinguishes
  them.

The two conventions above are the ones worth copying, but they are NOT
universal in the tree — `cloudfront-function-url` deliberately removes the only
value it sets, so it satisfies the baseline-live convention without a retained
sibling. Copy the retained sibling whenever the property is a COLLECTION (a tag
list, an attribute map), where "cleared everything" and "cleared the right
entry" are different outcomes.

`alb` is the fixture that shows both shapes side by side, and how one turns
into the other. Its Listener arm drops the only `ListenerAttributes` entry it
sets (no sibling needed), while its `LoadBalancerAttributes` arm — added by
issue [#1609](https://github.com/go-to-k/cdkd/issues/1609) item 1 — retains
two keys and drops only `idle_timeout.timeout_seconds`.

**A retained sibling only works when its templated value DIFFERS from AWS's
default**, and getting that wrong is easy enough that this fixture shipped it
in review. The first version retained `deletion_protection.enabled: 'false'` —
but `false` IS the AWS default, so a bug that reset every attribute on the
load balancer would produce a byte-identical readback and the assertion could
not tell an over-broad reset from a correct one. The sibling that does the job
is `routing.http2.enabled: 'false'` (AWS defaults it to `true`), asserted at
baseline and again after the removal deploy. Ask of any retained sibling: *if
the provider cleared EVERYTHING, would this assertion still pass?* If yes, it
is decoration.

`deletion_protection.enabled` stays in every phase for the other half of the
job — it pins a CDK-L2 trap. The L2
`ApplicationLoadBalancer` emits its own `deletion_protection.enabled` entry, so
the first version of that fixture — which simply omitted the property override
in the removal phase — let the L2 default reappear, turning the phase into a
value CHANGE plus an unintended second removal instead of the clean single-key
removal it read as. Restating the sibling in EVERY phase is what keeps the
removal single-key. Synthesize both phases and diff the rendered list before
running; `cdk synth` exiting 0 in each phase proves nothing about the delta
between them.

**The toggle also serves the INVERSE assertion, where retention is the correct
outcome.** Everything above describes the #1160 class, in which a removed
property must be RESET to its default and the removal phase asserts it is gone.
`nlb-source-nat` (issue
[#1619](https://github.com/go-to-k/cdkd/issues/1619)) uses the same toggle to
assert the opposite, and it is not a violation of the convention: its two
NLB flags have no API of their own and ride on `SetSubnets` /
`SetSecurityGroups`, so what is under test is what **AWS** does when the Set*
call omits the member. AWS retains, so cdkd correctly sends nothing and the
removal phase asserts the live value SURVIVED.

Two conventions carry over unchanged, and one is added:

- baseline-live still applies, with a twist that matters more here — the
  templated value must be AWS's NON-default (`on` for source-NAT; `off` for the
  enforce flag, which AWS defaults to `on`), or "retained" and "reset to
  default" produce an identical readback and the assertion proves nothing. This
  is the same trap as the retained-sibling rule above, one level over.
- a retained sibling is not applicable — each flag is scalar, not a collection.
- **new: prove the Set\* call actually FIRED.** A retention assertion is
  vacuous if no call was issued, since the value would be untouched either way.
  So each flag is dropped in the SAME deploy that changes its companion
  property (a third subnet / a second security group), and the phase asserts
  that companion change landed before asserting the flag survived.

The current set of fixtures using the toggle changes as batches ship; find it
with:

```bash
grep -rl CDKD_TEST_REMOVAL tests/integration/*/lib/*.ts tests/integration/*/verify.sh
```

### Failure injection (CDKD_TEST_FAIL)

To verify rollback against real AWS, the `basic` stack supports a third toggle:

```bash
# Deploy with a deliberately-failing SQS Queue injected.
# The good resources (S3 bucket, SSM Document) succeed in parallel;
# the SQS Queue's invalid MessageRetentionPeriod is rejected by AWS,
# triggering rollback that deletes the already-completed siblings.
CDKD_TEST_FAIL=true node ../../../../dist/cli.js deploy CdkdBasicExample \
  --app "node bin/app.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION}

# Expected: deploy fails with rollback log, and `aws s3 ls
# s3://${STATE_BUCKET}/cdkd/` shows no leftover state.
```

Use this to sanity-check the dispatcher's rollback path against AWS without writing a separate failing CDK app each time.

For the richer, multi-resource rollback regression net (VPC + Subnets +
SecurityGroup + IAM Role + Lambda-in-VPC + SSM Parameter, with a
self-contained env-gated failing SQS Queue), see
`tests/integration/rollback-failure-injection/` (scenario tag
`rollback-failure-injection`). It asserts the completed siblings are rolled
back with no orphan VPC/SG/ENI/Role/Lambda/SSM and that the #808 events
captured `RESOURCE_FAILED` + `ROLLBACK_*` + `RUN_FINISHED result=FAILED`.

For the `cdkd rollback` command's harder paths, see
`tests/integration/rollback-sqs-cooldown/` (scenario tags
`rollback-reverse-replacement-name-cooldown` +
`failed-only-journal-retention-cycle`, issue #1218): the reverse-replacement
re-create retrying through the SQS ~60s `QueueDeletedRecently` same-name
cooldown (issue #1206), and the failed-only journal retention cycle after a
clean automatic rollback — retained `auto-rollback-clean` journal, the
next-deploy `--revert-failed` note, `cdkd rollback --force --revert-failed`
consuming it, and the NO-CHANGE fix-forward deploy clearing the journal
(issues #1208 / #1198 / PR #1212).

For the rollback arm that re-creates a REPLACED resource, see
`tests/integration/rollback-replay-effective-props/` (scenario tag
`rollback-replay-effective-properties`, issue #1682). It is deliberately a
different branch from `rollback-failure-injection`, which rolls back CREATEs
(a delete): here the resource was replaced before the failure, so rollback
re-creates the OLD one from `previousState.properties` — a cdkd STATE record,
which can carry a malformed block an older binary wrote and which the provider
WARNS about and SUBSTITUTES rather than refusing (the #1544 `replayWarn`
downgrade). The fixture deploys an `AWS::EC2::Route`, injects a second
destination key into the state record, flips the create-only destination with
a failure wired AFTER the route, and asserts the post-rollback record kept the
SUBSTITUTED bag and that two consecutive `cdkd drift` runs converge. The
vehicle is a route rather than the `AWS::S3::Bucket` the issue names because a
bucket's reverse-replacement re-create has to re-acquire a just-deleted
GLOBALLY unique name, which would make the fixture flaky for a reason
unrelated to what it tests.

For the rollback arm whose replayed value is a SECRET the deploy resolved in
another region, see `tests/integration/rollback-cross-region-secret/` (scenario
tags `dynamic-reference-resolution` + `getstackoutput-cross-region`, issue
#2057). A producer stack in `us-west-2` exports an output carrying a
`{{resolve:ssm:...}}` SecureString reference; a consumer in `us-east-1` reads it
via `Fn::GetStackOutput`, so the consumer's state persists the PRODUCER's
region-less spelling of that expression while `outputReads[].sourceRegion`
records where it came from. A failing `--no-rollback` deploy then forces
`cdkd rollback --force`, which must exit 2 with
`ROLLBACK_SECRET_REGION_AMBIGUOUS` rather than re-resolving the reference
locally. The discriminator is that the SAME parameter NAME is seeded in BOTH
regions with DIFFERENT values, both asserted to really be `SecureString` first:
without that the run cannot tell a correct resolution from a wrong one, and the
assertion the fixture exists for is that the live parameter still holds the
PRODUCER region's value. `SecureString` rather than a Secrets Manager secret
because a bare parameter NAME is region-less -- which is precisely the arm under
test -- and because there is no deletion cooldown to collide on across repeated
runs. (An SSM reference CAN name a full ARN: `resolveSSMReference` joins its
colon-split tail back together, so an ARN reaches `GetParameter` intact. That
form takes the `named-region` arm and is covered by the unit tests, not here.)

The same fixture also carries the `cdkd drift` half of that defect (issue
[#2108](https://github.com/go-to-k/cdkd/issues/2108)), as phases 2b / 2c on the
CLEAN v1 deploy rather than on the journal -- which is what makes #2108 the
wider of the two: it is reachable from an ORDINARY drift run instead of only
after a failed deploy. Phase 2b asserts `cdkd drift --json` reports `SecretEcho`
in its `notCompared` roll-up, because a comparison the region refusal SKIPPED
carries no marker otherwise and a CI consumer would read the skip as a clean
bill of health. Phase 2c tampers the live echo parameter, runs
`cdkd drift --revert -y`, and asserts the live value did NOT become the consumer
region's secret -- pre-fix that is exactly what the revert wrote, since the
state baseline was resolved through the consumer's region. It then restores the
parameter, so the rollback arms below start from the state phase 2 left behind.

### SNS standalone-subscription update (`tests/integration/sns-subscription-update/`)

`SNSSubscriptionProvider.update` had NO real-AWS coverage before issue
[#1967](https://github.com/go-to-k/cdkd/issues/1967) -- every existing SNS
fixture either uses the L1 `CfnTopic.subscription` inline list (a different
provider) or an L2 `addSubscription`, whose logical id embeds the target's node
path so a target change is a create+delete pair rather than an update.

The fixture flips `RawMessageDelivery` on an L1 `CfnSubscription`, which is the
only shape that reaches the method: `TopicArn` / `Protocol` / `Endpoint` are all
createOnly, so changing any of them routes to replacement and executes zero
lines of `update()`. Phase 2 asserts the topic ends with exactly ONE
subscription, that the `SubscriptionArn` CHANGED (a fresh `Subscribe` mints a new
GUID, which is what proves the internal delete-then-create ran), and that cdkd
recorded the new ARN. Phase 3 rewrites the state physicalId to a malformed ARN so
`Unsubscribe` throws, and asserts cdkd ABORTS instead of creating -- the
discriminator is that SNS's own `already exists with different attributes` is
ABSENT from the output, which is the real-AWS spelling of "`create()` was never
called".

### Drift revert E2E (`tests/integration/drift-revert/`)

End-to-end real-AWS test for `cdkd drift` + `cdkd drift --revert`.
Deploys an S3 Bucket (with tags) + SNS Topic (with DisplayName), mutates
them out-of-band via direct AWS SDK calls (`PutBucketTagging`,
`SetTopicAttributes`), and asserts that `cdkd drift` exits with code 1
(drift detected) and that `cdkd drift --revert -y` exits with code 0
(revert succeeded). Run via:

```bash
bash tests/integration/drift-revert/verify.sh
```

The script auto-resolves the AWS account ID, picks the cdkd state
bucket as `cdkd-state-${accountId}`, builds cdkd from the repo root,
and finishes with `cdkd destroy --force`. Catches AWS-shape divergences
and timing flakiness that the per-provider mocked round-trip unit tests
miss.

### Method B: Manual code changes

Alternatively, modify the stack code directly and re-deploy to test updates.

## 6. Test CloudFormation Intrinsic Functions

cdkd supports CloudFormation intrinsic functions (Ref, Fn::GetAtt, Fn::Join, Fn::Sub).
Verify that resources using these functions can be deployed:

```bash
# Change to a stack using intrinsic functions
cat > lib/cdkd-test-stack.ts <<'EOF'
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class CdkdTestStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create S3 bucket
    const bucket = new s3.Bucket(this, 'TestBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
    });

    // Create IAM role (using Ref to reference bucket)
    const role = new iam.Role(this, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: 'Test role for cdkd',
    });

    // Grant read permissions to bucket (using Fn::GetAtt)
    role.addToPolicy(
      new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [bucket.bucketArn, `${bucket.bucketArn}/*`],
      })
    );

    // Test intrinsic functions with Outputs
    new cdk.CfnOutput(this, 'BucketName', {
      value: bucket.bucketName,
      description: 'Bucket name (Ref)',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: bucket.bucketArn,
      description: 'Bucket ARN (Fn::GetAtt)',
    });

    new cdk.CfnOutput(this, 'RoleArn', {
      value: role.roleArn,
      description: 'Role ARN (Fn::GetAtt)',
    });
  }
}
EOF

vp run build

# Check changes with diff
node ${CDKD_PATH}/dist/cli.js diff \
  --app "node bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose

# Deploy updates
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "node bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --verbose
```

## 6. Test Dry Run

Display execution plan only without making actual changes:

```bash
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "node bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --region ${AWS_REGION} \
  --dry-run \
  --verbose
```

## 7. Delete Stack

```bash
# Delete resources with destroy command (stack name is positional)
node ${CDKD_PATH}/dist/cli.js destroy CdkdTestStack \
  --app "node bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --verbose

# To skip confirmation prompt
node ${CDKD_PATH}/dist/cli.js destroy CdkdTestStack \
  --app "node bin/cdkd-test.ts" \
  --state-bucket ${STATE_BUCKET} \
  --state-prefix "stacks" \
  --region ${AWS_REGION} \
  --force
```

## 8. Cleanup

After testing, delete the state bucket as well:

```bash
# Delete objects in bucket
aws s3 rm s3://${STATE_BUCKET} --recursive

# Delete bucket itself
aws s3 rb s3://${STATE_BUCKET}
```

## Troubleshooting

### Asset Publishing Errors

If your CDK application uses assets (such as Lambda function code), asset publishing may fail:

```bash
# Skip asset publishing
node ${CDKD_PATH}/dist/cli.js deploy \
  --app "..." \
  --state-bucket ${STATE_BUCKET} \
  --skip-assets
```

### Resource Type Support

**cdkd automatically supports all resource types supported by Cloud Control API.**

For resources not supported by Cloud Control API, you can implement SDK providers. cdkd includes SDK provider resource types for common services (see `src/provisioning/providers/` for the full list). Key providers include IAM Role/Policy, S3 Bucket/BucketPolicy, Lambda Function/Permission/Url/EventSourceMapping, DynamoDB Table, SQS Queue/QueuePolicy, SNS Topic/Subscription, EC2 VPC/Subnet/SecurityGroup and related networking resources, API Gateway, EventBridge, CloudWatch, Logs, SecretsManager, SSM, CloudFront OAI, and Custom::* resources.

If you use other resources not supported by Cloud Control API, an error message will be displayed.

### Integration Test Coverage Matrix

[`docs/integ-coverage.md`](integ-coverage.md) lists every registered SDK Provider with the integ fixtures that exercise it (and surfaces orphan providers — those registered but lacking any integ coverage). Generated from `src/provisioning/register-providers.ts` + `tests/integration/*/{lib,bin}/*.ts`.

```bash
vp run integ-coverage
```

This regenerates both `docs/integ-coverage.md` (human-readable report) and `docs/_generated/integ-coverage.json` (machine-readable matrix). Run it after adding a new provider or new integ fixture; the file is checked into the repo so reviewers can see coverage shifts in the PR diff. **CI hard-fails when the committed snapshot is stale**: the `check-build-test` job in `.github/workflows/ci.yml` runs `vp run integ-coverage` and fails on a non-empty `git diff` of these two files, so a forgotten regeneration cannot reach main.

The hook `.claude/hooks/provider-integ-gate.sh` blocks `git commit` when a new `registry.register('AWS::Foo::Bar', ...)` is staged without a matching integ fixture (literal type id, `Cfn<Type>(` L1 class, or a sidecar entry in `.claude/integ-coverage-allowlist.json`). The sidecar is JSON: `{"AWS::Foo::Bar": "rationale"}` — kept outside `src/provisioning/register-providers.ts` so allow-list edits do not trigger the `integ-broad-gate`'s real-AWS broad integ requirement. See the hook's docstring for the full resolution paths.

### CLI Flag Coverage (visibility report)

[`docs/cli-flag-coverage.md`](cli-flag-coverage.md) lists every CLI flag declared in `src/cli/options.ts` and the integ fixtures whose `verify.sh` exercises it. Generated via `vp run cli-flag-coverage`.

**The coverage numbers are a visibility report, NOT a CI gate.** Many cdkd flags (`--dry-run`, `--verbose`, `--profile`, etc.) are tested adequately at the unit-test level rather than via an integ shell invocation — surfacing those as "uncovered" would produce >50% false-positive noise. The "no integ verify.sh mention" section is a question for the reviewer ("does THIS flag warrant a real-AWS test?"), not an answer.

Contrast with the provider-coverage matrix in [docs/integ-coverage.md](integ-coverage.md), where a coverage gate IS appropriate because every registered provider is expected to have real-AWS verification.

**CI hard-fails on staleness** (issue #1071): the `check-build-test` job in `.github/workflows/ci.yml` runs `vp run cli-flag-coverage` and fails on a non-empty `git diff` of the regenerated `docs/cli-flag-coverage.md` / `docs/_generated/cli-flag-coverage.json`, so a forgotten regeneration cannot reach main. Same staleness shape as the integ-coverage / scenario-coverage matrices — it guards freshness of the generated file, not coverage %.

### Scenario Coverage (visibility report)

[`docs/scenario-coverage.md`](scenario-coverage.md) maps each cdkd-canonical real-AWS regression pattern (e.g. `vpc-lambda-eni-release`, `nat-gateway-cleanup`, `multi-stack-importvalue-strong-ref`) to the integ fixtures that exercise it. Generated via `vp run scenario-coverage`.

Per-fixture annotations live in a `tests/integration/<fixture>/.scenarios.json` sidecar:

```json
{
  "scenarios": ["vpc-lambda-eni-release", "nat-gateway-cleanup"]
}
```

Empty `[]` means "intentionally no canonical scenario applies" (per-service smoke tests). Absent file means "not yet annotated" — surfaced in the un-annotated section of the report. The canonical taxonomy is defined as `KNOWN_SCENARIOS` in [scripts/build-scenario-coverage-matrix.ts](../scripts/build-scenario-coverage-matrix.ts); a sidecar tag outside the taxonomy is hard-rejected at parse time, so typos surface immediately.

**Visibility-only, NOT a CI gate** on per-fixture coverage. Same rationale as the CLI-flag matrix: many fixtures legitimately exercise no canonical scenario, and forcing per-commit annotation would add friction without proportional value. The intended consumer is the contributor reviewing "does THIS real-AWS pattern have an integ backstop?" — an orphan scenario in the matrix IS the value signal. **CI hard-fails on staleness**: the `check-build-test` job in `.github/workflows/ci.yml` runs `vp run scenario-coverage` and fails on a non-empty `git diff` of the regenerated `docs/scenario-coverage.md` / `docs/_generated/scenario-coverage.json`, so a forgotten regeneration or a typo'd tag cannot reach main.

Adding a new scenario: (1) add an entry to `KNOWN_SCENARIOS` with a one-line description in [scripts/build-scenario-coverage-matrix.ts](../scripts/build-scenario-coverage-matrix.ts); (2) tag existing fixtures that exercise it (or write a new one); (3) `vp run scenario-coverage` to regenerate.

### Integ-run Ledger (normalized shape)

[`docs/_generated/integ-last-run.tsv`](_generated/integ-last-run.tsv) records, one row per integration test, when it last ran and whether it passed. `/run-integ` writes it on every run (pass or fail) and `/pick-integ` ranks staleness from it.

Unlike the three matrices above it is not derived from the tree — it is accumulated run history, so it cannot simply be regenerated. What IS enforced is its **shape**: exactly one row per test, rows sorted by test name. `vp run integ-ledger-normalize` rewrites the file into that shape (keeping the newest `last_run_iso` per test), and `--check` reports violations without writing.

**CI hard-fails on a non-normalized file** (issue [#1112](https://github.com/go-to-k/cdkd/issues/1112)): the `check-build-test` job runs the task and fails on a non-empty `git diff`, same shape as the staleness gates above.

The sort order is load-bearing, not cosmetic. The pre-fix write path dropped the test's old row and appended a new one; under rebase that append was replayed against a base that already contained the row, so git took both sides and the row silently duplicated — 10 tests on `main` were affected before this landed. A deterministic whole-file rewrite makes a replayed commit reproduce the file byte-for-byte instead, so the duplication cannot be created in the first place. Never hand-edit the file; record the run, then run the task.

### Verbose Logging

Add the `--verbose` flag to display detailed logs:

```bash
node ${CDKD_PATH}/dist/cli.js deploy ... --verbose
```

## Known Issues and Limitations

1. **Cloud Control API Update Processing**: The current implementation performs differential updates using JSON Patch, but complete updates may fail for some resources.

2. **CloudFormation Intrinsic Functions**: All intrinsic functions are now supported.

3. **Pseudo Parameters**: All pseudo parameters are supported:
   - ✅ `AWS::AccountId` - Retrieves actual value from STS GetCallerIdentity
   - ✅ `AWS::Region` - Uses configured region
   - ✅ `AWS::Partition` - Derived from the region (`aws` / `aws-cn` / `aws-us-gov` / `aws-iso` / `aws-iso-b` / `aws-iso-e` / `aws-iso-f` / `aws-eusc`)
   - ✅ `AWS::StackName` - From stack configuration
   - ✅ `AWS::StackId` - Generated unique identifier
   - ✅ `AWS::URLSuffix` - Derived from the region (`amazonaws.com` / `amazonaws.com.cn` / `c2s.ic.gov` / `sc2s.sgov.gov` / `cloud.adc-e.uk` / `csp.hci.ic.gov` / `amazonaws.eu`)
   - ✅ `AWS::NoValue` - For conditional property omission
