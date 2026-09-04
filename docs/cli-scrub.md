---
title: cdkd scrub
description: "State secret hygiene — clean secrets out of persisted state and audit it with cdkd scrub."
---

# cdkd scrub

`cdkd scrub` rewrites persisted cdkd state so a resolved secret is stored as
its `{{resolve:...}}` expression instead of its plaintext value, and audits
that state stays that way. Reach for it after upgrading cdkd on a stack you do
not want to re-provision, whenever you suspect a state file predates a
redaction fix, and as a standing CI gate. It touches no AWS resources — only
`state.json` is rewritten.

```bash
# Rewrite state so plaintext secrets become their {{resolve:...}} expression
cdkd scrub MyStack

# Report what would change without writing state
cdkd scrub MyStack --dry-run

# CI gate: exit 1 if any plaintext secret remains in state
cdkd scrub MyStack --dry-run --fail

# Every stack in the synthesized app, producers before consumers
cdkd scrub --all

# Explain a stack that reports clean when you expected findings
cdkd scrub MyStack --verbose
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to scrub. Physical name or CDK display path. |
| `--all` | off | Scrub every stack in the synthesized app. |
| `--dry-run` | off | Report what would be scrubbed without writing state. |
| `--fail` | off | Exit non-zero when plaintext is found. With `--dry-run`, any plaintext at all; on a real run, a leak scrub cannot rewrite. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket holding the state records. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Accepted for consistency with the other mutating commands; `cdkd scrub` asks no confirmation, so it changes nothing. |
| `--verbose` | off | Verbose logging. Turns on the per-read detail behind a stack that reports clean. |

`--region` is deprecated — prefer `AWS_REGION` or your AWS profile — but it is
still honored if passed, and it is not a no-op.

`cdkd scrub` takes no `--parameters`, which is load-bearing in two places
below: which `Fn::If` branch it evaluates, and which `Export.Name` values it
can compute.

## `cdkd scrub` (state secret hygiene: clean + audit)

Two modes, both useful long after any one-time cleanup:

- **Clean** — rewrite existing state in place, WITHOUT redeploying. This is
  what you run after upgrading cdkd on a stack you do not want to
  re-provision, or any time you suspect a state file predates a redaction fix.
- **Audit** — `--dry-run --fail` exits `1` when any plaintext secret is still
  in state, so it works as a standing CI gate rather than incident-only
  tooling. Secrets landing in infrastructure state is a structural, recurring
  concern — the same class Terraform has — so it is worth asserting
  continuously.

```yaml
# CI: fail the build if any cdkd state file holds a plaintext secret.
- run: cdkd scrub --all --dry-run --fail
```

A normal `cdkd deploy` scrubs state this way as a side effect, so a green gate
is the expected steady state rather than something you have to maintain.

## How secrets stay out of state

cdkd resolves CloudFormation dynamic references —
`{{resolve:secretsmanager:...}}`, and `{{resolve:ssm:...}}` pointing at a
**SecureString** parameter — to their concrete value so the secret can be
handed to the AWS API on create or update. When it PERSISTS state, it stores
the UNRESOLVED expression rather than the resolved plaintext, so the secret
never lands in `state.json`, `cdkd state show`, `cdkd diff` or `cdkd drift`
output.

This matches CloudFormation, which keeps the reference in the template and
resolves it service-side. Two consequences follow: a rotated secret behind an
unchanged reference is a no-op on the next deploy, again matching
CloudFormation, and `cdkd diff` makes no live secret fetch.

## What scrub needs, and what it changes

**It needs the CDK app.** Unlike the `cdkd state ...` family, `scrub` requires
`--app` (or `CDKD_APP` / `cdk.json`), because a state file records the
resolved value with no marker of which values are secrets — only the template
carries the `{{resolve:...}}` references.

So `scrub` synthesizes the template, re-resolves each resource's properties to
learn the resolved secret VALUES — recorded in memory, never printed and never
re-persisted — and replaces those values in the state record's `properties`,
`attributes` and `observedProperties` with the expression.

It performs no AWS create, update or delete. Only `state.json` is rewritten,
under the stack lock.

## Multi-stack runs (`--all`)

`cdkd scrub --all` scrubs **producers before consumers**, using CDK's own
stack dependencies plus raw `Fn::ImportValue` / `Fn::GetStackOutput` edges
inferred from the templates. One run therefore normally scrubs a producer and
then resolves its expression in the consumer.

A refusal is per stack: the remaining stacks are still scrubbed, and the run
ends non-zero naming the ones it could not examine. The summary line never
counts a stack the run could not reach.

`--dry-run` writes nothing, so the producer is never rewritten — a dry run
over a not-yet-scrubbed producer is exactly where the producer-plaintext
refusal below is expected.

## Rotate the secret — and scrub first

**Scrubbing does not un-expose an already-leaked secret.** A value that was
ever stored in plaintext should be treated as compromised and ROTATED in
Secrets Manager; `scrub` only stops it being read back out of state going
forward.

**Run `scrub` BEFORE rotating.** It matches the CURRENT resolved secret value
against what state holds, so once the secret is rotated the stale value in
state no longer matches and `scrub` reports nothing to scrub. The rotation
invalidates the stale value; a redeploy then rewrites the record with the
expression.

## Example output

A stack that held plaintext:

```text
$ cdkd scrub MyStack
Scrubbed 3 resource record(s) in MyStack

