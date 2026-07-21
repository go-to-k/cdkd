# import-auto-mode

`cdkd import` **auto mode** against a CloudFormation-generated physical name
(issue [#1128](https://github.com/go-to-k/cdkd/issues/1128)).

## What this pins

Auto mode resolves each resource's physical id in stages:

1. the template's own name property (`ManagedPolicyName`, `TopicName`, ...);
2. an `aws:cdk:path` tag walk;
3. a CloudFormation `DescribeStackResources` lookup (added in #1128).

**Stage 2 cannot match on real AWS.** AWS rejects any `aws:`-prefixed tag write
(`Tag keys beginning with aws: are reserved for system use`), and CloudFormation
keeps `aws:cdk:path` in the template's resource `Metadata` without ever
promoting it to a tag. So before #1128, a resource whose physical name
CloudFormation generated — the usual CDK shape, since CDK rarely sets explicit
names — came back `not found` even though it was sitting there and perfectly
importable.

## Why it did not get caught earlier

Both pre-existing import integs bypass the path:

- `import-attributes` passes `--resource <id>=<arn>` (explicit override);
- `import-nested-stack` passes `--migrate-from-cloudformation` (which reads
  `DescribeStackResources` directly).

Four rounds of tag-walk work (#1091, ~33 providers) went into a code path no
integ exercised — and it turned out the path could never match on real AWS, so
the tag walk was deleted from every provider (#1134). This fixture pins the
resolution that actually works (the CloudFormation `DescribeStackResources`
lookup added in #1128) so that path cannot silently regress.

## The two constraints that make it meaningful

Both are asserted at runtime, so a future edit that breaks them fails loudly
rather than quietly turning the fixture into a no-op:

| Constraint | Why | Guard |
|---|---|---|
| The policy has **no explicit physical name** | Otherwise stage 1 resolves it and stages 2/3 are never reached | Phase 2 asserts the ARN matches `<Stack>-Policy-<suffix>` |
| `verify.sh` passes **neither** `--resource` **nor** `--migrate-from-cloudformation` | Either one short-circuits the path under test | Reviewed at the call site; adding one re-creates the blind spot |

Phase 2 also asserts the deployed policy carries **no** `aws:cdk:path` tag. If
AWS ever starts allowing that tag, this assertion fires — a signal that the tag
walk became viable and #1128's CloudFormation lookup should be revisited.

## Flow

1. `cdk deploy` (upstream CDK CLI → CloudFormation) — the advertised adoption scenario
2. assert the premise: CFn-generated name, no `aws:cdk:path` tag
3. `cdkd import <stack> --yes` — **auto mode, no override flags**
4. assert the state row's `physicalId` equals the real ARN
5. `cdkd destroy` + strict gone-probes, then drop the now-dangling CFn stack

Pre-#1128, step 3 reported `0 imported, 1 not found` and step 4 failed.

## Run

```bash
cd tests/integration/import-auto-mode
npm install
STATE_BUCKET="your-cdkd-state-bucket" AWS_REGION="us-east-1" bash verify.sh
```

Requires CDK bootstrap in the target account (`cdk deploy` is part of the flow).
Resources: one `AWS::IAM::ManagedPolicy` — free, fast, no VPC, no deletion
recovery window.
