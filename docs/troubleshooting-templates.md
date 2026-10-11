---
title: Templates cdkd refuses
description: "Why cdkd refuses a template before deploying it, and how to change the CDK app so it deploys."
---

# Templates cdkd refuses

Before it calls AWS, cdkd checks the synthesized template. It refuses a
template it could only deploy as something other than what the template
declares. For every entry on this page the fix is in the CDK app. Only the
unsupported-type refusal has a flag that overrides it.

On this page:

- [An unsupported resource type](#an-unsupported-resource-type)
- ["The following resources declare mutually exclusive properties"](#the-following-resources-declare-mutually-exclusive-properties)
- ["The following resources declare a nested property block without a member it requires"](#the-following-resources-declare-a-nested-property-block-without-a-member-it-requires)
- ["Properties validation failed": a list where an object is expected, or the reverse](#properties-validation-failed-a-list-where-an-object-is-expected-or-the-reverse)
- ["The following custom resources pass a secure dynamic reference"](#the-following-custom-resources-pass-a-secure-dynamic-reference)
- ["OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table](#opentableformatinput-iceberginput-icebergtableinput-cannot-be-deployed-on-a-glue-table)
- ["SelfManagedKafkaEventSourceConfig.ConsumptionMode cannot be sent by cdkd yet"](#selfmanagedkafkaeventsourceconfig-consumptionmode-cannot-be-sent-by-cdkd-yet)

## An unsupported resource type

```
The following resource types are not supported by cdkd:
  - AWS::AppMesh::Mesh
      AWS reports this type as NON_PROVISIONABLE (Cloud Control API cannot
      manage it) and cdkd has no SDK provider for it.
      Request support: https://github.com/go-to-k/cdkd/issues/new?title=...

To attempt deployment anyway (Cloud Control will likely fail for
NON_PROVISIONABLE types), re-run with: --allow-unsupported-types AWS::AppMesh::Mesh
```

A type that slips past pre-flight fails at provisioning time instead:

```
No provider available for resource type: AWS::CustomService::Resource. This
resource type is not supported by Cloud Control API and no SDK provider is
registered.
```

cdkd provisions a resource through one of its own SDK providers, or through
the AWS Cloud Control API when it has no provider for the type. This error
means neither is available, for one of three reasons:

- AWS reports the type as `NON_PROVISIONABLE`, so Cloud Control cannot manage
  it.
- cdkd blocks the type on Cloud Control until it has a dedicated provider.
- The type is not an `AWS::` type at all.

What you can do:

- **Request the type.** The message carries a link that opens a pre-filled
  issue for exactly this type.
- **Deploy now, if the type is only blocked by cdkd.**

  ```bash
  cdkd deploy MyStack --allow-unsupported-types AWS::AppMesh::Mesh
  ```

  The flag routes the named type through Cloud Control. It takes type names,
  so each one is an explicit choice. For a `NON_PROVISIONABLE` type Cloud
  Control cannot manage it either, and the deploy still fails.
- **Check coverage.** [Supported Resources](supported-resources.md) lists
  cdkd's per-type coverage, and AWS lists
  [what Cloud Control supports](https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html).

[Deploy: safety & compatibility flags](cli-deploy-safety.md) documents
`--allow-unsupported-types`.

## "The following resources declare mutually exclusive properties"

```
The following resources declare mutually exclusive properties:
  - BadRoute (AWS::EC2::Route) declares DestinationCidrBlock and DestinationIpv6CidrBlock
      CloudFormation and the EC2 CreateRoute API accept exactly one destination per route.
      cdkd would send only DestinationCidrBlock; DestinationIpv6CidrBlock would be dropped.
      Deleting the dropped keys changes nothing cdkd sends — but if the LIVE resource was
      created from one of them, making DestinationCidrBlock the sole value is a create-only
      change that REPLACES it.
      Declare at most one of: DestinationCidrBlock / DestinationIpv6CidrBlock / DestinationPrefixListId
```

The template declares two or more properties of which AWS accepts only one.
CloudFormation rejects the same template, so no `--allow-*` flag overrides the
refusal. cdkd runs the check on every deploy before any AWS call, including a
deploy where the resource is unchanged.

`cdkd diff` reports no change for such a resource, but it warns that some of
the declared properties cannot be sent as declared.

Remove every key except the one the message says cdkd would send:

```typescript
new ec2.CfnRoute(this, 'Route', {
  routeTableId: rt.ref,
  gatewayId: igw.ref,
  destinationCidrBlock: '0.0.0.0/0',
  // delete this line; only one destination is allowed:
  // destinationIpv6CidrBlock: '::/0',
});
```

> [!WARNING]
> Check what the live resource was created from first. If it was created from
> one of the dropped keys, making a different key the sole value is a
> create-only change and replaces the resource.

If the resource needs a different property per environment, put each behind a
condition whose other arm is `AWS::NoValue`. cdkd does not refuse a key behind
an unresolved intrinsic, and exactly one of the two survives resolution:

```json
{
  "DestinationCidrBlock": {
    "Fn::If": ["IsV4", "0.0.0.0/0", { "Ref": "AWS::NoValue" }]
  },
  "DestinationIpv6CidrBlock": {
    "Fn::If": ["IsV4", { "Ref": "AWS::NoValue" }, "::/0"]
  }
}
```

## "The following resources declare a nested property block without a member it requires"

```
The following resources declare a nested property block without a member it requires:
  - Service (AWS::ECS::Service): DeploymentConfiguration.DeploymentCircuitBreaker is missing required member Rollback
```

The template contains a nested block that leaves out a member the resource
type's schema requires in that block. If cdkd sent the block as written, the
service might accept it and replace the live block with it, which resets the
member that was left out. The block in the message above would switch a live
rollback off.

Declare the missing members:

```typescript
new ecs.CfnService(this, 'Service', {
  // ...
  deploymentConfiguration: {
    deploymentCircuitBreaker: { enable: true, rollback: true },
  },
});
```

cdkd runs the check on every deploy before any AWS call. CloudFormation
refuses the same template, so no `--allow-*` flag overrides the refusal.

### What the nested-block check does not refuse

- An absent block is never refused, only a present and incomplete one.
- A block, element or member behind an unresolved intrinsic (`Fn::If`, `Ref`)
  is not refused.
- The check covers the resource types CloudFormation enforces these lists on.
- Array elements are named by index (`Policies[1]`).

## "Properties validation failed": a list where an object is expected, or the reverse

```
Properties validation failed: the following resources declare a property whose kind contradicts the resource type's schema:
  - Queue (AWS::SQS::Queue): #/Tags: expected type: JSONArray, found: JSONObject
```

A template property is an object where the schema requires a list, or a list
where it requires an object. The usual source is an `addPropertyOverride` that
wrote the wrong kind. Give the property the kind the schema declares:

```typescript
(queue.node.defaultChild as sqs.CfnQueue).addPropertyOverride('Tags', [
  { Key: 'team', Value: 'platform' }, // a list, not { Key, Value }
]);
```

cdkd runs the check on every deploy before any AWS call. CloudFormation
refuses the same template with the same words, so no `--allow-*` flag
overrides the refusal.

### What the kind check does not refuse

- Only a list against an object is refused. A scalar mismatch is left to
  CloudFormation's and the service's own checks.
- A property is checked only where the schema admits exactly one of the two
  kinds.
- A value that is an unresolved intrinsic (`Ref`, `Fn::If`, `Fn::Split`) is
  not refused.
- Array elements are named by index (`Tags[1]`).

## "The following custom resources pass a secure dynamic reference"

```
The following custom resources pass a secure dynamic reference ({{resolve:secretsmanager:...}} / {{resolve:ssm-secure:...}}) in their properties:
  - DbInit: Password
```

A custom resource (`Custom::*` or `AWS::CloudFormation::CustomResource`) has a
property holding a `{{resolve:secretsmanager:...}}` or
`{{resolve:ssm-secure:...}}` reference, directly or inside an intrinsic.
CloudFormation does not support secure dynamic references in custom resources.
cdkd refuses before resolving anything, so the secret never reaches the
handler's event.

- Pass the secret's name or ARN instead, and have the handler read the value
  (grant its role `secretsmanager:GetSecretValue` or `ssm:GetParameter`).
- For a value that is not secret, use a plain `{{resolve:ssm:...}}` parameter.

The check runs on every deploy, including one where the resource is
unchanged, and no `--allow-*` flag overrides it. `cdkd destroy` does not run
the check, so a stack that already carries such a resource can still be torn
down.

A plain `{{resolve:ssm:...}}` reference that names a SecureString parameter
passes this check. cdkd refuses it later, when the handler would be invoked:
see
["Custom resource X: Y resolved to the value of a secret"](troubleshooting-deploy.md#custom-resource-x-y-resolved-to-the-value-of-a-secret).

## "OpenTableFormatInput.IcebergInput.IcebergTableInput cannot be deployed" on a Glue table

```text
AWS::Glue::Table IcebergTable: OpenTableFormatInput.IcebergInput.IcebergTableInput
cannot be deployed by AWS in any shape, so cdkd refuses it before calling Glue
(issue #1454).
```

AWS accepts no shape of this property: `glue:CreateTable` rejects it, and
CloudFormation rolls the same template back. cdkd refuses a create that
declares it, before calling Glue.

Move the table metadata into `TableInput` and leave `IcebergInput` carrying
only the create-time directive:

```yaml
TableInput:
  Name: events_iceberg
  TableType: EXTERNAL_TABLE          # required for Iceberg
  StorageDescriptor:
    Location: s3://your-bucket/iceberg/events/
    Columns:
      - Name: event_id
        Type: string
OpenTableFormatInput:
  IcebergInput:
    MetadataOperation: CREATE        # Version: '2' is also accepted
```

Glue writes the Iceberg metadata itself. The created table comes back with
`Parameters.table_type = ICEBERG` and a populated `Parameters.metadata_location`.

### When cdkd warns about `IcebergTableInput` and does not refuse

- **An update.** Adding `IcebergTableInput` to a table that is already
  deployed produces a warning and a successful deploy. cdkd sends nothing for
  the property, so it is ignored.
- **A `cdkd rollback`.** A rollback re-applies what cdkd recorded in state and
  does not read your template, so you could not fix a refusal there.

See "Glue table Iceberg support" in
[Supported Resources](supported-resources.md) for the background.

## "SelfManagedKafkaEventSourceConfig.ConsumptionMode cannot be sent by cdkd yet"

```text
AWS::Lambda::EventSourceMapping MyMapping: SelfManagedKafkaEventSourceConfig.ConsumptionMode
cannot be sent by cdkd yet — the AWS SDK for JavaScript does not model the member, so it
would be dropped from the CreateEventSourceMapping request without an error (issue #3848).
Remove ConsumptionMode from SelfManagedKafkaEventSourceConfig to deploy the mapping without it.
```

The CloudFormation schema declares `ConsumptionMode` (`Stream` or `Queue`) on a
self-managed Kafka event source mapping, but the AWS SDK cdkd calls Lambda
through drops it from the request. cdkd refuses a create that declares it, and
an update that adds or changes it, rather than deploy a mapping without the
mode you asked for.

Remove `ConsumptionMode` from `SelfManagedKafkaEventSourceConfig`.

Sending the resource through the Cloud Control API does not help, because
Lambda rejects the member there too (`Unsupported 'ConsumptionMode' parameter
for given event source mapping type`). A `cdkd rollback` or
`cdkd drift --revert` only warns, because those commands re-apply a recorded
configuration.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