Done: scrubbed 1 stack(s). The plaintext is no longer stored there, but a value that
was ever persisted should be treated as compromised — ROTATE it in Secrets Manager
(scrub matches the current value, so scrub BEFORE rotating).
```

A CI gate that fails:

```text
$ cdkd scrub --all --dry-run --fail
No plaintext secrets found in ApiStack
Would scrub 2 resource record(s) in DbStack

Plan: 1 stack(s) hold plaintext secrets and would be scrubbed (--dry-run, no state
written). ROTATE any exposed secret in Secrets Manager.
```

A CI gate that passes:

```text
$ cdkd scrub --all --dry-run --fail
No plaintext secrets found in ApiStack
No plaintext secrets found in DbStack

No plaintext secrets found in any target stack state. Nothing to scrub.
```

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | State was scrubbed, or there was nothing to scrub. |
| `1` | `--fail` found plaintext: under `--dry-run`, any plaintext at all; on a real run, a leak scrub cannot rewrite. |
| `2` | scrub refused to examine something, or a stack failed outright. |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

The two non-zero codes call for opposite responses, which is why they are
distinct: `1` means scrub looked and found a leak (rotate the secret), while
`2` means scrub declined to look (fix the reference and re-run).

**What a real run can report as `1`.** `--fail` is documented as a
`--dry-run` CI gate, but a real run exits non-zero too when it found a leak it
cannot rewrite. Two shapes qualify, and both are also reported in words:

- a **state KEY** holding a secret, which needs an `Export.Name` change plus a
  redeploy: `N output KEY(s) in <stack> hold plaintext and CANNOT be scrubbed`;
- a **cross-stack read cdkd declines by design**:
  `N cross-stack read(s) in <stack> could NOT be verified`.

## Refusals

Four error codes stop a stack rather than reporting it clean. All exit `2`.

| Code | What triggers it | What to do |
| --- | --- | --- |
| `SCRUB_CROSS_STACK_READ_UNRESOLVED` | An `Fn::ImportValue` / `Fn::GetStackOutput` the pre-pass could not resolve. | Deploy the producer stack, or correct the reference, then re-run. |
| `SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT` | The read succeeded, but the producer's own state still stores the plaintext instead of the expression. | `cdkd scrub <producer>` first, then re-run. For a chain, every stack in it, head first. |
| `SCRUB_CROSS_REGION_SECRET_UNRESOLVED` | A secret reference whose ARN names another region could not be read in that region. | Grant the read there, or restore the secret. scrub will not fall back to the stack's own region. |
| `SCRUB_STACKS_FAILED` | Under `--all`, one or more stacks ended in one of the above. | Fix each named stack; the others were still scrubbed. Each stack's own reason was logged as it happened. |

Everything else the per-item best-effort handler swallows is unchanged: a
`Ref` to a resource absent from state still degrades to a partial scrub rather
than failing the run, which is what that handler is for.

### A cross-stack read that cannot be resolved

`scrub` learns which plaintexts to hunt for by re-resolving the template, so a
leaf that arrives through `Fn::ImportValue` / `Fn::GetStackOutput` yields a
needle only if the producer's state can actually be read. With no needle,
nothing matches, and the command would report no plaintext found over state
that may still hold it.

Such a read is therefore attempted before the main pass, and a failure refuses
the stack, naming the resource or output it could not resolve. A stack whose
producer state is unreadable — a deleted producer, a cross-account export, a
missing state file — exits `2`.

A conditional import does NOT refuse when its branch is not taken: the
pre-pass walks `Fn::If` the way the resolver does, selected branch only.
Neither does an `Fn::ImportValue` inside an output that this run's conditions
SUPPRESS — such an output wrote no state key, so there is nothing behind it to
protect.

### Which `Fn::If` branch scrub selects

Branch selection is evaluated against the template's **default parameter
values**. `scrub` takes no `--parameters`, so it has nothing else to evaluate
a `Conditions` entry with, and a condition it cannot evaluate reads as false.

For a stack deployed with NON-default parameters, that means scrub can pick a
branch the deploy never took. In a RESOURCE position a cross-stack read on
that branch still refuses, so the stack can be refused over a producer that
legitimately does not exist for the parameters it was actually deployed with.

An output position is spared this: `state.outputs` records what the deploy
really wrote, and a key absent from it disarms the refusal. There is no
equivalent record for a resource-position branch, so the remedy is to make the
read resolvable — deploy or scrub the producer that branch names, which
`cdkd scrub --all` does in one run — rather than to re-run unchanged.

The same branch selection decides whether the PRODUCER's export counts as
secret-bearing at all, so one selection feeds both halves of the question.

### A producer that still stores the plaintext

`scrub` can only replace a stored plaintext with the `{{resolve:...}}`
expression the PRODUCER holds. A producer whose own state has not been
scrubbed yet still holds the plaintext itself, so the read succeeds, there is
no expression to write, and the consumer would be reported clean over a record
that still holds the secret.

The verdict is taken by READING the producer's own stored value, not by
inspecting what the read returned: the read RESOLVES a stored expression to
plaintext before handing it over, so a healthy producer and an unscrubbed one
are indistinguishable from the consumer's side. The refusal names the producer
and the fix.

### Which exports count as secret-bearing

Whether the export is secret-bearing at all is the half of the question the
stored value cannot answer — a bucket name and a leaked password are both bare
strings, so refusing on the stored value alone would refuse every multi-stack
app that imports anything. That half is taken from the app's TEMPLATES, and
the refusal fires only when they say the value carries a secret:

- the producer declares that export from a `{{resolve:...}}` expression; or
- the producer RE-EXPORTS a value that a stack further up the chain declares
  from one.

Both arms read the export through the `Fn::If` branch selection above, so an
expression sitting only in a branch this run does not select answers neither
of them: a secret reachable only through that branch is not detected. An
ordinary import of a bucket name or an ARN is unaffected under either arm.

The chain arm is not a refinement. A middle stack's output IS the
`Fn::ImportValue`, so asking that one template alone answers "not
secret-bearing", and `cdkd scrub <the stack at the end of the chain>` would
then report clean over its own surviving plaintext. The walk follows
`Fn::ImportValue` / `Fn::GetStackOutput` through the synthesized templates and
terminates on a cycle by never revisiting a `(stack, export)` pair. For a
chain the remedy names EVERY stack in it, head first, because a middle stack
cannot store the expression until its own producer has been scrubbed.

Four shapes stay unclassifiable from the consumer's side and are NOT refused:

- a producer outside the synthesized app;
- one whose export cdkd resolved through CloudFormation rather than through
  cdkd state;
- a re-export whose upstream reference cannot be read statically — an
  assembled export name, or an `Fn::GetStackOutput` whose stack or output name
  is itself an intrinsic;
- one whose upstream export is declared under a name this run cannot
  reproduce, which usually means an intrinsic `Export.Name` one hop up, so a
  stack DOES declare it and the walk simply cannot match it.

When the DIRECT producer's `Export.Name` is an intrinsic this run cannot
reproduce, the check widens to every output of that producer — an
over-approximation in the safe direction, and the message says so rather than
claiming the producer declares that particular key from an expression.

The asymmetry between that widening and the dropped case one hop up is
deliberate. At the root the key came from an actual read, so some output of
that producer really did answer it, and refusing over the set is the safe
reading. One hop up the key is a literal name read out of a template, so a
miss means that template does not declare it, and widening there would refuse
the consumer over an unrelated secret two stacks away in a refusal no
`cdkd scrub` could clear.

### Assembled references and cross-region secrets

A reference the intrinsics build out of parts — an `Fn::Sub` placeholder
inside it, an `Fn::Join` that splits it — does not exist as a complete
expression until it is resolved, so scrub's region pre-pass cannot classify it
and hands it to the resolver instead of refusing. The resolver decides the
region AFTER assembly and either routes the read to the region the ARN names
or refuses it as ambiguous.

**Known residual: if the downstream lookup then FAILS, the stack can still be
summarised as CLEAN.** Two shapes reach it, and they are not equally loud:

- a region that refuses the read — a denied `GetSecretValue`, a deleted secret
  — is reported only at `--verbose`;
- an `Fn::Sub` placeholder `scrub` cannot evaluate does print a
  `keeping placeholder` warning at default verbosity.

Neither stops the summary line. The complete-token spelling of the first is
loud (`SCRUB_CROSS_REGION_SECRET_UNRESOLVED`, exit `2`), so the two disagree.
Run `cdkd scrub --verbose` when a stack you expect findings from reports
clean.

### A read cdkd declines by design is a finding, not a refusal

The cross-account `Fn::GetStackOutput` of a redacted value is never resolved:
cdkd will not look up a producer account's secret with the consumer's
credentials. That read cannot be made to succeed by re-running, so refusing
the whole stack would strand every other secret in it.

Instead the stack is scrubbed for everything else, the read is reported
(`N cross-stack read(s) in <stack> could NOT be verified`), the summary says
so, and `--fail` exits non-zero — the same treatment a secret-bearing output
KEY gets. That treatment is scoped to THAT ONE read.

Other refusals the resolver raises deliberately — a stale placeholder ARN, an
unresolvable account id, an unenriched `Fn::GetAtt`, `--strict-getatt`, a
malformed `Fn::Split` — are all things you can FIX in the template, so they
refuse the stack (exit `2`) with the resolver's own message, and a re-run
after the fix scrubs it. They are reachable here whenever the reference's
export name is built by an `Fn::Sub` over one of them.

## SSM parameters are redacted by type, not by spelling

The plain `{{resolve:ssm:...}}` form resolves with `WithDecryption`, so it
yields a real secret whenever the parameter is a `SecureString` — the same
disclosure class as `{{resolve:secretsmanager:...}}`. cdkd reads the
parameter's `Type` off the same `GetParameter` response that carries the value
and treats the two cases differently:

| Parameter `Type` | Treatment |
| --- | --- |
| `SecureString` | Handled exactly like a Secrets Manager reference: the decrypted value goes to the AWS API, state stores the `{{resolve:ssm:...}}` expression, and `cdkd scrub` cleans it out of state written by an older cdkd. |
| `String` / `StringList` | Public config, stored RESOLVED in state, so a parameter-backed property is not a perpetual spurious UPDATE. |

On the diff and no-op comparison path cdkd still has to learn the type, so it
issues `GetParameter` with `WithDecryption: false`. A `SecureString` comes
back as its encrypted blob, which is never substituted, cached or persisted,
and the comparison stays expression-versus-expression. Once a reference is
known to be `SecureString`, later comparisons short-circuit with no AWS call
at all.

## What gets redacted inside a record

### Two spellings of one secret value

Two dynamic references that resolve to the SAME value — the same JSON key
written once with and once without an explicit version stage, for example —
must each keep their own expression, or both sites persist whichever
expression was recorded last and the stack reports a spurious UPDATE on every
deploy. No plaintext is exposed by that; the wrong EXPRESSION would be stored.

cdkd therefore redacts by POSITION as well as by value: each leaf is matched
against the UNRESOLVED template at the same path, so it keeps its own
expression. Where the template leaf is an intrinsic — `Fn::Join` / `Fn::Sub`,
what CDK emits whenever the secret's ARN is a `Ref`, so the common case — the
reference is identified by the shape of that intrinsic instead.

A narrow residual remains, and it degrades to the old behaviour rather than to
anything worse. When the intrinsic's literal parts cannot tell the two
references apart — the part that differs is itself behind a `Ref` — cdkd
declines to guess and both leaves persist the same expression. The same
applies to a pair of `{{resolve:ssm:...}}` references whose parameter `Type`
AWS did not report. If you hit a spurious UPDATE on a resource holding two
spellings of one secret, make the differing part a literal in the template.

### Secrets inside a list

A reference nested in an array — an ECS task definition's
`ContainerDefinitions[].Environment[]` is the usual shape — is redacted like
any other leaf, including on a resource that did not change on that deploy.

cdkd matches list elements by their identity field (`Name` / `Key`) rather
than by position, which does not depend on the order AWS returns them in.
Elements that carry no such identity field are left alone rather than guessed
at, so nothing is ever written onto the wrong element; a redaction cdkd cannot
place falls back to matching by value.

### A secret whose value is itself a reference

Such a value is byte-identical to an already-redacted expression, so cdkd asks
a narrower question: does the reference it is being compared against describe
the SAME generation of the resource? Only a resource's own stored properties
can answer yes; a template never can, whichever command is running.

When the answer is no, the leaf is matched by VALUE instead — so a plaintext
cdkd resolved this run is still replaced by its own reference, while a
reference already in state is left exactly as it is. A legacy leaf of this
shape is cleaned the next time either `cdkd deploy` or `cdkd scrub` resolves
that secret.

### Fragments inside a complete reference

A stored value can hold a reference inside surrounding text —
`jdbc://appdb:{{resolve:secretsmanager:appdb/creds:SecretString:password}}@host`
is what a joined connection string looks like after redaction — and a later
deploy can record a secret whose plaintext (`appdb`) also occurs inside that
reference's own text. Rewriting it there would produce
`{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/creds:...}}`, which no
service can resolve: `cdkd rollback` reads it as a request for the secret id
`{{resolve:ssm:/app/dbname` and either refuses or applies the wrong value.

