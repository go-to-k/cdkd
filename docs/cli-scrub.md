---
title: cdkd scrub
description: "State secret hygiene — clean secrets out of persisted state and audit it with cdkd scrub."
---

## `cdkd scrub` (state secret hygiene: clean + audit)

cdkd resolves CloudFormation dynamic references (`{{resolve:secretsmanager:...}}`,
and `{{resolve:ssm:...}}` pointing at a **SecureString** parameter)
to their concrete value so the secret can be handed to the AWS API on
create / update. When it PERSISTS state, it stores the UNRESOLVED expression
rather than the resolved plaintext, so the secret never lands in `state.json`,
`cdkd state show`, `cdkd diff`, or `cdkd drift` output — this matches
CloudFormation, which keeps the reference in the template and resolves it
service-side. A rotated secret behind an unchanged reference is a no-op on the
next deploy (again matching CloudFormation), and `cdkd diff` makes no live
secret fetch.

`cdkd scrub` is the permanent home for that concern: the one command that keeps
cdkd state free of sensitive plaintext and audits that it stays that way. Two
modes, both useful long after any one-time migration:

- **Clean** — rewrite existing state in place, WITHOUT redeploying. This is what
  you run after upgrading cdkd on a stack you do not want to re-provision, or
  any time you suspect a state file predates a redaction fix.
- **Audit** — `--dry-run --fail` exits 1 when any plaintext secret is still in
  state, so it works as a STANDING CI gate rather than incident-only tooling.
  Secrets landing in IaC state is a structural, recurring concern (the same
  class Terraform has), so it is worth asserting continuously:

```yaml
# CI: fail the build if any cdkd state file holds a plaintext secret.
- run: cdkd scrub --all --dry-run --fail
```

A normal `cdkd deploy` scrubs state this way as a side effect, so a green gate is
the expected steady state rather than something you have to maintain. The
commands:

```bash
# Rewrite state so plaintext secrets become their {{resolve:...}} expression
cdkd scrub MyStack

# Report what would change without writing state
cdkd scrub MyStack --dry-run

# CI gate: exit 1 if any plaintext secret remains in state
cdkd scrub MyStack --dry-run --fail

# Every stack in the synthesized app
cdkd scrub --all
```

**Needs the CDK app.** Unlike the `cdkd state ...` family, `scrub` requires
`--app` (or `CDKD_APP` / `cdk.json`) because a state file records the resolved
value with no marker of which values are secrets — only the template carries
the `{{resolve:...}}` references. `scrub` synthesizes the template, re-resolves
each resource's properties to learn the resolved secret VALUES (recorded, never
printed or re-persisted), and replaces those values in the state record's
`properties` / `attributes` / `observedProperties` with the expression. It
performs no AWS create / update / delete — only `state.json` is rewritten,
under the stack lock.

**Scrubbing does not un-expose an already-leaked secret.** A value that was
ever stored in plaintext should be treated as compromised and ROTATED in
Secrets Manager; `scrub` only stops it being re-read out of state going
forward. **Run `scrub` BEFORE rotating**: it matches the CURRENT resolved
secret value against what state holds, so once the secret is rotated the stale
value in state no longer matches and `scrub` reports "nothing to scrub" (the
rotation invalidates the stale value; a redeploy rewrites the record with the
expression). Exit codes: 0 (scrubbed / nothing to do), 1 (`--fail` found
plaintext: with `--dry-run` any plaintext at all, and on a REAL run a leak
scrub cannot rewrite — a state KEY holding a secret, which needs an
`Export.Name` change plus a redeploy), 2 (error).

