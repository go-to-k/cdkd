---
title: Importing by resource type
description: "The physical id cdkd import expects for each resource type, the types with special import behaviour, and how the Cloud Control API fallback imports any other type."
---

# Importing by resource type

This page lists the value `--resource` expects for each resource type, and
the types whose import behaves in a way worth knowing. Search it for your
type, for example `AWS::Glue::Table`.

```bash
cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads

# quote a value that contains |
cdkd import MyStack --resource 'GetMethod4B5C6D7E=a1b2c3d4e5|xy9z8w|GET'
```

The value after `=` is the resource's physical id: the id cdkd stores for the
resource, which `cdkd state show` and `cdkd state resources` print. It is not
always the id CloudFormation shows. The tables below give the form for each
type where it needs spelling out.

[Which resource types can be imported](import.md#which-resource-types-can-be-imported)
says, for every type, whether cdkd finds it without a flag.

## Types cdkd finds without a flag

cdkd looks these types up by the name in your template, so you normally pass
nothing. When you do pass `--resource` for one, use this form:

| Type | `--resource` value |
| --- | --- |
| `AWS::SSM::Parameter` | The parameter name only. |
| `AWS::EC2::EIP` | An `eipalloc-...` allocation id, a public IP, or `<publicIp>\|<allocationId>`. |
| `AWS::EC2::InternetGateway` | The `igw-...` id. |
| `AWS::EC2::RouteTable` | The `rtb-...` id. |
| `AWS::EC2::NetworkAcl` | The `acl-...` id. |
| `AWS::EC2::Instance` | The `i-...` id. |
| `AWS::ECS::Service` | The service ARN, or `<clusterArn>\|<serviceName>`. |
| `AWS::Glue::Table` | `<databaseName>\|<tableName>`, or the bare table name. |
| `AWS::Pipes::Pipe` | The pipe name. |
| `AWS::EMR::Cluster` | The cluster id `j-XXXX`. |

Notes on single types:

- **`AWS::EC2::EIP`**: whichever form you pass, cdkd stores
  `<publicIp>|<allocationId>`.
- **`AWS::EC2::Instance`**: an instance that is terminated or shutting down is
  not adopted.
- **`AWS::ECS::Service`**: cdkd stores the service ARN.
- **`AWS::Pipes::Pipe`** and **`AWS::Budgets::Budget`**: the template's `Name`
  and `Budget.BudgetName` find them without a flag.
- **`AWS::BedrockAgentCore::Browser`** and
  **`AWS::BedrockAgentCore::CodeInterpreter`**: these stand for the defaults
  AWS manages. cdkd finds them with `GetBrowser` and `GetCodeInterpreter` and
  needs no `--resource`.

### `AWS::SSM::Parameter`

Pass the parameter name. cdkd refuses an ARN and a `name:version` or
`name:label` selector, and the error names the value to pass instead.

The reason is that `GetParameter` accepts those forms while `PutParameter`
and `DeleteParameter` reject them. A parameter adopted under an ARN would
import cleanly and then break the next deploy and destroy.

### `AWS::Glue::Table`

cdkd stores and displays a Glue table's id as `<databaseName>|<tableName>`.
You can also pass the bare table name, which is the id CloudFormation records.
cdkd then pairs it with the `DatabaseName` in your template.

Edge cases:

- **A name that itself contains `|`.** A table or database name that
  contains `|` is adopted when it is paired with the template's own
  `DatabaseName`, either way round.
- **More than one possible reading.** cdkd also tries a value with a `|` as a
  whole table name in the template's database. When more than one reading
  names an existing table, the import refuses instead of guessing.

### `AWS::Route53::HostedZone`

cdkd finds the hosted zone by the `Name` in your template, using
`ListHostedZonesByName`. The imported record holds the same `Id` and
`NameServers` attributes a deploy records, so `Fn::GetAtt <Zone>.NameServers`
and CDK's `zone.hostedZoneNameServers` resolve on an imported zone. A zone
with no delegation set records an empty list.

Edge cases:

- **A public and a private zone share the name.** The `VPCs` property in your
  template decides which one is meant. If the name is still ambiguous, the
  plan shows the row as failed and names
  `--resource <logicalId>=<hostedZoneId>`.
- **cdkd cannot read the name servers.** When cdkd found the zone by name,
  reading the name servers costs one extra `GetHostedZone` call. If that call
  fails, the zone is still adopted with a warning, and attributes already in
  state are kept. With `--resource` there is no extra call, so a denied
  `GetHostedZone` fails that row.
- **The attributes are missing after an import.** A plain `cdkd deploy` does
  not add them, because it does not update a zone that has not changed. Run
  the import again for that zone with `--force`, or change the zone in your
  template.

## Types that need `--resource`

cdkd cannot look these types up, so you name each one. You pass nothing when
CloudFormation can supply the id: under `--migrate-from-cloudformation`, or
with `--auto` and a CloudFormation stack of the same name.

### Resources with no name to look up

| Type | `--resource` value |
| --- | --- |
| `AWS::IAM::Policy` | The physical id of the inline policy. |
| `AWS::IAM::AccessKey` | The `AKIA...` access key id. |
| `AWS::IAM::UserToGroupAddition` | The physical id. |
| `AWS::CloudWatch::AnomalyDetector` | Any stable id. |
| `AWS::Scheduler::Schedule` | The physical id. |
| `AWS::CloudFormation::WaitConditionHandle` | Any id, or none. |
| `AWS::ApiGateway::Account` | Any id. |
| `AWS::CloudFront::OriginAccessControl` | The `E...` id. |

- **`AWS::IAM::AccessKey`**: cdkd verifies the id with
  `GetAccessKeyLastUsed`. An imported key has no stored `SecretAccessKey`,
  because IAM returns the secret only when the key is created. A template that
  reads `Fn::GetAtt [<key>, SecretAccessKey]` cannot resolve it for an
  imported key. Replace the key if the secret is needed.
- **`AWS::CloudWatch::AnomalyDetector`**: cdkd records the id you give and
  derives its own id the next time the detector is replaced.
- **`AWS::Scheduler::Schedule`**: the template's `Name` and `GroupName` also
  find the schedule without a flag.
- **`AWS::CloudFormation::WaitConditionHandle`**: cdkd records the id as
  given, and uses a placeholder when you pass none. Under
  `--migrate-from-cloudformation` it records CloudFormation's pre-signed URL.
- **`AWS::ApiGateway::Account`**: there is one per account and region and it
  has no id of its own, so cdkd records the id without an AWS call. A deploy
  records `ApiGatewayAccount`. `cdkd destroy` clears the region's
  `CloudWatchRoleArn`.
- **`AWS::CloudFront::OriginAccessControl`**: cdkd verifies the id with
  `GetOriginAccessControl`.

### Parts of a parent resource

| Type | `--resource` value |
| --- | --- |
| `AWS::ApiGateway::Method` | `<restApiId>\|<resourceId>\|<httpMethod>` |
| `AWS::AppSync::DataSource` | `<apiId>\|<name>` |
| `AWS::AppSync::Resolver` | `<apiId>\|<typeName>\|<fieldName>` |
| `AWS::AppSync::ApiKey` | `<apiId>\|<apiKeyId>` |
| `AWS::S3Tables::Namespace` | `<tableBucketARN>\|<namespaceName>` |
| `AWS::S3Tables::Table` | `<tableBucketARN>\|<namespace>\|<name>` |
| `AWS::Route53::RecordSet` | `<hostedZoneId>\|<name>\|<type>` |
| `AWS::EC2::Route` | `<routeTableId>\|<destination>` |
| `AWS::EC2::NetworkAclEntry` | `<networkAclId>\|<ruleNumber>\|<egress>` |
| `AWS::EC2::SecurityGroupIngress` | The `sgr-...` rule id. |

These types take the plain physical id: `AWS::ApiGateway::Authorizer`,
`AWS::ApiGateway::Resource`, `AWS::ApiGateway::Deployment`,
`AWS::ApiGateway::Stage`, `AWS::ApiGatewayV2::Stage`,
`AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`,
`AWS::ApiGatewayV2::Authorizer`, `AWS::AppSync::GraphQLSchema`,
`AWS::ElasticLoadBalancingV2::Listener`, `AWS::EFS::MountTarget`,
`AWS::RDS::DBProxyTargetGroup`.

- **`AWS::Route53::RecordSet`**: write `<name>` exactly as the template spells
  it. CDK emits a trailing dot.
- **`AWS::EC2::Route`**: `<destination>` is the IPv4 CIDR, the IPv6 CIDR or
  the prefix-list id. CloudFormation's id has the same form.
- **`AWS::S3Tables::Namespace`** and **`AWS::S3Tables::Table`**: only their
  parent, `AWS::S3Tables::TableBucket`, is found without a flag.

#### `AWS::EC2::NetworkAclEntry`

CloudFormation's id for an entry is a generated name that says nothing about
the entry. When cdkd is given that id, it locates the entry from the
`NetworkAclId`, `RuleNumber` and `Egress` in your template.

That needs the parent network ACL's id as well. Pass `--resource` for the ACL
too, or add `--auto` so that a CloudFormation stack of the same name supplies
it.

#### `AWS::EC2::SecurityGroupIngress`

Pass the `sgr-...` rule id. It is the id CloudFormation records for the type
and the id the EC2 console shows. cdkd verifies it with
`DescribeSecurityGroupRules` and declines the id of an egress rule.

cdkd stores `<groupId>|<ipProtocol>|<fromPort>|<toPort>` as the physical id,
and the rule id as the `Id` attribute. You cannot pass that stored form to
`--resource`, because the same four values can describe several rules.

### Attachments and links

| Type | `--resource` value |
| --- | --- |
| `AWS::Lambda::Permission` | The bare statement id. |
| `AWS::Lambda::EventInvokeConfig` | `<functionName>\|<qualifier>` |
| `AWS::EC2::SubnetRouteTableAssociation` | The `rtbassoc-...` association id. |
| `AWS::EC2::SubnetNetworkAclAssociation` | The `aclassoc-...` association id. |
| `AWS::EC2::VPCGatewayAttachment` | `<internetGatewayId>\|<vpcId>`, or CloudFormation's `IGW\|<vpcId>`. |
| `AWS::BedrockAgentCore::Runtime` | The runtime ARN. |
| `AWS::BedrockAgentCore::Evaluator` | The evaluator ARN or bare id. |
| `AWS::Lambda::MicrovmImage` | The image ARN. |

These types take the plain physical id: `AWS::SNS::Subscription`,
`AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy`, `AWS::S3::BucketPolicy`,
`AWS::Lambda::EventSourceMapping`, `AWS::Lambda::Url`,
`AWS::CloudFormation::CustomResource`,
`AWS::CloudFront::CloudFrontOriginAccessIdentity`.

- **`AWS::Lambda::Permission`**: cdkd also reads the older
  `<functionArn>|<statementId>` form.
- **`AWS::Lambda::EventInvokeConfig`**: a bare function name means the
  qualifier `$LATEST`.
- **`AWS::EC2::VPCGatewayAttachment`**: only internet gateway attachments are
  adopted; a VPN gateway attachment is not. Given `IGW|<vpcId>`, cdkd takes
  the gateway from the template's `InternetGatewayId`, or else from the one
  gateway attached to that VPC.
- **`AWS::BedrockAgentCore::Evaluator`**: cdkd turns a bare id into the ARN
  with `GetEvaluator`.
- **`AWS::Lambda::MicrovmImage`**: a bare name is rejected.

## Cloud Control API fallback

cdkd has its own import code for the types above. Any other type can still be
imported when the AWS Cloud Control API supports it, as long as you name the
resource with `--resource`:

```bash
cdkd import MyStack --resource 'VpcIpv6Cidr=vpc-cidr-assoc-0abc123|vpc-0def456'
```

cdkd does not look such a resource up for you, because that would cost one
`ListResources` call per type.

The state record of a resource imported this way says `provisionedBy: cc-api`,
as it would after a deploy. Later deploys, drift checks and destroys therefore
keep using Cloud Control for it.

### Ids made of several fields

Cloud Control identifies some types by several fields joined with `|`. The
example above is an `AWS::EC2::VPCCidrBlock`, whose id is `<Id>|<VpcId>`. cdkd
records that joined value as the physical id.

CloudFormation's physical id for such a resource is often one field only: the
bare `vpc-cidr-assoc-...` for a `VPCCidrBlock`. When cdkd receives that
shorter id, from `--migrate-from-cloudformation` or from a bare `--resource`
value, it fills in the other fields from your template. A `Ref` to another
imported resource counts as a value it can use.

This needs the `cloudformation:DescribeType` permission. When the template
does not give exactly the missing fields as plain values, the import of that
resource fails and names the full value to pass, for example
`--resource 'VpcIpv6Cidr=<Id>|<VpcId>'`.

### What cdkd records for `Fn::GetAtt`

A state record has an `attributes` map, which is where `Fn::GetAtt` reads
from. Cloud Control returns every property of the resource, but cdkd keeps in
`attributes` only the ones the type's schema declares as read-only. Those are
the ones CloudFormation allows `Fn::GetAtt` to read.

cdkd records every other property as the mask `***`. A later `Fn::GetAtt` on
a masked property is refused by name, so it cannot resolve to a wrong value.

Reading the schema needs `cloudformation:DescribeType`: one call per resource
type, cached for the run. Without the permission, cdkd masks every property
and warns. An `Fn::GetAtt` on that resource then fails until a deploy next
creates or updates the resource. The direct fix is to grant the permission and
run `cdkd import` again.

The record is still sensitive:

- A credential that is itself a read-only attribute is recorded in the clear.
  The schema does not mark which attributes are secret.
- The mask applies to `attributes` only. The copy of the resource that cdkd
  keeps for drift detection holds every property; see
  [A value your template never references](import.md#a-value-your-template-never-references-is-recorded-as-aws-holds-it).
- The next deploy that creates or updates the resource writes every property
  back into `attributes`.

What importing the same resource a second time does to masked values is in
[Import internals](import-internals.md#re-importing-a-cloud-control-resource).

## CDK Stages are not nested stacks

Each stack inside a CDK Stage is a separate top-level stack. Import it by
passing its display path or physical name as the stack argument. A real
nested stack (`AWS::CloudFormation::Stack`) can be imported only with
`--migrate-from-cloudformation`.

## Related

- [Import Existing Resources](import.md): the walkthroughs and the list of
  importable types
- [Import options and the import plan](import-reference.md): flags and the
  plan
- [State Store](state-management.md): the physical id format cdkd stores
  for each type
- [Supported Resources](supported-resources.md): which types cdkd deploys
