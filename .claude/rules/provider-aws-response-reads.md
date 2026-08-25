---
description: Reading AWS responses in a provider - declared type vs populated field, id forms that break import(), never inferring a default from a malformed value
paths:
  - 'src/provisioning/providers/**'
---

# Provider Pattern - reading AWS responses

Provider interface, registry, Custom Resources, and "Adding a New SDK Provider": [providers.md](providers.md).

## Reading a field off an AWS response: type != populated

An AWS SDK v3 response TYPE declaring a field does NOT mean the API you called
populates it. The models are shared across operations, so a `List*` summary can
declare `Tags?: Tag[]` and never carry tags. AWS documents the exception on the
COMMAND, not the model:

> IAM resource-listing operations return a subset of the available attributes
> for the resource. For example, this operation does not return tags, even
> though they are an attribute of the returned object. To view all of the
> information for an instance profile, see GetInstanceProfile.

`iam-instance-profile-provider` carried exactly this defect until PR #1127:
`import()` read tags off the `ListInstanceProfiles` summary, which typechecked
and always saw `undefined`. Because a tag-walk non-match is not an error, the
walk simply never matched and `cdkd import` reported the resource as
**not-found** — a silent wrong answer, not a crash. The provider's unit tests
hand-fed inline `Tags` and so agreed with the bug.

**When consuming a field from a `List*` / `Describe*` response:**

- Read the command doc
  (`node_modules/@aws-sdk/client-*/dist-types/commands/<Op>Command.d.ts`), not
  just the model in `models/models_*.d.ts`. Types prove SHAPE; only the command
  doc (or a live call against a populated account) proves POPULATION.
- Prefer a per-candidate `Get*` when the list form is documented as a subset.
  The extra call is the correct cost.
- A live probe that comes back empty because the account has no such resource is
  **inconclusive**, not confirmation.
- Ask of any test: "would this still pass if the API returned nothing for this
  field?" If yes, it pins your assumption, not the behavior.

## A read API that accepts MORE id forms than the write APIs breaks `import()`