cdkd therefore replaces every match of a recorded secret EXCEPT one that lies
wholly inside a complete reference and is shorter than it. A stored secret
whose own value IS a reference is still replaced, and so is one that CONTAINS
a whole reference plus surrounding text — dropping those would leave the
plaintext in state, which is worse than the mangling this rule prevents. An
embedded secret in ordinary text is repaired exactly as before.

Three limits are worth knowing, all of them narrow. A STRAY `{{resolve:` — an
opener that is not part of a real reference — is read by the same grammar the
resolver uses, and which way it falls depends on what follows it in that same
value:

- With **no later `}}`** it is not a reference at all, so it protects nothing
  and a secret after it is still replaced. Leaving the plaintext there instead
  would hide it behind two characters any string can contain.
- With a **`}}` anywhere later**, the opener and that `}}` bracket one region,
  and a secret inside it is left alone. This is the one shape where cdkd
  redacts less than a naive value match would. Narrowing what counts as a
  reference is not the fix: that would disagree with the resolver about the
  same string, and would re-mangle values an older cdkd already mangled. Such
  a value cannot come from a template — it would fail to resolve at deploy
  time — so the way it arrives is a drift read-back
  (`observedProperties`), which is arbitrary text from AWS.

And a value already mangled by an older cdkd is not repaired: it parses as a
valid reference now, so neither a redeploy nor `cdkd scrub` rewrites it.
Fixing such a record means editing it out of state, or redeploying the
resource so the leaf is written afresh.