**A cross-stack read that cannot be resolved is now a REFUSAL, not a silent
pass**. `scrub`
learns which plaintexts to hunt for by re-resolving the template, so a leaf that
arrives through `Fn::ImportValue` / `Fn::GetStackOutput` yields a needle only if
the producer's state can actually be read. Previously it could not be: no
resolve context carried a state backend, the read threw, and the throw was
absorbed by the per-item best-effort handler that exists so a partially
resolvable template still gets scrubbed for everything else. With no needle
nothing matched, so the command reported no plaintext found over state that may
still have held it. Such a read is now attempted before the main pass and
refuses with `SCRUB_CROSS_STACK_READ_UNRESOLVED` (exit 2) naming the resource or
output it could not resolve. Everything else the best-effort handler swallows is
unchanged -- a `Ref` to a resource absent from state still degrades to a partial
scrub rather than failing the run, which is what that handler is for. Two
consequences worth expecting: a stack whose producer state is unreadable (a
deleted producer, a cross-account export, a missing state file) now exits 2
where it previously exited 0, and under `--all` that refusal is per stack, so
the remaining stacks are still scrubbed and the run ends non-zero naming the
ones it could not examine. A conditional import does NOT refuse when its branch
is not taken: the pre-pass walks `Fn::If` the way the resolver does, selected
branch only, and neither does a `Fn::ImportValue` inside an output that this
run's conditions SUPPRESS -- such an output wrote no state key, so there is
nothing behind it to protect. The same branch selection now decides whether the
PRODUCER's export counts as secret-bearing at all: that test
used to scan the whole output node as text, so an `Fn::If` whose UNTAKEN arm
held a `{{resolve:...}}` expression made the export look secret-bearing while
the deployed value was the plain branch -- and the refusal below then fired over
a stored value nothing could turn into an expression, with no bypass flag. One
selection now feeds both halves of the question.

**Which branch scrub selects is evaluated against the template's DEFAULT
parameter values.** `scrub` takes no `--parameters`, so it has nothing else to
evaluate a `Conditions` entry with, and a condition it cannot evaluate reads as
false. For a stack deployed with NON-default parameters that means scrub can
pick a branch the deploy never took -- and in a RESOURCE position, unlike an
output position, a cross-stack read on that branch still refuses (exit 2), so
the stack can be refused over a producer that legitimately does not exist for
the parameters it was actually deployed with. An output position is already
spared this: `state.outputs` records what the deploy really wrote, and a key
absent from it disarms the refusal. There is no equivalent record for a
resource-position branch, so the practical remedies are to make the read
resolvable -- deploy or scrub the producer that branch names, which
`cdkd scrub --all` does in one run by ordering producers before consumers --
rather than to re-run unchanged.

**A cross-stack read that SUCCEEDS but whose PRODUCER still stores the
plaintext refuses too** (`SCRUB_CROSS_STACK_PRODUCER_PLAINTEXT`, exit 2). scrub
can only replace a stored plaintext with the `{{resolve:...}}` expression the
PRODUCER holds, and a producer whose own state has not been scrubbed yet still
holds the plaintext itself -- so the read succeeds, there is no expression to
write, and the consumer would be reported clean over a record that still holds
the secret. The verdict is taken by READING the producer's own stored value, not
by inspecting what the read returned: the read RESOLVES a stored expression to
plaintext before handing it over, so a healthy producer and an unscrubbed one
are indistinguishable from the consumer's side. The refusal names the producer
and the fix: `cdkd scrub <producer>` first, then re-run.

