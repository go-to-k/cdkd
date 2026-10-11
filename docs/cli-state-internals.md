---
title: cdkd state internals
description: "How the cdkd state subcommands render untrusted record values, degrade on malformed records, and decide what refresh-observed may write."
unlisted: true
---

# cdkd state internals

Implementation detail behind [`cdkd state`](cli-state.md), for someone changing
those subcommands. The user-facing behaviour is on that page,
[cdkd state: writing subcommands](cli-state-writing.md) and
[cdkd state: malformed records](cli-state-malformed.md); this one records the
edge cases they summarize.

## Why record values are treated as untrusted text

A state record is read as JSON and used as typed data without a field-by-field
shape check, so a hand-edited one can hold anything. cdkd's output is
line-oriented, so a newline inside a field would not merely colour the output:
it would invent a line that reads exactly like a real row.

- Control characters are removed from every name, type, id, dependency list
  and nested-stack header. The escape byte is removed and the characters
  around it are kept, so a name carrying `ESC[31m` prints as `[31m`: the
  sequence is broken, the name is not censored.
- Two rows take no removal because neither needs it: the lock row's `owner`
  and `operation` are sanitized where the lock record is read, before
  `cdkd state show` sees them, and `Version` is refused where the state record
  is read unless it is a known schema number or absent.
- The refusals these views raise are held to the same rule. An unreadable
  `state.json` or `lock.json` is quoted back by the JSON parser, an ambiguous
  stack has its regions listed, and a nested-stack walk names the child it
  could not find. The diagnostic reports the bad value flattened onto one
  line. Anything that strips to nothing is reported as an explicit
  placeholder, and the underlying cause a refusal reports is flattened the same
  way. An error reaching the user from the AWS SDK itself is that service's own
  text.

## Wrongly typed values in `state show` and `state resources`

A value whose type the record got wrong still prints, rather than ending the
output. A number where a string belongs prints as that number, an object as
JSON, and a value nothing can serialize as `(unserializable)`. A few fields are
decided before any of that:

| Field | Rendering |
| --- | --- |
| a falsy `region` | its whole row is omitted |
| a falsy `parentRegion` | only the parenthesized region is dropped from the `Parent:` row |
| an absent or null `provisionedBy` | the legacy default is reported |
| a `lastModified` that cannot be read as a time | printed as itself |
| a `dependencies` that is not a list, in `state show` | printed as itself; `(none)` only for an absent one or an empty list |
| a `null` `dependencies`, in `state resources --long` | `(none)`, so the two views differ on that one value |

`(none)` is ordinary text, so a record whose dependency list literally contains
`(none)` renders the same thing; `--json` tells them apart.

A `resources` entry holding `null` rather than a resource aborts no mode,
`--show-nested` and both JSON walks included: the human views render it the way
a number or a string there always did (`Type` and `PhysicalID` read
`undefined`, the other fields their defaults), and `cdkd state show --json`
emits the stored `null`.

A lock whose `owner`, `operation` or `expiresAt` holds an object that cannot be
coerced renders too: the owner and operation read as `[object Object]`, and the
expiry reads as `expires at an unknown time`, the same words the
lock-contention refusal uses for any `expiresAt` that is not a finite number
(`{}`, `"soon"`, absent), so a hand-edited deadline never prints as
`NaNmNaNs`.

## What `--json` is not

`--json` applies none of the sanitizing. It escapes instead: every control,
format, line-separator and paragraph-separator character (DEL, the C1 range,
`U+2028`, `U+2029`, the bidi overrides and the zero-width characters, which
plain JSON would emit raw) is written as a `\uXXXX` escape. The output parses
back to exactly the stored values, and printing it to a terminal cannot run a
control sequence. It is not byte-for-byte in every mode:

| Mode | What it is not |
| --- | --- |
| `cdkd state show --json` | the record as parsed; the lock it reports has had `owner` and `operation` put through the shared display sanitizer, with an `expiresAt` whose number coercion throws emitted as `null`. One that merely converts to `NaN`, such as `{}` or `"soon"`, is emitted as stored |
| `cdkd state resources --json` | substitutes an empty list or object for an absent `dependencies` or `attributes`; never reads a lock. It emits the resource array cdkd derived, so a `resources` that is not a JSON object yields `[]` with a warning, not the stored value |

