# import-auto-mode

`cdkd import` **auto mode** against a CloudFormation-generated physical name
(issue [#1128](https://github.com/go-to-k/cdkd/issues/1128)), and against a
resource whose cdkd physicalId is a COMPOSITE while CloudFormation's is not
(issue [#1651](https://github.com/go-to-k/cdkd/issues/1651)).

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

## The Glue pair: the same path failing one layer down (#1651)

Issue #1128 fixed how auto mode **resolves** a CloudFormation-generated id;
issue #1651 is the provider **rejecting** an id auto mode had already resolved
— so the two belong in one fixture.

cdkd's physicalId for `AWS::Glue::Table` is the composite
`<databaseName>|<tableName>`, because `GetTable` / `UpdateTable` /
`DeleteTable` all need both segments while the read-side `ResourceProvider`
methods receive a single string. CloudFormation's physicalId for the same type
is the **table name alone**. Auto mode merges CFn's id into the overrides, so
`importTable` received the bare form, split it on `|`, found no second segment,
and returned `not found` **without ever calling AWS** — every `cdk
deploy`-managed Glue table was unadoptable, and the error told the user to pass
`--resource <LogicalId>=<physicalId>` with the very id it had just rejected.

Two properties make this half meaningful, both asserted at runtime:

| Constraint | Why | Guard |
| --- | --- | --- |
| `DatabaseName` is a **`Ref`**, not a literal | It is what CDK emits, and it is why a bare table name can be paired with a database at all: `AWS::Glue::Database`'s CFn physicalId IS the database name, so the overrides map resolves the `Ref` to a literal before `provider.import()` runs. A literal here would test a path CDK users never take. | Phase 2b asserts CFn's reported table id contains no `\|` before anything relies on it |
| The adopted id must be the **composite** | Recording CFn's bare name would look like a successful import while leaving a state row that update / delete / getAttribute / readCurrentState all fail to split — trading a visible not-found for a silent one | Phase 4b compares the state row against `<CFn database id>\|<CFn table id>` |

Unlike the policy, the Glue resources carry explicit names: Glue restricts names
to lowercase alphanumerics and underscore, so CloudFormation cannot generate a
conforming one. That costs nothing — #1651 is about the id **shape**, not its
origin.

## Flow

1. `cdk deploy` (upstream CDK CLI → CloudFormation) — the advertised adoption scenario
2. assert the premise: CFn-generated name, no `aws:cdk:path` tag
3. (2b) assert CloudFormation's Glue table id is the **bare** name, not a composite
4. `cdkd import <stack> --yes` — **auto mode, no override flags**
5. assert the policy state row's `physicalId` equals the real ARN
6. (4b) assert the Glue table row's `physicalId` is cdkd's **composite** form
7. `cdkd destroy` + strict gone-probes (policy, table, database), then drop the
   now-dangling CFn stack

Pre-#1128, step 4 reported the policy as `not found` and step 5 failed.
Pre-#1651, the same step reported the Glue table as `not found` and step 6
failed.

## Run

```bash
cd tests/integration/import-auto-mode
npm install
STATE_BUCKET="your-cdkd-state-bucket" AWS_REGION="us-east-1" bash verify.sh
```

Requires CDK bootstrap in the target account (`cdk deploy` is part of the flow).
Resources: one `AWS::IAM::ManagedPolicy`, one `AWS::Glue::Database`, one
`AWS::Glue::Table` — all free, fast, no VPC, no deletion recovery window.