Whether the export is SECRET-BEARING AT ALL is the half of the question the
stored value cannot answer either -- a bucket name and a leaked password are
both bare strings, so refusing on the stored value alone would refuse every
multi-stack app that imports anything. That half is taken from the app's
TEMPLATES, and the refusal fires only when they say the value carries a secret:
either the producer declares that export from a `{{resolve:...}}` expression, or
the producer RE-EXPORTS a value that a stack further up the chain declares from
one.
Both arms read the export through the SAME `Fn::If` branch selection described
above, so an expression sitting only in a branch this run does not select
answers neither of them -- and the residual is stated rather than implied: a
secret reachable only through that branch is not detected, which is the outcome
that reference had before this refusal existed. An
ordinary import of a bucket name or an ARN is unaffected under either arm. The chain arm
is not a refinement: a middle stack's output IS the `Fn::ImportValue`, so asking
that one template answered "not secret-bearing", and `cdkd scrub <the stack at
the end of the chain>` then reported clean over its own surviving plaintext --
invisibly under `--all`, which scrubs producers first and so heals the chain
before that stack is reached, and reachably under the single-stack form this
page documents. The walk follows `Fn::ImportValue` / `Fn::GetStackOutput`
through the synthesized templates and terminates on a cycle by never revisiting
a `(stack, export)` pair; for a chain the remedy names EVERY stack in it, head
first, because a middle stack cannot store the expression until its own producer
has been scrubbed. What remains unclassifiable from the consumer's side is still
not refused: a producer outside the synthesized app, one whose export cdkd
resolved through CloudFormation rather than through cdkd state, a re-export
whose upstream reference cannot be read statically (an assembled export name, or
an `Fn::GetStackOutput` whose stack or output name is itself an intrinsic), and
one whose upstream export is declared under a name this run cannot reproduce --
which usually means an intrinsic `Export.Name` one hop up, so a stack DOES
declare it and the walk simply cannot match it. When the producer's
`Export.Name` is an intrinsic this run cannot reproduce, the check widens to
every output of THAT producer -- an over-approximation in the safe direction,
and the message says so rather than claiming the producer declares that
particular key from an expression. Note the asymmetry, which is deliberate: the
same input WIDENS at the direct producer and is DROPPED one hop up. At the root
the key came from an actual read, so some output of that producer really did
answer it and refusing over the set is the safe reading; one hop up the key is a
literal name read out of a template, so a miss means that template does not
declare it, and widening there would refuse the consumer over an unrelated
secret two stacks away in a refusal no `cdkd scrub` could clear.

`cdkd scrub --all` now scrubs PRODUCERS BEFORE CONSUMERS (CDK's own stack
dependencies plus raw `Fn::ImportValue` / `Fn::GetStackOutput` edges inferred
from the templates), so one run normally scrubs a producer and then resolves its
expression in the consumer. `--dry-run` writes nothing, so the producer is never
rewritten -- a dry run over a not-yet-scrubbed producer is exactly where this
refusal is expected.

**An ASSEMBLED secret reference is handed to the resolver rather than
refused**. A
reference the intrinsics build out of parts -- an `Fn::Sub` placeholder inside
it, an `Fn::Join` that splits it -- does not exist as a complete expression
until it is resolved, so `scrub`'s region pre-pass cannot classify it and hands
it on; the resolver decides the region AFTER assembly and routes it to the region
its ARN names, or refuses it as `ambiguous`. `scrub` used to refuse such a leaf
outright (exit 2, no bypass flag) whenever the stack also had a foreign producer
region on record, which made the whole stack unscrubbable over a reference cdkd
can now resolve correctly.

Known residual: if the
downstream lookup then FAILS, the stack can still be summarised as CLEAN. Two
shapes reach it and they are not equally quiet -- a region that refuses the read
(a denied `GetSecretValue`, a deleted secret) is reported only at
`--verbose`, while an `Fn::Sub` placeholder `scrub` cannot evaluate (it takes no
`--parameters`) does print a `keeping placeholder` warning at default verbosity.
Neither stops the summary line.
The COMPLETE-token spelling of the first is loud
(`SCRUB_CROSS_REGION_SECRET_UNRESOLVED`, exit 2), so the two disagree for
now. Run `cdkd scrub --verbose` when a stack you expect findings from
reports clean.