### A reference you have edited but not deployed

Such a reference is never rewritten — by `cdkd scrub` or by `cdkd deploy`. If
state holds `...:AWSPREVIOUS` and the template now says `...:AWSCURRENT`,
scrub leaves the record alone and reports nothing to scrub, and a deploy that
fails and rolls back leaves the reverted reference in place.

Rewriting either would make the next `cdkd deploy` compare the new expression
against itself, see no change, and never push the edit to AWS — a credential
rotation that silently never happens, invisible to `cdkd drift` because the
baseline would have been rewritten too. The same rule covers the drift
baseline: `observedProperties` keeps the reference AWS was last seen holding,
so `cdkd drift --revert` cannot push an undeployed one.

### A value AWS reports at a position your template does not name

The drift baseline in `observedProperties` is whatever AWS returned, so it
routinely carries fields the template never set and list elements the template
does not have — and a secret can land in one of them: a copied environment
variable, an entry AWS added. Those positions have no template leaf to match
against.

cdkd takes the plaintext it learned at a position it COULD match — the same
secret's own leaf, elsewhere in the same record — and replaces the remaining
occurrences of that value in that record with the same reference. Positions
the template already accounted for keep the answer the template gave them, so
this only ever ADDS a replacement.

Nothing is fetched and no extra permission is needed: the value comes out of
the read-back cdkd already has. A value that is NOT one of those secrets is
left exactly as AWS reported it, so the baseline still describes the live
resource.

