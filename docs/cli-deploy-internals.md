---
title: cdkd deploy internals
description: "Why cdkd deploy's wait defaults are where they are, why it refuses a damaged state record, and how a no-change deploy merges Outputs it cannot resolve."
unlisted: true
---

# cdkd deploy internals

Background for contributors on three behaviours of `cdkd deploy`. The
user-facing descriptions are on
[cdkd deploy](cli-deploy.md) for the wait defaults,
[cdkd deploy: a damaged state record](cli-deploy-damaged-state.md) for the refusal,
and [cdkd deploy: the stack lock](cli-deploy-lock.md#an-output-that-cannot-be-resolved)
for the Outputs of a deploy that changes nothing.

## Why the wait defaults are where they are

Where CloudFormation and Terraform agree on what "done" means for a resource
type, cdkd matches them. Where they disagree, the default takes the definition
that suits dev/test iteration and `--full-wait` opts into the CloudFormation
one.

Even where both engines wait, cdkd's default may return early, but only when
all three of these hold:

1. **No in-deploy consumer.** Nothing the same deploy creates or resolves
   (`Fn::GetAtt`, downstream create calls, post-create verification) needs the
   waited-for state.
2. **No failure signal.** The wait cannot surface an error. A timeout means
   slow, not broken, so waiting buys certainty of when, never whether.
3. **Measurable in both modes.** The comparison tool offers both completion
   definitions, so a benchmark can report two like-for-like rows.

`AWS::CloudFront::Distribution` is the only type admitted under that clause.
The same test is why `--no-wait` is not the default:

| Type | Which condition fails |
| --- | --- |
| ACM certificate | (1): a downstream CloudFront or load balancer create fails on an un-issued certificate. |
| RDS | (1): `Endpoint` attributes are not final until `available`. |
| EC2 instance | (1): the instance-profile verification needs a `running` instance. |

ECS services follow Terraform by default. Nothing downstream needs a steady
service, and CloudFormation's steady-state wait is what makes a crash-looping
image hang a stack for many minutes.

These are per-run choices. A pipeline that wants CloudFormation's completion
semantics can pass `--full-wait` on every deploy.

`--no-wait` is deploy-only because no destroy path benefits from it. The NAT
gateway delete has to wait to keep teardown ordered, and the other eligible
types are leaves of the destroy graph, so their providers do not wait there.

## Why a damaged record is refused and not repaired

A state record is used as typed data without a field-by-field shape check, so a
hand-edited or truncated one can hold a string, a list, a number, a boolean or
`null` where a map or list belongs. Reading such a value as empty is not a safe
alternative, because an empty container leads to the same damage.

### `resources`

The `resources` map is what cdkd compares the template against to decide what
already exists. A `[]`, a number or a boolean enumerates no logical ids, so
every resource the template declares plans as a `CREATE`. cdkd would provision
a stack that is already standing, colliding on every deterministic name and
duplicating the rest, and then save a well-formed record over the only signal
that anything was wrong. A string enumerates one fabricated logical id per
character.

### One resource record

The change calculation looks each template resource up by its logical id, so a
record that is not an object reads as not in state. The deploy would plan a
`CREATE` for a resource that is already live. A named resource then fails on a
name collision, and an unnamed one is created a second time with the first copy
left unmanaged. A record with no `resourceType` would be planned as a type
change, which replaces the live resource.

The pre-lock `--recreate-via-cc-api` / `--recreate-via-sdk-provider` check
reads the record itself before the engine does, so it carries the same
refusals. Otherwise a `null` row named by either flag would be reported as
missing from state.

### A resource's `properties`

`properties` holds the resolved template values cdkd last sent. A non-object
makes every property the template declares read as missing from the deployed
resource. For a create-only property (an S3 `BucketName`, a DynamoDB
`TableName`) that is a replacement: the live resource would be deleted and
created again. An empty map declares nothing either, so it produces the same
replacement. `cdkd diff` repairs those maps and warns, because it provisions
nothing; its preview of such a record is wrong in exactly that direction.

### `outputs`

Enumerating a string yields one entry per character. A deploy rebuilds the
outputs before saving, so a six-character value would be written back as a
well-formed six-key map. The next deploy would then publish those fabricated
keys into the region's shared exports index, which every other stack's
`Fn::ImportValue` resolves against.

### `orphans`

A rollback that leaves a `DeletionPolicy: Retain` resource standing records it
under `orphans`, so the next deploy can adopt the resource back and not collide
with the name it still holds. Read unguarded, a wrong shape either reads as no
orphans at all, so the deploy provisions against retained resources that are
already in AWS, or fails in the adoption walk with a `TypeError` that names
neither the field nor the stack. The adoption pass keys what it adopts by
`logicalId`, so of two records sharing one only one would be adopted.

## Outputs a no-change deploy cannot resolve

An Output the resolver cannot resolve on a no-change deploy keeps its
previously stored value, while every sibling that did resolve is saved. cdkd
warns naming the Output.

Its literal export name is kept only if the previous deploy published it and
the export-name check still passes it. A name equal to a `NoEcho` parameter's
value, or containing one of 4 or more characters, is dropped with the same
warning a deploy gives.

Two shapes keep all of the previously stored Outputs instead:

- a failed Output whose `Export.Name` is itself an intrinsic;
- a merge that would put a secret expression beside a carried plain value.

## Related

- [cdkd deploy](cli-deploy.md)
- [cdkd deploy: a damaged state record](cli-deploy-damaged-state.md)
- [cdkd deploy: the stack lock](cli-deploy-lock.md)
- [State Store](state-management.md)
- [Choose a Wait Mode](wait-modes.md)