**A read cdkd declines BY DESIGN is a finding, not a refusal.** The
cross-account `Fn::GetStackOutput` of a redacted value is never resolved: cdkd
will not look up a producer account's secret with the consumer's credentials.
That read cannot be made to succeed by re-running, so refusing the whole stack
would strand every other secret in it. Instead the stack is scrubbed for
everything else, the read is reported (`N cross-stack read(s) in <stack> could
NOT be verified`), the summary says so, and `--fail` exits non-zero -- the same
treatment a secret-bearing output KEY gets. That treatment is scoped to THAT ONE
read. Other refusals the resolver raises deliberately -- a stale placeholder
ARN, an unresolvable account id, an unenriched `Fn::GetAtt`, `--strict-getatt`,
a malformed `Fn::Split` -- are all things you can FIX in the template, so they
refuse the stack (exit 2) with the resolver's own message, and a re-run after
the fix scrubs it. They are reachable here whenever the reference's export name
is built by an `Fn::Sub` over one of them.

**SSM parameters are redacted by TYPE, not by spelling**. The plain
`{{resolve:ssm:...}}` form resolves with `WithDecryption`, so it yields a real
secret whenever the parameter is a `SecureString` — the same disclosure class
as `{{resolve:secretsmanager:...}}`. cdkd reads the parameter's `Type` off the
same `GetParameter` response that carries the value and treats the two cases
differently:

- **`SecureString`** — handled exactly like a Secrets Manager reference: the
  decrypted value goes to the AWS API, state stores the `{{resolve:ssm:...}}`
  expression, and `cdkd scrub` cleans it out of state written by an older cdkd.
- **`String` / `StringList`** — public config, stored RESOLVED in state as
  before, so a parameter-backed property is not a perpetual spurious UPDATE.

On the diff / no-op comparison path cdkd still has to learn the type, so it
issues `GetParameter` with `WithDecryption: false` — a `SecureString` comes back
as its encrypted blob, which is never substituted, cached, or persisted, and the
comparison stays expression-vs-expression. Once a reference is known to be
`SecureString`, later comparisons short-circuit with no AWS call at all.

**Two spellings of one secret value.** Two dynamic references that resolve to
the SAME value — for example the same JSON key written once with and once
without an explicit version stage — used to collapse in the redaction map,
which is keyed by the resolved value, so both sites persisted whichever
expression was recorded last and the stack reported a spurious UPDATE on every
deploy. No plaintext was ever exposed; the wrong EXPRESSION was stored. cdkd
now redacts by POSITION as well as by value: each leaf is matched against the
UNRESOLVED template at the same path, so it keeps its own
expression. Where the template leaf
is an intrinsic (`Fn::Join` / `Fn::Sub` — what CDK emits whenever the secret's
ARN is a `Ref`, so the common case) the reference is identified by the shape of
that intrinsic instead.

A narrow residual remains, and it degrades to the old behavior rather than to
anything worse: when the intrinsic's literal parts cannot tell the two
references apart — the part that differs is itself behind a `Ref` — cdkd
declines to guess and both leaves persist the same expression again. The same
applies to a pair of `{{resolve:ssm:...}}` references whose parameter `Type`
AWS did not report. If you hit a spurious UPDATE on a resource holding two
spellings of one secret, make the differing part a literal in the template.

**Stack OUTPUTS are scrubbed too, including an output you have since
DELETED**. A stored output
key today's template can still name — a declared output, or an `Export.Name`
alias this run can fully resolve — is redacted by POSITION against that
template, like any resource property. A key the template can no longer name is
the population `cdkd scrub` is recommended for and used to be unable to repair:
the set of secrets `scrub` matched the outputs bag against was built from
today's DECLARED outputs, so an output removed in an ordinary refactor
contributed nothing to it and its stored plaintext survived a scrub that
reported success. Such a key is now repaired whenever its stored value MATCHES a
secret plaintext recorded anywhere in this run — including one only a RESOURCE
still references, which is the usual shape after deleting the output that used
to expose it.

A deleted output is the motivating case but not the whole population: **any
stored key this run cannot COMPUTE** is repaired the same way. The standing
example is a parameterized `Export.Name` — `scrub` takes no `--parameters`, so
a name that resolves to a literal `prefix-${Foo}` here leaves the real alias key
your deploy wrote unaccounted on every run, and that key is value-matched rather
than positioned for as long as the parameter stays unresolvable. Declare the
export name literally, or give the parameter a `Default` the template resolves
from, if you want that key positioned instead.

