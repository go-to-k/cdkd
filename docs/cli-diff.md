---
title: cdkd diff
description: "Preview what a deploy would change — cdkd diff semantics, output, and flags."
---

# cdkd diff

`cdkd diff` synthesizes the CDK app and reports the per-resource CREATE /
UPDATE / DELETE changes the next `cdkd deploy` would apply, comparing the synth
template against cdkd's S3 state. It reads state and never writes it, so it is
safe to run at any time.

```bash
cdkd diff                                  # the single stack in the app
cdkd diff MyStack                          # one stack by name
cdkd diff 'MyStage/*'                      # every stack under a stage
cdkd diff --all                            # every stack in the app
cdkd diff ParentStack --recursive          # descend into nested stacks
cdkd diff --all --fail                     # CI gate: exit 1 on any change
cdkd diff MyStack --json                   # machine-readable payload
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `--all` | off | Diff every stack in the app. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--recursive` | off | Descend into each `AWS::CloudFormation::Stack` row and diff every nested child against its own state. |
| `--fail` | off | Exit `1` when any change is detected. |
| `--json` | off | Emit the diff as JSON instead of human-readable text. |
| `--use-cdk-bootstrap-assets` | off | Compare against the CDK bootstrap asset destinations verbatim, skipping cdkd's asset-storage redirection. |
| `--no-cfn-fallback` | fallback on | Do not fall back to CloudFormation when a cross-stack reference is missing from cdkd state. See [`--no-cfn-fallback` (deploy / diff)](cli-deploy-safety.md#no-cfn-fallback-deploy-diff). |
| `--region <region>` | AWS profile / `AWS_REGION` | Deprecated, still honored. Prefer `AWS_REGION` or your AWS profile. |

`cdkd diff` also accepts the flags every command shares — `--app`,
`--state-bucket`, `--state-prefix`, `--context`, `--profile`, `--role-arn`,
`--verbose`. See the [CLI reference](cli-reference.md).

## Stack selection

Selection follows the same rules as `cdkd deploy` and `cdkd destroy`:

- **A positional name** matches either the physical CloudFormation stack name
  (`MyStage-Api`) or the CDK display path (`MyStage/Api`). A pattern containing
  `/` is matched against the display path; one without `/` against the physical
  name.
- **Wildcards** work in both forms: `'My*'`, `'MyStage/*'`. Quote them so the
  shell does not expand them first.
- **Several names** may be given at once; the result is their deduplicated
  union.
- **`--all`** selects every stack in the synthesized app.
- **No argument** is accepted only when the app contains exactly one stack.
  With more than one, cdkd lists the available stacks and exits `1` rather than
  guessing.
- **No match** is an error, not an empty diff: cdkd names the patterns it tried
  and lists what the assembly actually contains.

## Reading the output

Each changed stack gets a block headed by its name, one line per changed
resource, and a summary line:

```text
Stack MyStack:
  [+] AssetsBucket (AWS::S3::Bucket)
  [~] ApiFunction (AWS::Lambda::Function)
      - Timeout:
          old: 3
          new: 30
  [-] LegacyTopic (AWS::SNS::Topic)

1 to create, 1 to update, 1 to delete
```

A stack with nothing to do prints `✓ No changes detected for stack MyStack`
instead of a block.

| Marker | Meaning |
| --- | --- |
| `[+]` | The resource would be created. |
| `[~]` | The resource would be updated, with each changed property listed below it. |
| `[-]` | The resource would be deleted. |
| `[requires replacement]` | Changing that property replaces the resource rather than updating it in place. |
| `[replacement propagated]` | The property's template value did not change — only the physical ID or ARN it references will, because an upstream resource is being replaced. The apparent `"value"` → `{Ref: ...}` delta is not a literal edit. |
| `[metadata only, no AWS API call]` | A `DeletionPolicy` / `UpdateReplacePolicy` change. cdkd records it in state; AWS is not called. |
| `(known after deploy)` | The new side is an unresolved intrinsic — a `Ref` or `Fn::GetAtt` to a resource this same deploy will create. |

### Routing annotation

Every CREATE / UPDATE line whose template uses a top-level CloudFormation
property cdkd's SDK provider does not yet wire is tagged with the properties
that force the fallback:

```text
  [~] ApiFunction (AWS::Lambda::Function) [via CC API: RuntimeManagementConfig]
```

This is the same auto-fallback the deploy engine applies, surfaced at plan time
so the routing decision is auditable before you deploy. DELETE lines are never
annotated: deletes route via the `provisionedBy` value recorded on each
resource in state, not by inspecting the template.

### Adopted rollback orphans

```text
  [~] Bucket (AWS::S3::Bucket) [adopted from a rollback orphan]
```

A previous deploy failed, rolled back, and left this resource in AWS because
its `DeletionPolicy` is `Retain`. cdkd recorded what it left behind, and the
next deploy re-adopts that resource instead of asking AWS for a name the
resource still holds — so the row is an UPDATE rather than a create.

When the adopted resource needs no property change at all, there is no row to
annotate: it compares equal, like any unchanged resource. The summary names it
instead, so an adoption is never silent:

```text
0 to create, 0 to update, 0 to delete
1 resource(s) to adopt from a previous rollback: Bucket
```

A stack in that state is NOT "no changes detected", and `--fail` treats it as a
change: the deploy still takes the resource back into state and rewrites the
state file without the orphan record.

`cdkd diff` runs the same verification the deploy runs before it draws this
row: the resource must still exist, still answer to the recorded physical id,
and be claimed by no other cdkd stack. A record that fails any of those is not
adopted, and the row stays a create — which is what the deploy will attempt.
A record that fails the ownership check is reported under `Blocking` instead;
see [Exit codes](#exit-codes).

The annotation is not cosmetic. Without it the row is indistinguishable from an
ordinary update, and the last thing you saw this resource do was fail and drop
out of state — so an unannotated `[~]` reads as cdkd having quietly kept
managing it.

This is the only part of `cdkd diff` that calls an AWS resource provider, and
it runs only for a stack whose state holds orphan records. A stack that has
never had a rollback orphan anything pays nothing for it.

## Outputs

The diff also compares the template's `Outputs` against the outputs bag in
state. An **Outputs-only** change — one whose `Resources` section is
byte-identical — is reported rather than printing `No changes detected`, and
`--fail` exits `1` for it.

This matters because the deploy performs an Outputs-only persist: when a
downstream stack starts referencing a producer, CDK synth adds an `Output` with
an `Export.Name` to the producer while leaving its resources untouched. Without
the Outputs comparison, the preview would steer you away from the very deploy
that publishes the export. Removals are reported for the mirror-image reason —
dropping an export can break a consumer's `Fn::ImportValue`.

```text
Stack ProducerStack:

  Outputs:
    [+] ExportsOutputFnGetAttBucketArn
          new: "arn:aws:s3:::my-bucket"
    [+] ProducerStack:ExportsOutputFnGetAttBucketArn [export]
          new: "arn:aws:s3:::my-bucket"

0 to create, 0 to update, 0 to delete
2 output(s) to add, 0 to change, 0 to remove
```

Rows are keyed by what actually lands in state, so an output carrying an
`Export.Name` shows **two** rows — its logical name and its export name. The
`[export]` row is the string a consumer's `Fn::ImportValue` resolves against.

The Outputs counts are a **separate** summary line. An Outputs change is a
state / exports-index write with no AWS resource operation behind it, so it
never inflates the create / update / delete counts.

Output values are resolved best-effort against current state, with the
resolver `cdkd deploy` uses. When an output cannot be fully resolved — typically
because it references a resource this deploy has yet to create — the Outputs
section is **omitted rather than guessed**. A warning says so when any
difference remains beyond the failed outputs themselves — usually another
output that would also have changed; when none does, the absent section is
silent.
That resource's `CREATE` is already on the resource side of the diff.

One case is previewed instead of omitted: **no resource changes, and every
output that failed did so with a signal the deploy also records** (the resolver threw, or
returned nothing for the whole value). The deploy then persists the outputs
that did resolve, as described below, so the diff shows that — a row
for an added or changed sibling, no row for the failed output, plus a warning naming
the failed outputs: those with a stored value are compared at it, those with
no stored value under their own name are listed as such, and the deploy may
still resolve one the diff could not — a lookup keyed by a secret the diff
never fetches, for example. Unless every value carried from state for a failed
output, an alias included, is itself a secret reference, the rows withhold
their previous values, because a value the diff did not resolve cannot show
whether the stored outputs predate secret redaction; when a row actually
withholds one, the warning says so. That reason no longer applies once every
failed output resolves, though the diff's other legacy-plaintext checks can
still withhold the values. The section is still omitted when:

- a resource change is pending;
- a condition verdict can reach an output's value — an output carries its own
  `Condition`, or an `Fn::If` or `Condition` reference appears anywhere outside
  the template's resources and conditions, such as in a mapping. The diff
  evaluates conditions best-effort and can reach a different verdict from the
  deploy, so an output that fails here may resolve at deploy. A condition that
  gates only resources, like the one CDK adds to its metadata resource, does
  not count: an output never reads a resource's template properties. Should the
  diff and the deploy disagree about such a resource, the warning above already
  says the deploy may write a different value for each failed output;
- a template parameter could not be bound for the diff, or condition evaluation
  was skipped because a condition depends on a parameter holding a secret
  reference (see [Condition pruning is skipped](#condition-pruning-is-skipped));
- an output's value came back in a shape that does not tell the diff what the
  deploy will do with it — a function the diff could not evaluate, an
  `AWS::NoValue`, an `Fn::Sub` placeholder left unsubstituted, or a list or
  object holding one of those or a missing value;
- an output's `Export.Name` could not be resolved or decided;
- the deploy would keep all of the previous outputs (the two cases below).

One of those keep-whole checks the deploy repeats after it has captured
observed state, where a secret it records late can refuse a merge the diff
previewed, so a row shown here can still be kept back by the deploy.

An output the **last deploy could not resolve and skipped** is not previewed
as an `ADD` either. Two things get skipped, and only the first is announced:

- the resolver **threw** — a lookup failed inside it, such as a
  `{{resolve:secretsmanager:...}}` naming a JSON key the secret does not
  hold. The deploy warns per output (`--strict-getatt` aborts instead).
- the resolver **returned nothing** — an `Fn::GetAtt` whose attribute could
  not be constructed. No per-output warning.

Either way the deploy still persists every other output that did resolve, so
an output you add beside a broken one lands on the next deploy. A broken
output keeps the value it had from an earlier deploy, if it had one. Two cases
keep all of the previous outputs instead, with a warning naming why: a broken
output that had a value before and declares its `Export.Name` with an
intrinsic function, and a save that would put the first secret reference into
the stored outputs beside a value it cannot vouch for — checked on the outputs
exactly as they will be saved. A kept value is not repositioned onto a reference
from today's template; the ordinary secret scan still redacts it.

The diff never fetches secrets, so it cannot reproduce the first failure at
all. The second it does reproduce — an attribute it cannot build is unresolved
for the diff too — but it cannot tell that case from an output simply waiting
on a resource this deploy will create, and before this field either one made
it drop the whole Outputs section. So the deploy records the skipped key
with a digest of its template inputs (`skippedOutputs` in
[state](state-management.md#skippedoutputs-informational-no-version-bump)), and
the diff previews the key as absent — no row, while its sibling outputs are
still compared as usual — as long as it is still absent from state and that
digest is unchanged.

Repair the output's `Value`, its `Export.Name`, or a parameter / condition /
mapping it reads, and the output is back under the ordinary preview rules —
usually an `ADD` row (an intrinsic `Export.Name` the diff still cannot resolve
keeps omitting the section, as before); the next deploy then publishes it if
the repair took, or records it again.

**Repairing the RESOURCE an output reads is the third way**, and the digest
cannot see it: `Resources` is deliberately not digested, or every unrelated
resource edit would discard the record. `cdkd diff` handles it from the other
side — an output whose `Value` or `Export.Name` references a logical id this
run's resource diff reports as changing does **not** use the record, because
the deploy that follows re-resolves every output and may publish that key.
Such an output falls back to how it behaved before this field existed: the
diff usually still cannot compute it from today's state, so the Outputs
section is omitted, with the "could not be resolved" warning when some other
output also differs. What you do not get is the record's silent "nothing to
do" over a key the deploy is about to publish.

How much of that you SEE depends on whether the output can be resolved at
diff time at all. An output reading an attribute of a resource that does not
exist yet stays unresolvable in both readings, so with no sibling output
differing the two print the same thing — an empty Outputs section — and the
rule moves the VERDICT, not the row; where a sibling does differ, it trades
the record's silent "nothing to do" for the "could not be resolved" warning
over the whole section, the sibling's row included. An output the diff CAN
resolve is the other case, and there the row is the difference: an output
whose `Fn::Sub` reads an SSM parameter's name, say, renders its `ADD` as soon
as the record stops binding, with no sibling involved.

That rule is deliberately coarse: it cannot tell a resource edit that repairs
the output from one that does not, so an unrelated edit to a referenced
resource — a tag, a description — also stops the record binding, and the
output can show as an `ADD` again. The cost is bounded to a diff that is
**already** reporting that resource's change, so `--fail` was going to exit `1`
either way; the alternative is hiding a row the deploy will publish.

One template value is excluded from the digest on purpose: a `NoEcho: true`
parameter's `Default` is hashed as a constant, so the record cannot become a
confirm oracle for a low-entropy one. That is not a claim the value is
otherwise absent from state — a parameter a resource reads can persist its
resolved default in that resource's properties — only that this field does not
add an oracle where there was none. Changing only such a default therefore
does not un-bind the record.

A repair the digest does not cover leaves the record binding. Four are
repairs outside its reach, and a fifth is the `NoEcho` default it declines
to hash on purpose, above. Two are outside the template and outside anything
`cdkd diff` looks up: the secret gained the JSON key, or the SSM parameter was
created. One is a nested stack's input VALUE changing on the parent's side,
which the diff does resolve but the digest does not hash, since hashing
supplied values would tie the record to a caller's arguments rather than to
the template. The last is **cdkd itself being upgraded** so that a provider
now builds the attribute an output reads. In all four the record clears on the
next deploy, and until then the deploy's own warning, where there is one, is
the signal for the broken output.

A repair on the RESOURCE side is deliberately not on that list: the rule above
declines the record whenever this run's resource diff reports the resource as
changing. That covers a repair the template carries, and only that. A state
rebuild OUTSIDE a deploy — `cdkd import`, `cdkd drift` in either direction,
`cdkd rollback`, `cdkd scrub`, `cdkd orphan` and `cdkd state refresh-observed`
— DROPS the record instead of carrying it forward. All but the last can change
the values an output's resolution reads while every resource still reports
`NO_CHANGE`; `refresh-observed` touches only `observedProperties`, which the
resolver does not read, and drops anyway on any run that refreshed at least
one resource, because the rule is flat (a run that refreshed nothing keeps
the record). The one writer that carries it is the partial snapshot a failed
`cdkd destroy` leaves: every resource it removed returns as a CREATE on the
next diff, which un-binds any record that references it.

That is the safe direction, not a free one, and it is worth being blunt about
what it costs. The key is resolved like any other output again, so **for the
shape this page is about — a failure inside a secret lookup — the phantom
`ADD` comes back**, and `cdkd diff --fail` exits `1` on the unchanged stack
until the next deploy rewrites the record. For a key the diff cannot resolve
either, it is handled like any other output that fails: the Outputs section is
omitted, or — when no resource change is pending and the failure is one the
deploy repeats — previewed through the merge described earlier on this page. Bounded on both counts: one deploy clears it, and the alternative is
the diff asserting that nothing is coming while the next deploy publishes the
key.

### What resolving Outputs costs

Resolving an output can issue AWS calls that the resource diff does not:

| Output uses | Call issued |
| --- | --- |
| `Fn::ImportValue` | CloudFormation `ListExports` (subject to `--no-cfn-fallback`) |
| `Fn::GetStackOutput` | CloudFormation `DescribeStacks` (subject to `--no-cfn-fallback`) |
| `Fn::GetAZs` | EC2 `DescribeAvailabilityZones` |
| `{{resolve:ssm:...}}` | SSM `GetParameter`, issued with `WithDecryption: false` |
| `Fn::GetStackOutput` carrying a `RoleArn` | A cross-account `sts:AssumeRole` |

The `RoleArn` must be a template literal, so it is never attacker-selectable.

### Withheld previous values

`cdkd diff` is the only command that prints a **stored** output value, so two
safeguards apply to that side of the output.

**A previous value that may be legacy secret plaintext is withheld** from both
the text and the `--json` output rather than printed into CI logs. The change
itself is still reported; only the old value is replaced with a placeholder
pointing at [`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit).
These refusal gates decide this:

| Gate | Trigger | Scope |
| --- | --- | --- |
| Redacted-expression mismatch | The template side is still a `{{resolve:...}}` expression while state is not — exactly what `cdkd scrub` repairs. | Record-wide |
| Template-declared dynamic reference | The template declares the output's value as a dynamic reference. Also covers an output that was condition-skipped, which has no template side left to compare. | Record-wide |
| Unaccountable stored key | A stored key today's template cannot account for — no declared output name, no literal `Export.Name`, not in the resolved bag — i.e. an output deleted from the template. | Per-key |
| Carried value in the merge preview | The no-change merge preview carried a value from state for a failed output, an alias included, that is not a secret reference. | Record-wide |

The first two are record-wide because a record holding any such key was written
by a pre-redaction binary, so every previous value in it is suspect. The merge
preview's gate is record-wide for the same reason from the other side: the diff
never learns what a failed output would have resolved to, so a carried value
that is not a secret reference cannot rule that out.

The per-key gate is narrower on purpose, since deleting an output is an
ordinary refactor. It fires **only** when the template still proves a secret
reference somewhere, and **not** when any stored value is itself a secret
expression — the latter is read as evidence that the last write already
redacted the whole bag, which holds for a full deploy and is not guaranteed for
every earlier write. Those two conditions are what keep the refusal off stacks
that handle no secrets at all.

For a nested child **removed** from its parent's template there is no template
left to account for anything, so the refusal applies to that child's whole
stored bag whenever the parent's template proves a secret reference. That
population is repairable by
[`cdkd scrub`](cli-scrub.md#cdkd-scrub-state-secret-hygiene-clean-audit); the
refusal here is unchanged, because `diff` still cannot decide from a stored
string alone whether a value is plaintext.

**Second, output and export names and rendered values are stripped of control
and bidi characters before display.** An `Export.Name` is a value cdkd resolved
(from an `Fn::Sub`, a parameter, an SSM lookup), so unlike a CloudFormation
logical ID it never passed a validator. The `--json` payload is deliberately
left byte-faithful — it is a machine interface, and mutating a name a consumer
matches on would be worse than the display concern it would avoid.

## When the state record is malformed

A state record is read as JSON and used as typed data without a field-by-field
shape check, so a hand-edited or truncated one can hold anything where a map
belongs. `cdkd diff` never writes state, so it **repairs** each container it walks
rather than refusing, and warns about each one it repaired — once per stack,
except for the `properties` case noted below, which can warn twice. A single
unreadable ENTRY is dropped rather than repaired, for the reason below the
table:

| Container | Read as | What the preview then shows |
| --- | --- | --- |
| `resources` | empty | Every resource the template declares previews as a `CREATE` |
| `outputs` | empty | Every output this diff resolves previews as an `ADD`, and no stored key previews as a `REMOVE` |
| A resource's `properties` | empty | Every property that resource declares previews as an addition, and a create-only one previews as a **replacement** |
| `orphans` | empty | No rollback-orphan record previews as an adoption, and `(orphans container)` is named in the preview, in `--json`'s `unreadable` and in the `--fail` count |
| One `resources` entry, or one `orphans` record | DROPPED | The row is named in the preview, in `--json`'s `unreadable` and in the `--fail` count; a row the template still declares previews as a `CREATE`, one it no longer declares gets no row at all |

"Unreadable" is decided per container against the shape that container holds.
For the three MAPS it is anything that is not a JSON object: a string, a list,
a number, a boolean or `null`. `orphans` is a **list**, so there it is the
mirror image — a string, a number, an object, a boolean or `null` — and a list
is the healthy shape. A healthy container is untouched and nothing is said
about it, and an empty `{}` (or an empty `[]`) is a healthy container — a stack
can legitimately hold no resources, publish no outputs, or carry no orphans.

An **absent** `outputs` or `orphans` field is the exception: it reads as empty
and says nothing, because a record with no outputs is one cdkd writes and
[`cdkd scrub`](cli-scrub.md) preserves, and a stack that has never had a failed
deploy has no orphan list at all. An absent `resources` map is a defect and does
warn — a stack always has a resource map, even an empty one.

Reading it as empty is the safe answer for a preview, and the warning is what
keeps it honest. Without the repair the walk over each container takes a string
or a list as readily as a map: a planted `"abcdef"` in `resources` renders six
resources that do not exist, and in `outputs` it produces one `REMOVE` row per
character, each printing a character of the record as its previous value — rows
`--fail` would exit `1` on.

Every one of these warnings points at
`cdkd state show <stack> --stack-region <region> --json`, which emits the record
as stored, so the evidence survives the repair. The `resources` warning
additionally says that `cdkd deploy` and `cdkd destroy` **refuse** such a
record: they read the same map, an unreadable one is indistinguishable from an
empty stack, and acting on that reading would make a deploy re-create every
resource and a destroy delete none of them. So a `resources` preview that
renders is followed by a refusal from either of those commands — see
[when `resources` is not an object](state-management.md#when-resources-is-not-an-object).
The `outputs` warning costs this preview's Outputs
section, and it costs more than the preview: `cdkd deploy` and `cdkd destroy`
refuse a record whose `outputs` map is unreadable rather than deciding from it,
so a diff that previews cleanly is followed by a refusal. See
[when `outputs` is not an object](state-management.md#when-outputs-is-not-an-object).

The `orphans` warning costs this preview's rollback-orphan adoption, and it
costs the same thing beyond the preview: `cdkd deploy`, `cdkd destroy`,
`cdkd rollback`, `cdkd import` and a real `cdkd scrub` all refuse a record whose
`orphans` field is present and not a list, because such a field either counts as
no orphans — leaving the resources an earlier failed deploy left live in AWS
unreported, or rewritten into character-shaped records by a rollback — or aborts
the command outright with no cause named. See
[when `orphans` is not a list](state-management.md#when-orphans-is-not-a-list).

The `properties` warning names the individual resource
records it emptied — up to five of them, then a count. It costs more than the
section or the preview each container-level warning costs: the rows for those
resources are still printed, and they are wrong. Where the template still declares the resource, its every
declared property reads as an addition against the empty map and a create-only
one renders as a replacement; where the template no longer declares it — a
removed nested child under `--recursive` is diffed against an empty template —
the `DELETE` row shows an empty previous side instead of what the record holds.
So that warning says explicitly not to act on the preview, and that `cdkd
deploy` refuses the record rather than performing those replacements. See
[when a resource `properties` map is not an object](state-management.md#when-a-resource-properties-map-is-not-an-object).

The same repair runs a second time on a stack that adopts a rollback orphan:
those records come from a different part of the file and are spliced in after
the load, so a torn one is emptied and named there too. An orphan record that
is not readable as a resource at all — not an object, or carrying no resource
type — is dropped before adoption is previewed, named with the dropped rows
below, and counted the same way; a `null` one used to abort the command.

A single `resources` **entry** that is not an object, or carries no resource
type, is not repaired but **dropped** from the record the diff reads, with or
without `--recursive`, and a warning names its logical id. Nothing says what AWS
resource such a row names, so there is no honest empty version of it. Dropping
happens before the `properties` repair, so a typeless row whose `properties` map
is also unreadable is reported once, as dropped. A dropped row the template
still declares previews as a `CREATE`; one it no longer declares gets no row at
all. So the dropped rows, `(resources map)` for an unreadable map and
`(orphans container)` for an unreadable orphan list, are also named together on
one line after the counts — up to ten names, then how many more — listed in full
in `--json`'s `unreadable`, and counted by `--fail`.

With `--recursive` each node of the tree carries its own record, so the warning
names the stack it came from and a healthy parent can sit above a malformed
child.

### `exportNames`, which is a list rather than a map

The record also carries `exportNames` — the `outputs` keys that are
`Export.Name` aliases (state schema v9+). That one is a **list**, not a map, so
it is none of the containers repaired above and takes its own rule.

A non-array `exportNames` reads as an **empty export set**: the diff runs, and
no stored key is reported as an export. It is deliberately not read as
*unknown* — an absent `exportNames` means "not known" and falls back to the
pre-v9 rule where every output key is importable, so taking that branch for a
corrupt one would report every plain output name as an export.

`cdkd diff` **warns** when it takes that branch, naming the stack and region.
The rule itself lives in a predicate shared with the exports index, the
deploy-time resolver and the `cdkd local` commands, and that predicate stays
silent — it holds no stack name to put in a message. `cdkd diff` does hold one,
so it says so rather than letting a loud failure become a quiet wrong answer.
The warning is suppressed when the record's `outputs` bag is itself unreadable,
since that is reported on its own and the `exportNames` line would just blame
the wrong field.

## `--fail`

`--fail` exits `1` when any change is detected, matching `cdk diff --fail`. An
Outputs-only change counts, and so does a state record row the diff could not
read (described under [when the state record is malformed](#when-the-state-record-is-malformed)) — the preview is not
complete for such a stack. Without the flag, `cdkd diff` always exits `0` even
when changes are present, which is `cdk diff`'s default too.

With `--recursive`, `--fail` considers the whole nested-stack tree, so CI can
gate on tree-wide drift with a single command:

```bash
cdkd diff ParentStack --recursive --fail
```

## `--json`

`--json` emits the diff as JSON instead of human-readable text. Progress
logging is suppressed so stdout carries only the payload.

The payload is a flat array of one record per target stack:

```json
[
  {
    "stack": "MyStack",
    "region": "us-east-1",
    "changes": [
      {
        "logicalId": "ApiFunction",
        "changeType": "UPDATE",
        "resourceType": "AWS::Lambda::Function",
        "propertyChanges": [
          { "path": "Timeout", "oldValue": 3, "newValue": 30, "requiresReplacement": false }
        ]
      }
    ],
    "outputChanges": [],
    "unreadable": [],
    "children": []
  }
]
```

- `NO_CHANGE` resources are omitted.
- `children` and `outputChanges` are **always present** — empty on leaves and
  when the Outputs section is unchanged — so the key set is stable.
- With `--recursive`, `children` is populated with the same record shape,
  recursively.
- `propertyChanges` and `attributeChanges` appear on a change entry only when
  non-empty.
- `unreadable` is **always present**: the logical ids of state record rows the
  diff could not read, `(resources map)` when the whole `resources` map is
  not an object, `(orphans container)` when the whole `orphans` field is
  present but not a list, and each rollback-orphan record the adoption preview
  could not read (an empty string for one with no usable id). Non-empty means `changes` is not the whole picture: a row the
  template still declares appears there as a `CREATE`, but one it no longer
  declares gets no change entry at all, not even a `DELETE`.
- A change entry carries `ccApi: string[]` when the resource would auto-route
  via Cloud Control API on the next deploy — the machine form of the
  `[via CC API: <props>]` annotation. It is absent when the resource routes via
  its SDK provider.

Each `outputChanges` entry is
`{name, changeType: "ADD" | "MODIFY" | "REMOVE", oldValue?, newValue?, oldValueRedacted?, export}`.
`oldValue` is absent on an `ADD` and `newValue` on a `REMOVE`; `oldValue` is
also withheld — with `oldValueRedacted: true` in its place — when state may
hold legacy secret plaintext for that key, which includes every row beside a
failed output whose value carried from state, an alias included, is not a
secret reference (see [Outputs](#outputs)).

## `--recursive` (nested stacks)

By default `cdkd diff` does not descend into nested stacks, matching
`cdk diff`: the parent's `AWS::CloudFormation::Stack` row shows up as a single
`TemplateURL` / `Parameters` change and nothing below it is inspected.

`--recursive` walks into every `AWS::CloudFormation::Stack` row in DFS order and
diffs each nested child against its **own** deployed state at
`cdkd/<parent>~<childLogicalId>/<region>/state.json`. Each child's block is
printed under a `Nested stack: <name>` header carrying the full `~`-joined state
name, matching `cdkd state show --show-nested`. Children with no changes are
walked silently, so the output shows only what the next deploy would do.

The walk previews the full next deploy:

- A nested child with **no state file yet** diffs as all-CREATE.
- A nested stack **removed from the CDK code** — present in state, absent from
  the template — diffs as all-DELETE, recursively.
- A child whose record is **malformed** is reported on rather than aborted on,
  at every depth. A `resources` bag that is not a JSON object, and an `orphans`
  field that is present but not a list, are treated as
  empty, and a `resources` entry that is not an object, or carries no resource
  type, is dropped from the
  record the diff reads; each emits a warning naming the stack, the region and,
  for entries, the logical ids. Dropping is not the same as hiding: a dropped
  row whose logical id the template still declares previews as a **CREATE**,
  because the diff now has no record of it — the same thing an empty bag does to
  a whole stack. A dropped row the template no longer declares gets **no row at
  all**, not even a DELETE, because nothing says what resource it names. So
  the dropped rows, `(resources map)` for an unreadable map and
  `(orphans container)` for an unreadable orphan list, are also named
  together on one line after the counts — up to ten names, then how many more —
  listed in full in `--json`'s `unreadable`, and counted by `--fail`. `cdkd diff` never writes state, so nothing is lost either way,
  but the preview is about a record cdkd could not read. Inspect it with
  `cdkd state show <stack> --json` before acting on the diff.

### Cyclic nested templates are refused

Each nested child is located through its `Metadata['aws:asset:path']`, and the
walk refuses when that path resolves to a template already being diffed higher
up the same nesting chain:

```text
Nested stack 'Child' under stack 'Parent~Child' resolves to nested template
'/path/to/cdk.out/child.json', which is already being diffed higher up the
same nesting chain. Its Metadata['aws:asset:path'] closes a cycle; CDK emits
an acyclic nested template tree, so this indicates the synth output was
hand-modified or generated by a non-CDK toolchain. Refusing to diff.
```

CDK emits an acyclic tree, so a well-formed `cdk.out` never reaches this. The
refusal covers a hand-modified or non-CDK-generated assembly, and the error
names the row and the file that closed the cycle.

It fires at the first repeated template, with one exception: a cycle that
returns to the stack's own top-level template is caught one level further down,
because that template is reached by name rather than by a nested asset path.
The refusal is the same; only the row it names differs.

It is a refusal rather than a truncation because a cyclic assembly has no
correct diff to render, and a partial one would under-report changes the next
deploy would still make. The command exits `1`.

Two sibling rows naming the **same** template are fine — that is a shared child,
not a cycle. Only a repeat along one root-to-child path is refused, so nesting
depth itself is never limited.

## List-typed parameters in `Fn::Equals`

> **A list-typed parameter compared against a string in `Fn::Equals` is always
> unequal, and a resource gated on that condition is pruned — which means the
> next deploy DELETES it.** Run `cdkd diff` and read the DELETE lines before
> deploying if you gate resources on a list-typed parameter.

A `Ref` to a list-shaped parameter resolves to an **array**, and `Fn::Equals`
compares its two sides structurally. So for a `List<String>` parameter `Envs`
defaulting to `prod`:

```yaml
Fn::Equals: [{ Ref: Envs }, 'prod']     # FALSE — ["prod"] is not "prod"
Fn::Equals: [{ Ref: Envs }, ['prod']]   # TRUE  — compare against a list
```

That is the correct answer for a list-valued `Ref`. To make the condition true,
either compare against a list as above, or declare the parameter
`Type: String`.

This is a property of the deploy path, not of nested stacks or secrets — it
applies wherever a list-shaped parameter feeds a condition. `cdkd diff` previews
the resulting delete before any apply, which is the point of checking it first.

## Nested stacks and secret references

This section covers `--recursive` over a tree whose nested-stack input
parameters are fed by SECRET dynamic references. If your app has none of those,
none of it applies.

A child input parameter fed by a secret dynamic reference is **not decrypted at
plan time**. The parent's `Parameters` value is carried down as its
`{{resolve:...}}` expression, which is also what the child's state holds, so the
two sides compare expression-against-expression and no plaintext appears in the
output.

A redacted token is not a usable value, and two consequences follow. Both are
deliberate.

### How the token is compared

The token is cast by the child parameter's declared `Type` **only where every
part of it stays a string**, so the comparison matches what the child's state
actually holds:

| Declared `Type` | Compared as |
| --- | --- |
| `String` | The token, uncast. |
| The AWS-specific scalar types | The token, uncast. |
| The whole `AWS::SSM::Parameter::Value<...>` family | The token, uncast — the value is a Parameter Store key, not the resolved list. |
| `CommaDelimitedList` and every other `List<...>` type | Split on `,` into an array of expressions, mirroring what the deploy split before redacting. |
| `Number` / `List<Number>` | The token, uncast — casting yields `NaN` (an array of them for `List<Number>`), which matches neither side and would diff forever. |

The population of splitting types is the **family** — any `List<...>` type, plus
`CommaDelimitedList` itself — rather than a fixed list of names;
`List<AWS::EC2::Subnet::Id>`, `List<AWS::EC2::SecurityGroup::Id>` and
`List<String>` are examples of it. The line falls where it does because cdkd's
secret redaction is string-keyed end to end: a shape whose parts are all strings
stays inside that model, and a number does not.

A split reference survives as **one** element as long as it carries no comma of
its own. That holds for the secret id, the parameter name and the version stage,
and **not** for the JSON-key slot —
`{{resolve:secretsmanager:sec:SecretString:a,b::}}` splits into two. A parameter
fed such a reference reports a phantom change on every
`cdkd diff --recursive`. Nothing is written and no plaintext is exposed by it.

`cdkd diff` additionally warns for any parameter whose declared `Type` **could**
lose the plaintext under coercion, because `cdkd deploy` refuses that parameter
when the coercion actually destroys it.

### Condition pruning is skipped

A child stack is **not condition-pruned** on that run when one of its
`Conditions` transitively references a token-valued parameter. `cdkd deploy`
evaluates its conditions against the real values, so a verdict computed over an
expression could flip an `Fn::Equals` and report a phantom CREATE or DELETE of a
condition-gated child resource. The whole child template is diffed instead,
which is the same fallback an unbindable parameter already takes.

The skip is scoped to conditions that actually depend on such a parameter.
Leaving the condition map unevaluated would also make every `Fn::If` in a
property value take its FALSE branch, so a template whose conditions mention no
secret parameter is evaluated and pruned exactly as it would be without a secret
in the tree.

### Secret parameters must be `Type: String`

A nested-stack input parameter fed a secret dynamic reference must be declared
`Type: String`, or a list-shaped type — `CommaDelimitedList` or any `List<...>`
type — with the comma caveat below. `cdkd deploy` **refuses** a `Type: Number` /
`Type: List<Number>` parameter in that position, naming the parameter:

```text
Nested-stack parameter 'DbPort' is declared 'Type: Number', but the parent
stack resolved a SECRET dynamic reference into it. ...
```

cdkd keeps a resolved secret out of persisted state by rewriting **string**
leaves back to their `{{resolve:...}}` expression. Casting the value to a number
takes it out of that model, so the child stack's `state.json` would keep the
decrypted secret with nothing to redact it back to — the very disclosure this
refusal exists to prevent. Refusing names the problem; silently persisting the
plaintext does not.

CDK synthesizes every nested-stack cross-reference parameter as `Type: String`,
so a CDK app never hits this.

A list-shaped type is allowed **only while the secret itself carries no comma**,
and the refusal is decided by measuring the actual value rather than by the
declared type alone. Splitting on `,` shreds a comma-bearing secret into
fragments that no longer match the plaintext, so the same refusal fires and
names the declared type. That is the dominant Secrets Manager shape — a JSON
blob is nothing but commas — so a list-typed secret parameter is usable only for
a bare token value. This applies to every list-shaped type alike, because the
refusal asks the coercion what it destroyed rather than consulting a list of
type names.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | The diff was computed. This is the exit code even when changes are present, unless `--fail` was passed. |
| `1` | `--fail` was passed and something changed, or the command itself failed. |
| `3` | The diff was computed AND `cdkd deploy` would refuse to start. |

The failures behind the second meaning of `1` are a synth crash, an auth error,
an unresolvable cross-stack reference, no stack matching the patterns you gave,
more than one stack in the app with no selection given, and — under
`--recursive` — a nested template whose asset path closes a cycle.

`cdkd diff` never exits `2`. That code means partial failure, which is a
property of commands that mutate AWS.

### Exit `3` — the deploy would refuse

The preview is complete when this fires: every resource row, every Outputs row
and every nested stack is printed first, and the reasons follow under a
`Blocking (cdkd deploy will refuse):` heading. `cdkd deploy` stops at the same
condition — but it stops because there is nothing left for it to do, while a
preview that died before printing would be a preview you could not use to
decide anything.

Today there is one such condition: a rollback left a `DeletionPolicy: Retain`
resource behind, cdkd recorded it so the next deploy could re-adopt it, and the
physical name in that record is one ANOTHER cdkd stack's state already claims.
Adopting it would put one physical id in two state files, and either stack's
`cdkd destroy` would then delete the other's live resource, so cdkd refuses.
Resolve the ownership conflict — usually by removing the resource from
whichever stack should not own it — and the next `cdkd diff` exits normally.

It is deliberately NOT `1`. `--fail` uses `1` to mean "something changed", and
a refusal is not a change: a CI job gating on drift must be able to tell "there
is work to do" from "the work cannot begin". It is not `2` either — that code
means re-running typically resolves it, and this one does not change until a
person acts.

Distinguish the two meanings of `1` by whether the diff report was printed
first: `--fail` prints the full report and then exits `1`, while a command
failure prints an error.

## Related

- [Deploy: waits & concurrency](cli-deploy.md) — applying what this previews
- [Deploy: safety & compatibility flags](cli-deploy-safety.md) — `--no-cfn-fallback` and the other guards
- [`cdkd drift`](cli-drift.md) — compare state against what AWS actually holds
- [`cdkd scrub`](cli-scrub.md) — repair state records holding plaintext secrets
- [Cross-Stack References](cross-stack-references.md) — how `Fn::ImportValue` and `Fn::GetStackOutput` resolve
- [CLI Reference](cli-reference.md) — the flags every command shares