Plain `cdkd state show --json` emits the record as parsed, without walking it
or rendering a lock summary.

## Malformed containers

`--show-nested` reports no children for a record whose `resources` is not a
map, at every depth: each record the walk reaches is judged on its own bag, so
a healthy parent whose nested child is malformed still renders the parent's
resources, reports the child with none, and descends no further.

`--show-nested --json` is the one JSON mode that still warns, because there the
damage is invisible in the payload's shape: a node whose bag could not be read
comes back with an empty `children` list, which is exactly what a genuine leaf
looks like.

For `outputs`, `skippedOutputs`, `attributes` and `properties`, a view reports
only the containers it renders. `cdkd state resources` prints attributes in
`--long` and `--json` and nothing else in any mode, so it says nothing about
`properties`, `outputs` or `skippedOutputs`, and its plain listing says nothing
at all. An absent or `null` container is not reported: `skippedOutputs` is
absent on every record written before it existed, `attributes` is absent on a
resource that has none, and neither can invent a row.

## `state list` rendering rules

The reason text on a degraded `--long` row is fixed and never quotes the
underlying error, because a malformed record's parse error can quote bytes of
the record. A legacy row with no region is the exception to "run
`cdkd state show`": its lock reason names no command, because
`cdkd state show` refuses a region-less record before it reads the lock. A
legacy `version: 1` record with no region is not read under `--long`, so its
row shows `Resources: 0` and `Last Modified: unknown` with no reason attached.

| Value | How it renders |
| --- | --- |
| a `lastModified` outside the date range, or not a number | `Last Modified: unknown`, `null` under `--json` |
| a `resources` that is neither a JSON object nor `null` | `Resources: unknown (...)`; an absent or `null` one counts as `0` |
| a character outside printable ASCII in a stack name or region | replaced with a space, and the value is then quoted. A value with nothing printable left shows as `<unrenderable>` |
| a stack name or region cdkd had to change to render, including trimmed surrounding whitespace | rendered as a quoted string: `ProdStack ` renders `"ProdStack" (us-east-1)` |
| a stack name or region carrying anything outside `A-Za-z0-9` and `:_@./+=,~-` | quoted the same way: `"ProdStack (us-east-1)" (us-east-1)` |
| a very long stack name or region | cut, with `[cut: N more characters withheld, tail sha256:<32 hex>]` appended. The limit is 1152 characters for a name, 255 for a region |
| a parent link whose `parentStack` is not a string, or whose `parentRegion` is present but not a string | `--tree` drops the link and shows the stack at the root. An absent `parentRegion` still links to a legacy region-less parent |
| a non-string `parentLogicalId` on an otherwise valid link | `--tree --json` emits it as `null` and keeps the link |
| records that name each other as parent | `--tree` shows every stack on the loop at the root |

The digest on a cut value names the withheld part without showing it, so two
long values that differ only past the cut render differently, unless they
differ only in characters outside printable ASCII, which are replaced with a
space before the digest is taken.

The quoting matters because the ` (region)` suffix is cdkd's own annotation of
the line rather than part of either value. Both halves come from an S3 key
segment (or, for a legacy record, the state body), so a name that contains a
space and brackets could otherwise render byte-identical to a different,
genuine reference.

| Question | Answer |
| --- | --- |
| Where else does the quoting apply? | `cdkd state orphan`'s prompt and its removal line, `cdkd state refresh-observed`'s prompt, and `cdkd rollback`'s candidate list |
| Does a real row change? | No. Real stack names and region codes are plain identifiers |
| Is a quoted value shell-safe? | No. The quotes are a boundary for a reader, not shell quoting |
| Can a long name still mislead? | Yes, if the terminal wraps it. Widen the terminal, or use `--json` |
| Can anything else still mislead? | Yes. A name ending in a comma is left unquoted, and the prompts list references separated by `, `, so one such name reads as two entries |

The `--tree` depth cap exists because cdkd deploys nested stacks through its
own engine and imposes no nesting limit of its own, while CloudFormation stops
at five levels. A re-rooted record keeps its own parent link in
`--tree --json`, which is how a consumer tells it apart from a genuine
top-level stack.