Two things `scrub` deliberately does NOT do here. `state.outputs` is re-applied
VERBATIM to other stacks — cdkd's exports index and every `Fn::ImportValue` /
`Fn::GetStackOutput` read it — so a value rewritten that was never a secret
ships a literal `{{resolve:...}}` token into a CONSUMER stack's AWS call:

- **It never guesses.** When nothing this run recorded that plaintext — the
  secret was deleted, rotated away, or its reference is gone from the template
  as well — the value is left exactly as it is, no key is invented, and no key
  is removed. `ROTATE` the secret and redeploy; that rewrites the record. A
  degenerately short plaintext (under 4 characters) is excluded from the WIDENED
  match specifically: it is never used as a cross-resource needle, since it
  would match unrelated values. A key the template still names is unaffected —
  it is redacted by template POSITION, so a short secret stored there is still
  repaired.
- **It matches inside a value, and that has a stated cost.** A recorded
  plaintext of 4 characters or more is repaired even when it is EMBEDDED in a
  longer stored value — which is what repairs a connection string built around
  a password, the shape this exists for. The consequence is that a short,
  word-like secret (`admin` as a `secretValueFromJson('username')`) occurring
  inside an unrelated key the template can no longer name is rewritten too, and
  a consumer importing that key then receives a literal `{{resolve:...}}`
  token. The trade is deliberate: that failure is loud and fixable on the next
  deploy, whereas an unrepaired plaintext under a key no template declares is
  silent and no redeploy ever clears it. If it bites, edit the key out of the
  state record — and rotate the secret, which was exposed either way.
- **It does not widen the match for a key the template still names.** Those
  keep their template position, so one resource's secret value can never
  rewrite a declared output's coinciding literal into that resource's
  reference. The residual: a declared output whose template value no longer
  resolves a secret but whose STORED value is still the stale plaintext of one
  is not repaired by `scrub` either — a redeploy rewrites it.

Until this shipped, such a record was correctly WITHHELD from `cdkd diff`'s
display and not
repairable; the diff-side refusal is unchanged, since it still cannot decide
from a stored string alone whether a value is a plaintext.

**Secrets inside a LIST are redacted too, including on a resource that did not
change**. A
reference nested in an array — an ECS task definition's
`ContainerDefinitions[].Environment[]` is the usual shape — used to keep its
resolved plaintext in the record's `observedProperties` (the drift baseline)
whenever the resource was UNCHANGED on that deploy, because the resource is
never re-resolved then and AWS does not return list elements in the template's
order. cdkd now matches list elements by their identity field (`Name` / `Key`)
rather than by position, which does not depend on order, so the leaf is
redacted like any other. Elements that carry no such identity field are left
alone rather than guessed at, so nothing is ever written onto the wrong
element; a redaction cdkd cannot place falls back to matching by value.

**A secret whose value is itself a `{{resolve:...}}` string is
redacted**. Such a value is
byte-identical to an already-redacted expression, and cdkd used to keep any
such leaf verbatim — which persisted the plaintext. cdkd now asks a narrower
question: does the reference it is being compared against describe the SAME
generation of the resource? Only a resource's own stored properties can answer
yes; a template never can, whichever command is running. When the answer is no,
the leaf is matched by VALUE instead — so a plaintext cdkd resolved this run is
still replaced by its own reference, while a reference already in state is left
exactly as it is. A legacy leaf of this shape is cleaned the next time either
`cdkd deploy` or `cdkd scrub` resolves that secret.