`import()` verifies a physical id with a `Get*` / `Describe*` and then RECORDS
it, so the id has to satisfy every WRITE call the type will ever make — and the
read API is routinely the more permissive of the two. `AWS::SSM::Parameter` is
the live case (issue #1824 review): `GetParameterRequest.Name` accepts a NAME, a
full ARN, and a `name:version` / `name:label` selector, while
`PutParameterRequest.Name` and `DeleteParameterRequest.Name` both say "You can't
enter the Amazon Resource Name (ARN) for a parameter, only the parameter name
itself" and constrain the name charset to `a-zA-Z0-9_.-` plus `/`. So
`cdkd import --resource Param=arn:aws:ssm:...:parameter/foo` verified cleanly and
the damage landed later and elsewhere — the next `cdkd deploy` failing at
`PutParameter` and `cdkd destroy` at `DeleteParameter`.

Three things about fixing it generalize:

- **Refuse at the boundary where the value ENTERS** (`import()`, against
  `resolveExplicitPhysicalId`'s answer), before the verification call. A guard
  further in cannot help: the write call that rejects the id runs BEFORE any
  later consumer of the physicalId, so a guard behind it is unreachable in
  production and testable only by priming a mock to accept a wire shape AWS
  rejects — which is how the first attempt at this shipped an inert guard plus a
  test that endorsed an impossible API.
- **Prefer refusing over NORMALIZING unless the mapping is unambiguous for every
  shape.** Deriving `foo` from `arn:...:parameter/foo` looks mechanical and is
  not: the name's leading `/` IS the ARN separator, so that ARN is equally the
  ARN of `foo` and of `/foo` (`aws-cdk-lib`'s `arnForParameterName` renders both
  identically, which is why CDK needs an explicit `simpleName` flag), and a
  cross-account SHARED parameter has no name form at all. A wrong normalization
  writes a physicalId naming a DIFFERENT resource — a silent wrong-resource
  write — where a refusal is loud and one edit away from fixed.
- **Derive the predicate from the documented constraint, not from the shape you
  saw.** Refusing a COLON (illegal in any writable parameter name) covers the
  ARN and the selector at once; refusing an `arn:` prefix would have covered only
  the reported half.

## Never infer a default from a possibly-malformed value

`(config['Status'] as string) || 'Suspended'` reads correctly and is wrong: when
`config` is a STRING / array / unresolved intrinsic rather than the object the
template was supposed to carry, the index yields `undefined` and the `||`
substitutes the default — frequently the OPPOSITE of what the template declared,
with no error anywhere. `VersioningConfiguration: 'Enabled'` on an
`AWS::S3::Bucket` turned versioning OFF on a live bucket (issue #1471); the shape
was measured at 16 sites across 5 providers.

**The `??` spelling is the same bug** (issue #1493), it defaults on MORE than
`||` did (`??` also substitutes on an explicit `null`), and measuring it is
where the work actually goes wrong. Three greps, in increasing order of
usefulness:

- `\] \?\? '` — the obvious one, and it finds **zero** real sites. The cast sits
  INSIDE the parens.
- `as [A-Za-z]+\) \?\? '` — better, still blind to every `as string | undefined`,
  quoted-union and line-wrapped site, four of which #1493 had to fix.
- `as [A-Za-z<>,| ]+\) \?\? '` — the class-covering form. Follow it with a hand
  pass for wrapped sites; a purely mechanical count will be short.

Do not trust a cast-specific pattern in either spelling:
`(properties['AuthType'] as FunctionUrlAuthType) || 'NONE'` survived the #1471
sweep for exactly that reason and kept defaulting a blank AuthType to a PUBLIC
Lambda function URL.

**And check the GATE in front of the guard, not just the read.** A guard behind
`if (container)` is skipped entirely by a FALSY malformed value — `Source: ''`
still built a `NO_SOURCE` project after the guard was added. Use `!= null`, per
the "cover the CREATE path" rule above; #1493 shipped the gate bug and a
reviewer caught it. Roll the
guard onto the sites that INDEX A NESTED CONTAINER; a top-level
`properties['X'] ?? 'default'` read cannot hit rule 2 at all (the bag is always
an object) and refusing a non-string there is a separate, riskier decision —
issue #1513 settled it PER SITE, and `config-shape.ts`'s header records the
full split.

**A silent DROP is the sibling class, and `readConfigString` does not cover
it** (issue #1493 item 2). Where the defaulting bug substitutes a value the
template did not ask for, this one omits the block entirely: a provider that
picks between two accepted shapes by PROBING member presence —
`dest?.['BucketArn'] || dest?.['Format'] ? dest : dest?.['S3BucketDestination']`
— indexes every probe of a malformed `dest` to `undefined`, falls through to an
equally-`undefined` nested bag, and the caller's `s3Dest ? … : undefined` sends
the request without the destination. Nothing is defaulted, so no guard in
`config-shape.ts` fires. Two rules, both learned on the S3 analytics /
inventory sites:

- **Refuse on create, warn on update** — the same split as the update-path
  question below, for the same reason (a rollback replays `update()` with a
  historical STATE record as the desired bag). The appliers take an optional
  `onUnusable` callback; the create-path caller omits it and the update-path
  caller passes `this.logger.warn`.
- **Probe every member the readers accept.** The S3 branch probe omitted
  `Bucket` although the reader below it was `s3Dest['BucketArn'] ??
  s3Dest['Bucket']`, so a `{ Bucket }`-only block took the nested branch, found
  nothing, and dropped — the same silent drop one shape over. A probe narrower
  than its reader is a bug by construction.

Report the CFn path of the branch you PICKED, not a hardcoded one (item 3): the
flattened branch's bag IS `dest`, so a refusal naming
`…Destination.S3BucketDestination` points at a key the user's template does not
contain.

**A top-level site takes three questions, not one** (issue #1513):

- **Can the field legitimately arrive as a NUMBER?** CFn coerces scalars and
  cdkd does not, so an unquoted YAML `IpProtocol: -1` / `Qualifier: 1` deploys
  fine today and a refusal would break a working template. Those sites pass
  `{ coerceNumber: true }`; an enum-valued field (`InstanceType`,
  `AuthorizationType`, `Status`, `Domain`, `BillingMode`) does NOT — a number
  there is a bug.
- **Is the site on the UPDATE path?** Then WARN, do not throw
  (`{ onUnusable: (m) => this.logger.warn(m) }`). `rollback-executor.ts` replays
  a rollback via `provider.update(..., previousState.properties, ...)`, so the
  desired bag can be a historical STATE record — a refusal there makes the
  resource UN-ROLLBACKABLE with no template-side remedy. Throw on CREATE, where
  the value is always template-borne. (Same rule as
  `update-refusal-breaks-rollback-replay`.)
- **Is the read in a helper the DELETE / diff paths also reach?** Then leave it
  unguarded and guard the create CALL SITE instead. `EC2Provider`'s
  `buildIpPermission` is textually a top-level read but is also reached from
  `deleteSecurityGroupIngress` and from the REVOKE half of the inline-rule diff,
  both carrying state-borne rules — a guard inside it would break destroy.

Use `src/provisioning/config-shape.ts` instead of hand-writing the guard:

```ts
// nested container (may itself be malformed)
const status = readConfigString(
  versioningConfig, 'Status', 'Suspended', 'AWS::S3::Bucket VersioningConfiguration'
);
// top-level field — keep the properties['X'] read at the call site
const scope = requireConfigString(properties['Scope'], 'REGIONAL', 'AWS::WAFv2::WebACL Scope');
```

Three things about it are non-obvious and each was forced by the real tree:

- **Guard the DESIRED side only.** `previousProperties` comes from cdkd STATE,
  not the user's template. Refusing a malformed value recorded there by an older
  binary makes the stack permanently undeployable — editing the template does not
  help, because the previous side stays malformed until a deploy succeeds. An
  earlier attempt guarded both sides and had to be reverted.
- **Validate the FIELD, not just the container.** `{ Status: null }` and
  `{ Status: '' }` both pass a `typeof === 'object'` check and still fall through
  to the default. An ABSENT key must keep defaulting, though — `{}` legitimately
  means Suspended.
- **Cover the CREATE path.** A truthiness gate (`if (versioningConfig)`) lets a
  truthy-but-malformed value through on create only, so create and update
  disagree; use `!= null` so both refuse it. Same rationale as the
  OwnershipControls / BucketEncryption gates.

Pre-flight template validation is NOT the right layer for the field rules: at
pre-flight time intrinsics are unresolved, so a legitimate `Fn::If`-valued block
is an object whose inner key does not exist yet and a field check would reject
valid templates.

**A property COMBINATION rule is the exception, and it is pre-flight's job**
(issue #1634). Where a field rule asks what a value IS — undecidable before
resolution — a mutually-exclusive rule asks only which top-level keys are
unconditionally PRESENT, which the raw template already answers. It also has to
live there, because a provider-side refusal is only reachable on a
template-borne CREATE: once the resource exists the diff classifies NO_CHANGE,
the provider is never called, and the invalid template deploys forever (exactly
what `AWS::EC2::Route`'s #1566 refusal could not catch after #1591 normalized
both diff sides). `src/provisioning/mutually-exclusive-properties.ts` holds the
rule table and `ProviderRegistry.validateResourceProperties` applies it, ahead
of the silent-drop routing chatter. The intrinsic constraint above still binds
and is what makes the check safe: a key behind an unresolved intrinsic counts
as UNKNOWN, never as declared, since its `Fn::If` arm can resolve to
`AWS::NoValue` — so the check refuses only two or more unconditionally present
keys, and a combination it lets through is still caught by the provider's own
create-path refusal. Add a rule ONLY for a combination AWS itself rejects:
there is deliberately no `--allow-*` escape hatch (the defect is in the
template, not in cdkd), so a wrong entry blocks a valid deploy with no way
around it.