## Stack outputs

Stack outputs are scrubbed too, including an output you have since DELETED.

A stored output key today's template can still name — a declared output, or an
`Export.Name` alias this run can fully resolve — is redacted by POSITION
against that template, like any resource property.

A key the template can no longer name is repaired whenever its stored value
MATCHES a secret plaintext recorded anywhere in this run, including one only a
RESOURCE still references, which is the usual shape after deleting the output
that used to expose it.

A deleted output is the motivating case but not the whole population: **any
stored key this run cannot COMPUTE** is repaired the same way. The standing
example is a parameterized `Export.Name` — `scrub` takes no `--parameters`, so
a name that resolves to a literal `prefix-${Foo}` here leaves the real alias
key your deploy wrote unaccounted for on every run, and that key is
value-matched rather than positioned for as long as the parameter stays
unresolvable. Declare the export name literally, or give the parameter a
`Default` the template resolves from, if you want that key positioned instead.

### What scrub deliberately does not do here

`state.outputs` is re-applied VERBATIM to other stacks — cdkd's exports index
and every `Fn::ImportValue` / `Fn::GetStackOutput` read it — so a value
rewritten that was never a secret would ship a literal `{{resolve:...}}` token
into a CONSUMER stack's AWS call. Hence three rules:

- **It never guesses.** When nothing this run recorded that plaintext — the
  secret was deleted, rotated away, or its reference is gone from the template
  as well — the value is left exactly as it is, no key is invented, and no key
  is removed. ROTATE the secret and redeploy; that rewrites the record. A
  degenerately short plaintext, under 4 characters, is excluded from the
  WIDENED match specifically: it is never used as a cross-resource needle,
  since it would match unrelated values. A key the template still names is
  unaffected — it is redacted by template POSITION, so a short secret stored
  there is still repaired.