**A value match never rewrites a fragment INSIDE a complete `{{resolve:...}}`
reference**. A
stored value can hold a reference inside surrounding text —
`jdbc://appdb:{{resolve:secretsmanager:appdb/creds:SecretString:password}}@host`
is what a joined connection string looks like after redaction — and a LATER
deploy can record a secret whose plaintext (`appdb`) also occurs inside that
reference's own text. Rewriting it there produced
`{{resolve:secretsmanager:{{resolve:ssm:/app/dbname}}/creds:...}}`, which no
service can resolve: `cdkd rollback` reads it as a request for the secret id
`{{resolve:ssm:/app/dbname` and either refuses or applies the wrong value.

cdkd now replaces every match of a recorded secret EXCEPT one that lies wholly
inside a complete reference and is shorter than it. A stored secret whose own
value IS a reference is still replaced, and so is one that CONTAINS a whole
reference plus surrounding text — dropping those would leave the plaintext in
state, which is worse than the mangling this rule prevents. Nothing else about
substring matching changes: an embedded secret in ordinary text is repaired
exactly as before.

Three limits worth knowing, all of them narrow. A STRAY `{{resolve:` — an
opener that is not part of a real reference — is read by the same grammar the
resolver uses, and which way it falls depends on what follows it in that same
value:

- With **no later `}}`** it is not a reference at all, so it protects nothing
  and a secret after it is still replaced. Leaving the plaintext there instead
  would hide it behind two characters any string can contain.
- With a **`}}` anywhere later**, the opener and that `}}` bracket one region,
  and a secret inside it is left alone. This is the one shape where cdkd redacts
  less than it did before this change. It is not fixed by narrowing what counts
  as a reference: that would disagree with the resolver about the same string,
  and would re-mangle values an older cdkd already mangled. Such a value cannot
  come from a template — it would fail to resolve at deploy time — so the way it
  arrives is a drift readback (`observedProperties`), which is arbitrary text
  from AWS.

And a value already mangled by an older cdkd is not repaired: it parses as a
valid reference now, so neither a redeploy nor `cdkd scrub` rewrites it. Fixing
such a record means editing it out of state, or redeploying the resource so the
leaf is written afresh.

**A reference you have edited but not deployed is never rewritten** — by
`cdkd scrub` or by `cdkd deploy`. If state holds `...:AWSPREVIOUS` and the
template now says `...:AWSCURRENT`, scrub leaves the record alone and reports
nothing to scrub, and a deploy that fails and rolls back leaves the reverted
reference in place. Rewriting either would make the next `cdkd deploy` compare
the new expression against itself, see no change, and never push the edit to
AWS — a credential rotation that silently never happens, invisible to
`cdkd drift` because the baseline would have been rewritten too. The same rule
covers the drift baseline: `observedProperties` keeps the reference AWS was
last seen holding, so `cdkd drift --revert` cannot push an undeployed one.

**A value AWS reports at a position your template does not name is redacted
too**. The drift
baseline in `observedProperties` is whatever AWS returned, so it routinely
carries fields the template never set and list elements the template does not
have — and a secret can land in one of them (a copied environment variable, an
entry AWS added). Those positions have no template leaf to match against, so
before this they kept the resolved plaintext. cdkd now takes the plaintext it
learned at a position it COULD match — the same secret's own leaf, elsewhere in
the same record — and replaces the remaining occurrences of that value in that
record with the same reference. Positions the template already accounted for keep
the answer the template gave them, so this only ever ADDS a replacement. Nothing is fetched and no extra permission is
needed: the value comes out of the readback cdkd already has. A value that is
NOT one of those secrets is left exactly as AWS reported it, so the baseline
still describes the live resource.

**Known limitation.** Two paths do not yet inherit this redaction, both because
they resolve a reference through a context that does not record secrets:

- A secret reference used as a NESTED STACK's `Parameters` value is resolved by
  the parent and handed to the child as a literal, so the child stack's own
  state records the plaintext, and `cdkd diff --recursive` decrypts it at plan
  time.
- `cdkd export` writes the resolved value into the exported CloudFormation
  template's Parameter value, so the plaintext lands in the template it hands
  to CloudFormation.

Both apply to `{{resolve:secretsmanager:...}}` as well as to a `SecureString`
parameter.

