---
title: Physical IDs in state
description: "What the physicalId in a cdkd state record is, which resource types store a composite ID joined with |, and how that ID differs from what Ref returns."
---

# Physical IDs in state

Every resource in a state record has a `physicalId`: the value cdkd uses to
find that resource in AWS again. This page lists what the ID looks like for
common types, which types store several values joined with `|`, and why the ID
can differ from what the template's `Ref` returns.

```bash
cdkd state resources MyStack    # the resources recorded for a stack
cdkd state show MyStack         # the full record, with properties and outputs
```

This page is part of [State Store](state-management.md).

## What a physical ID is

For most resource types the physical ID is the value CloudFormation's `Ref`
returns for the resource:

| Resource type | Example `physicalId` |
| --- | --- |
| `AWS::S3::Bucket` | `my-bucket-name` |
| `AWS::Lambda::Function` | `arn:aws:lambda:us-east-1:123456789012:function:MyFunc` |
| `AWS::IAM::Role` | `MyRole` |
| `AWS::DynamoDB::Table` | `MyTable` |
| `AWS::SQS::Queue` | `https://sqs.us-east-1.amazonaws.com/123456789012/MyQueue` |
| `Custom::MyResource` | Any string the handler returned |

The ID is whatever the provider that created the resource needs in order to
address it again, so it can differ from the ID CloudFormation records for the
same resource. When a cdkd command asks you for a physical ID, read it from
`cdkd state show` or `cdkd state resources`. The AWS console may show a
different value.

## Composite IDs: several values joined with `|`

Some resources have no single AWS identifier. A Glue table is addressed by its
database and its table name, and an API Gateway method by its API, its
resource and its HTTP method. For these types cdkd stores the identifying
values joined with `|`, which is the convention Cloud Control API uses:

```json
{
  "MyGlueTable": { "physicalId": "my_database|my_table" },
  "MyGetMethod": { "physicalId": "a1b2c3d4e5|xy9z8w|GET" },
  "MyARecord":   { "physicalId": "Z1D633PJN98FT9|www.example.com.|A" },
  "MyEip":       { "physicalId": "52.1.2.3|eipalloc-0abc123def456789a" }
}
```

The joined value is what `cdkd state show` prints. It is also what
`cdkd import --resource '<logicalId>=<physicalId>'` expects.

> [!IMPORTANT]
> `|` is the shell pipe character, so quote a composite ID on a command line:
>
> ```bash
> cdkd import MyStack --resource 'MyGlueTable=my_database|my_table'
> ```
>
> A JSON mapping file passed with `--resource-mapping` needs no escaping.

### Formats by resource type

| Resource type | `physicalId` format |
| --- | --- |
| `AWS::ApiGateway::Method` | `<restApiId>\|<resourceId>\|<httpMethod>` |
| `AWS::AppSync::ApiKey` | `<apiId>\|<apiKeyId>` |
| `AWS::AppSync::DataSource` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::EC2::EIP` | `<publicIp>\|<allocationId>` |
| `AWS::EC2::NetworkAclEntry` | `<networkAclId>\|<ruleNumber>\|<egress>`, where `egress` is `true` or `false` |
| `AWS::EC2::Route` | `<routeTableId>\|<destination>`, the CIDR block or prefix list the route declares |
| `AWS::EC2::SecurityGroupIngress` | `<groupId>\|<ipProtocol>\|<fromPort>\|<toPort>`; an omitted port is `-1` |
| `AWS::EC2::VPCGatewayAttachment` | `<internetGatewayId>\|<vpcId>`; CloudFormation's own order is VPC first |
| `AWS::Glue::Table` | `<databaseName>\|<tableName>` |
| `AWS::Lambda::EventInvokeConfig` | `<functionName>\|<qualifier>`; a bare function name means `$LATEST` |
| `AWS::Route53::RecordSet` | `<hostedZoneId>\|<name>\|<type>` |
| `AWS::S3Tables::Namespace` | `<tableBucketARN>\|<namespaceName>` |
| `AWS::S3Tables::Table` | `<tableBucketARN>\|<namespace>\|<name>` |

### Edge cases

**Two types accept a composite ID but do not store one.**

- For `AWS::ECS::Service` cdkd stores the service ARN. `--resource` also
  accepts `<clusterArn>|<serviceName>`.
- For `AWS::Lambda::Permission` cdkd stores the bare statement ID. cdkd also
  reads the `<functionArn>|<statementId>` form, which a record written by an
  older cdkd may hold.

**A value that itself contains `|`.** cdkd does not escape the separator. If
one of the values to be joined would contain `|`, `cdkd deploy` refuses before
it creates anything and names the value. Glue table names, Glue database names
and Route 53 record names are the exceptions: cdkd splits those IDs using the
names recorded in the resource's `properties`. The contributor page
[State schema internals](state-schema-internals.md#composite-pipe-delimited-physicalids)
has the exact rules.

## A composite ID is not what `Ref` returns

You do not need to do anything about this difference. It shows only when you
compare `cdkd state show` with a stack output.

CloudFormation's `Ref` for a composite type returns its own value, which is
usually one of the joined values. cdkd translates the stored ID before it
hands the value to a `Ref`, an `Fn::Sub` or an output. A template therefore
receives the same value it would receive from `cdk deploy`.

| Resource type | `Ref` returns |
| --- | --- |
| `AWS::ApiGateway::Method` | An AWS-generated ID; cdkd passes the composite through |
| `AWS::AppSync::ApiKey` | The API key ARN |
| `AWS::AppSync::DataSource` | The data source ARN |
| `AWS::AppSync::Resolver` | The resolver ARN |
| `AWS::EC2::EIP` | The public IP |
| `AWS::Glue::Table` | The table name |
| `AWS::Route53::RecordSet` | The record name |
| `AWS::S3Tables::Namespace`, `AWS::S3Tables::Table` | The namespace or table name |

### Records with no recorded ARN

**An AppSync resource.** For the three AppSync types the
ARN is not one of the joined values, so cdkd reads it from an attribute that
the provider records at create time. A record lacks that attribute in two
cases: an older cdkd wrote the record, or `cdkd import` could not build the
ARN, in which case it warned at import time.

On such a record, `Ref` returns the composite ID. An `Fn::GetAtt` on the ARN
makes `cdkd deploy` read the resource from AWS once and record the real ARN.
The deploy fails if it cannot read the resource.

**`cdkd export` blocks a resource and names a missing attribute.**
[`cdkd export`](cli-export.md) needs the same recorded attribute for the types
CloudFormation imports by ARN. Deploy the stack once so that cdkd records the
attribute, then export again.

## Related

- [State Store](state-management.md): where state lives and what a
  record contains
- [Import Existing Resources](import.md): where you pass a physical ID to
  cdkd
- [`cdkd state`](cli-state.md): `state show` and `state resources`