- **It matches inside a value, and that has a stated cost.** A recorded
  plaintext of 4 characters or more is repaired even when it is EMBEDDED in a
  longer stored value, which is what repairs a connection string built around
  a password — the shape this exists for. The consequence is that a short,
  word-like secret (`admin` as a `secretValueFromJson('username')`) occurring
  inside an unrelated key the template can no longer name is rewritten too,
  and a consumer importing that key then receives a literal `{{resolve:...}}`
  token. The trade is deliberate: that failure is loud and fixable on the next
  deploy, whereas an unrepaired plaintext under a key no template declares is
  silent and no redeploy ever clears it. If it bites, edit the key out of the
  state record — and rotate the secret, which was exposed either way.
- **It does not widen the match for a key the template still names.** Those
  keep their template position, so one resource's secret value can never
  rewrite a declared output's coinciding literal into that resource's
  reference. The residual: a declared output whose template value no longer
  resolves a secret, but whose STORED value is still the stale plaintext of
  one, is not repaired by `scrub` either — a redeploy rewrites it.

## Limitations

Two paths do not inherit this redaction, both because they resolve a reference
through a context that does not record secrets:

- A secret reference used as a NESTED STACK's `Parameters` value is resolved
  by the parent and handed to the child as a literal, so the child stack's own
  state records the plaintext, and `cdkd diff --recursive` decrypts it at plan
  time.
- [`cdkd export`](cli-export.md) writes the resolved value into the exported
  CloudFormation template's Parameter value, so the plaintext lands in the
  template it hands to CloudFormation.

Both apply to `{{resolve:secretsmanager:...}}` as well as to a `SecureString`
parameter.

## Related

- [`cdkd drift`](cli-drift.md) — how a redacted state record is compared against AWS
- [`cdkd diff`](cli-diff.md) — which stored output values it withholds, and why
- [State Management](state-management.md) — the state records `scrub` rewrites
- [Cross-Stack References](cross-stack-references.md) — the exports index the cross-stack refusals protect
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