## The skipped-outputs block in `state show`

For an output whose resolver threw, the deploy's own warning already names it;
for one that merely resolved to `undefined` there is no per-output warning at
all. For such a key, while it is absent from the stored outputs, the block is
the first place it is named in the human-readable view without `--verbose`,
which logs the same decision from `cdkd diff` at debug level.

The digest is truncated to 12 characters, after control characters are
stripped. `(unserializable)`, which is what prints for a digest nothing can
serialize, is longer than the window and is shown whole. A trailing `…` marks a
value that was actually cut, so a value exactly 12 characters long is not
mistaken for a truncated one.

The block is omitted when the field is present but empty, and when it is
absent. Absence means only that no skipped set was recorded: records written
before the field existed never carried one, and several state writers
deliberately drop it. The explanation sits at column zero, unlike the key rows,
and under `--show-nested` it is printed once for the whole tree.

## `state refresh-observed`

### Redaction by position

The readback is redacted by position against the existing record: the record's
own properties are expected to hold the unresolved
`{{resolve:secretsmanager:...}}` expression, which is written back over the
decrypted value AWS echoes. A record whose properties already hold plaintext
has nothing to redact from, which is why `cdkd scrub` runs first on such state.

Where the readback and the record cannot be lined up at a reference-bearing
position (AWS restructured the property, normalised a list element's identity
field, reordered a list, or the record holds a raw `Fn::Join` object where the
readback holds a string) cdkd cannot tell a resolved secret from an ordinary
literal, so it writes the mask `***` at that position.

### Public SSM parameters inside a longer value

A legacy record can hold a plain `{{resolve:ssm:...}}` reference inside a
longer string, such as `https://{{resolve:ssm:/app/host}}/health`: one imported
before import refused such baselines (state schema v10), written by an older
cdkd, or edited by hand. A current deploy stores a public reference resolved,
and a current import records no baseline for a record that still spells one,
including a record a selective import carries over from existing state.

A `String` or `StringList` parameter is public config, so the value AWS reports
is the right baseline when it is exactly the record's text with the parameter's
current value in place. A `SecureString` is a secret, and the reference is
written back over it. To tell the two apart, the command calls
`ssm:GetParameter` with `WithDecryption: false` in the stack's region, once per
reference. Nothing is decrypted, and a reference that is the whole value needs
no call. The reference is written back when the parameter is a `SecureString`,
when the call fails (a missing `ssm:GetParameter` permission included; the
command still succeeds), or when the reference may belong to another region: an
ARN naming one, a stack that reads outputs from another region, or a nested
stack whose parent stacks' cross-region reads cannot be established.

### Refusal order for malformed records

This is the one `cdkd state` subcommand that writes the record back, so it will
not proceed over a record whose shape it cannot read. Both refused shapes name
the stack and the region, before that stack's lock is taken, before anything is
read from AWS for it and before any write to it.

Over several stacks (`--all`, or more than one name) the shape of every
region-scoped record is checked before the first one is refreshed, so one
malformed record refuses the whole run and no stack is written. One case still
refuses only when its turn comes, after the stacks ahead of it have been saved:
a record edited between that check and its own refresh.

A legacy record with no region is refused after the confirmation prompt and
before the first stack is refreshed, so nothing is written. Its message
suggests migrating the record with any cdkd write, and prints a
`cdkd deploy '<stack>'` example only when the stack name renders exactly, holds
no `*` or `/` and does not start with `-`.

A list of resource objects in `resources` is the dangerous shape: its elements
look like records, so without the refusal they would be read back from AWS,
given a fresh baseline, and saved, still as a list. Repairing instead would
replace the only evidence that the record is broken with a well-formed one.

## `state orphan --resource`: values never copied

With `--force`, a reference that cannot be resolved live takes the value cached
in the removed record, and keeps the original intrinsic where there is none, or
where the cached value is one cdkd recognises as a credential (a
credential-named attribute, any custom resource's attribute, a known
secret-valued attribute such as AppSync's `ApiKey`, or a value holding a
credential-named field), the redaction mask, or an unresolved
`{{resolve:...}}` reference. Those are never copied into another record. The
same rule applies to `cdkd orphan --force`.
