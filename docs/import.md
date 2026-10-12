---
title: Import Existing Resources
description: "Adopt already-deployed AWS resources into cdkd state with cdkd import: migrate a CloudFormation-managed stack, adopt hand-made resources, and go back."
---

# Import Existing Resources

`cdkd import` makes cdkd the manager of AWS resources that already exist. It
reads your CDK app, finds the real resource behind each one the app declares,
and writes a state record for it. The next `cdkd deploy` then updates those
resources in place instead of trying to create duplicates. An import does not
create, change or delete any AWS resource.

```bash
# preview what would be adopted
cdkd import MyStack --dry-run

# adopt a cdk deploy stack and retire it
cdkd import MyStack --migrate-from-cloudformation

# adopt one hand-made resource
cdkd import MyStack --resource MyBucket=acme-uploads

# adopt everything cdkd can find
cdkd import MyStack
```

```text diagram=import-ownership
  AWS resources, managed by CloudFormation or by nobody
                        │
                        ▼
  cdkd import          reads each physical id, changes no resource
                        │
                        ▼
  cdkd state           one record per adopted resource
                        │
                        ▼
  CloudFormation       only with --migrate-from-cloudformation:
  stack retired        every resource set to Retain, then DeleteStack
                        │
                        ▼
  Same AWS resources, managed by cdkd
```

Two words appear throughout these pages. A resource's **logical ID** is its
name in the synthesized template, such as `Uploads5E5E9B2F`. Its **physical
id** is what AWS calls the real resource, such as the bucket name
`acme-uploads`. An import pairs each logical ID with a physical id.

The examples assume cdkd reads the CDK app command from `cdk.json`. Pass
`--app "<command>"` when you run cdkd outside the CDK project directory.

## Pick your scenario

| You have | Run | Section |
| --- | --- | --- |
| A stack deployed with `cdk deploy` that cdkd should take over | `cdkd import MyStack --migrate-from-cloudformation` | [Migrating from `cdk deploy`](#migrating-from-cdk-deploy-cloudformation-to-cdkd) |
| One or a few resources created by hand or by another tool | `cdkd import MyStack --resource <logicalId>=<physicalId>` | [Adopt hand-made resources](#adopt-hand-made-resources) |
| A whole stack of existing resources with explicit names | `cdkd import MyStack` | [Adopt every resource cdkd can find](#adopt-every-resource-cdkd-can-find) |
| An import you want to undo | `cdkd state orphan MyStack` or `cdkd export MyStack` | [Go back](#go-back) |

## In this section

- [Import options and the import plan](import-reference.md): every flag, when
  `--force` is needed, how to read the plan, and how `cdkd import` differs
  from `cdk import`.
- [Importing by resource type](import-resource-types.md): the value
  `--resource` expects for each type, and the types with special behaviour.
- [After an import](import-after.md): what the first `cdkd diff` shows, what
  cdkd records for drift detection, and how to remove a secret that reached
  state.

## Migrating from `cdk deploy` (CloudFormation) to cdkd

`--migrate-from-cloudformation` moves a stack from CloudFormation to cdkd in
one command. It adopts every resource of the CloudFormation stack into cdkd
state and then deletes the CloudFormation stack while keeping its resources.
You pass no physical ids, because cdkd reads them from CloudFormation.

::: steps
1. Preview the import

   ```bash
   cdkd import MyStack --dry-run
   ```

   A plain `--dry-run` reads the physical ids from the CloudFormation stack of
   the same name and writes nothing. Check that every row of the plan is
   marked `✓`. A row with any other mark would be left unmanaged by the
   migration; [Read the import plan](import-reference.md#read-the-import-plan)
   explains each mark.

2. Adopt the stack and retire the CloudFormation stack

   ```bash
   cdkd import MyStack --migrate-from-cloudformation
   ```

   cdkd asks for confirmation twice: before it writes state, and before it
   changes the CloudFormation stack. `--yes` answers both. CI needs `--yes`,
   because the prompts refuse to run without a terminal. The run ends with:

   ```text
   ✓ State written: MyStack (us-east-1)
   [1/4] Inspecting CloudFormation stack 'MyStack'...
   [2/4] Injected DeletionPolicy=Retain and UpdateReplacePolicy=Retain.
   [3/4] Updating CloudFormation stack with Retain policies...
   [4/4] Deleting CloudFormation stack 'MyStack' (resources retained)...
   ✓ CloudFormation stack 'MyStack' retired. AWS resources are now solely managed by cdkd.
   ```

3. Compare the adopted state with your template

   ```bash
   cdkd diff MyStack
   ```

   A property that differs between AWS and the template shows as a change the
   next deploy will apply.

4. Deploy with cdkd from now on

   ```bash
   cdkd deploy MyStack
   ```
:::

When the CloudFormation stack has a different name from the cdkd stack, pass
that name after the flag. The preview in step 1 cannot read such a stack,
because a plain import looks only for a CloudFormation stack of the same name.

```bash
cdkd import MyStack --migrate-from-cloudformation LegacyCfnStackName --yes
```

### What the migration does, in order

1. cdkd reads every logical ID and physical id from the CloudFormation stack
   with `DescribeStackResources`. A `--resource` value you pass takes
   precedence over CloudFormation's.
2. cdkd adopts each resource by that physical id.
3. cdkd writes state.
4. cdkd updates the CloudFormation stack so that every resource has
   `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain`. This update
   changes template metadata only.
5. cdkd deletes the CloudFormation stack. Every resource is retained, so
   CloudFormation deletes none of them.

cdkd holds the stack lock from the state write through the retirement, so a
concurrent `cdkd deploy` cannot run in between.

### If the migration stops partway

State is written in step 3, before CloudFormation is touched. If step 4 or 5
fails, the resources are in cdkd state and the CloudFormation stack still
exists. Run the same command again with `--force`, which is needed because
state now exists, or retire the CloudFormation stack by hand.

### Nested stacks

A CloudFormation stack that contains `AWS::CloudFormation::Stack` children is
migrated as a tree, to any depth, and each nested stack gets its own cdkd
state file. Only the migration flag does this: a plain `cdkd import` reports
each nested stack row as `unsupported`. See
[Nested stacks](import-reference.md#nested-stacks).

### Edge cases

- **A resource could not be imported.** cdkd warns before it retires the
  CloudFormation stack. If you continue, that resource stays in AWS and
  neither tool manages it. Import it first with `--resource`, or accept that.
- **`--dry-run` together with the flag.** This combination is not supported,
  because the stack update and delete cannot be simulated. Use a plain
  `cdkd import --dry-run` for the preview.
- **A large or YAML template.** Both work up to CloudFormation's 1 MB limit;
  see [Template size and format](import-reference.md#template-size-and-format).

## Adopt hand-made resources

Use `--resource` when a few resources already exist and the rest of the stack
does not: a bucket someone made in the console, or a queue another tool
created. cdkd imports only the resources you list.

::: steps
1. Declare the resource in your CDK app

   ```ts
   import * as cdk from 'aws-cdk-lib';
   import * as s3 from 'aws-cdk-lib/aws-s3';

   new s3.Bucket(this, 'Uploads', {
     bucketName: 'acme-uploads',
     removalPolicy: cdk.RemovalPolicy.RETAIN,
   });
   ```

2. Find its logical ID

   Run `cdkd synth` and read the logical ID, such as `Uploads5E5E9B2F`, from
   the template in `cdk.out/`.

3. Preview, then import

   ```bash
   cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads --dry-run
   cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads
   ```

   If the key is not a logical ID in the template, the run stops before any
   AWS call.

4. Review and deploy

   ```bash
   cdkd diff MyStack     # resources you did not list show as to create
   cdkd deploy MyStack
   ```
:::

The plan reports every resource you did not list as `out of scope` and leaves
it out of state, so the next `cdkd deploy` creates it. `cdk import
--resource-mapping` treats unlisted resources the same way.

When the stack already has state, cdkd adds the listed resources to it and
keeps the records already there. You need `--force` only when a listed
resource is already in state, because its record would be overwritten.

### Several resources, or a mapping file

```bash
# --resource is repeatable
cdkd import MyStack \
  --resource Uploads5E5E9B2F=acme-uploads \
  --resource ResizeFn9A1B2C3D=acme-resize

# The same mapping as a JSON file: { "Uploads5E5E9B2F": "acme-uploads" }
cdkd import MyStack --resource-mapping mapping.json

# Or inline, for a CI script that does not want a file
cdkd import MyStack \
  --resource-mapping-inline '{"Uploads5E5E9B2F":"acme-uploads"}'
```

`--resource-mapping` and `--resource-mapping-inline` cannot be combined.

### Physical ids that contain `|`

Some resource types have a physical id made of several parts joined with `|`,
such as `<databaseName>|<tableName>` for a Glue table. Quote such a value,
because the shell reads an unquoted `|` as a pipe:

```bash
cdkd import MyStack \
  --resource 'EventsTable7C1D2E3F=analytics_db|events' \
  --resource 'GetMethod4B5C6D7E=a1b2c3d4e5|xy9z8w|GET'
```

A `--resource-mapping` JSON file needs no escaping. The joined form is what
`cdkd state show` and `cdkd state resources` print, and it is not always the
id CloudFormation shows. [Importing by resource type](import-resource-types.md)
lists the form for each type.

## Adopt every resource cdkd can find

With no `--resource` flag, cdkd tries to import every resource in the
template:

```bash
cdkd import MyStack --dry-run
cdkd import MyStack
```

This is also how you adopt a `cdk deploy` stack while leaving its
CloudFormation stack in place. Both tools then hold a record of the same
resources, so treat this as a preview or as a step towards
`--migrate-from-cloudformation`.

When the stack already has state, this form rebuilds every record from the
template and needs `--force`.

### How cdkd finds each resource

```text diagram=import-resolution
  --resource or a mapping file names it      used as given, in every mode
            │ not named
            ▼
  The template sets a name property          BucketName, RoleName, TopicName
            │ no match
            ▼
  A CloudFormation stack of the same         DescribeStackResources supplies
  name exists                                the physical id
            │ no match
            ▼
  Reported as not found                      pass --resource and run again
```

cdkd first looks a resource up by the name your template sets for it. Most
CDK apps set no names, so CloudFormation generated them. For those, cdkd
reads the physical id from a CloudFormation stack that has the same name as
the cdkd stack, and prints the name of the stack it read from.

A CDK app that sets no explicit names and has no CloudFormation stack of the
same name must use `--resource`. cdkd cannot find resources by the
`aws:cdk:path` tag, because AWS resources do not carry it: CloudFormation
keeps the construct path in template metadata.

[How the lookups can fall short](import-reference.md#how-the-lookups-can-fall-short)
covers a missing permission and a name built from the account or region.

### Name some resources and look up the rest: `--auto`

When one resource cannot be found automatically, name that one and add
`--auto`. cdkd uses the ids you give and looks up every other resource:

```bash
cdkd import MyStack --resource Uploads5E5E9B2F=acme-uploads --auto
```

Without `--auto`, the same command would import the bucket alone.

## Go back

An import writes only cdkd state, so undoing it is a state operation.

| You want to | Run |
| --- | --- |
| Drop the whole imported record | `cdkd state orphan MyStack` |
| Drop one imported resource | `cdkd state orphan MyStack --resource Uploads5E5E9B2F` |
| Hand the stack back to CloudFormation | `cdkd export MyStack` |

`cdkd state orphan` removes state records and leaves the AWS resources alone.
With `--resource` it removes one record and rewrites the references other
records hold to it.

What orphaning leaves you with depends on how you imported:

- **Without `--migrate-from-cloudformation`**, the CloudFormation stack is
  still there and still manages the resources. `cdkd state orphan MyStack`
  returns you to where you started.
- **After a migration**, the CloudFormation stack is gone, so orphaning leaves
  the resources managed by nobody. To return them to CloudFormation, run
  [`cdkd export`](cli-export.md), which imports the resources into a
  CloudFormation stack and deletes cdkd state.
  [Hand a Stack to CloudFormation](export.md) covers the types CloudFormation
  cannot import and Custom Resources.

## After the import

Run `cdkd diff MyStack` before the first deploy. A property that differs
between AWS and the template shows as a change the next `cdkd deploy` applies,
and a resource you did not import shows as `to create`.
[After an import](import-after.md) covers the less common cases.

## A value your template never references is recorded as AWS holds it

An import copies each adopted resource's current AWS properties into
`state.json`, so that `cdkd drift` can later report what changed. A secret
that sits in one of those properties is copied too, unless your template names
it through a `{{resolve:...}}` reference, in which case cdkd stores the
reference in its place.

A secret reaches `state.json` this way when:

- the template declares a placeholder literal such as `CHANGEME`, and someone
  later set the real value in the console or through an API call;
- AWS reports a field or list element that has no counterpart in the template;
- the resource was imported through the
  [Cloud Control API fallback](import-resource-types.md#cloud-control-api-fallback),
  which records every property AWS returns.

This is by design. The copy has to hold what AWS holds, changes made outside
cdkd included, or `cdkd drift` could not report them. So treat `state.json` as
sensitive, and limit who can read the state bucket.

[`cdkd scrub`](cli-scrub.md) does not find such a value, because it recognises
a secret only through a reference the template spells. Treat a value that was
ever stored this way as exposed and rotate it.
[A secret set outside your template](import-after.md#a-secret-set-outside-your-template)
has the details and the steps that remove the value from state.

## Which resource types can be imported

Whether cdkd can import a resource, and whether you must name it, depends on
its type. Search this section for your type, for example
`AWS::Lambda::Function`.

| Group | What you pass |
| --- | --- |
| [Found without a flag](#found-without-a-flag) | Nothing, when the template names the resource or a CloudFormation stack of the same name exists |
| [Need `--resource`](#need-resource) | `--resource <logicalId>=<physicalId>`, unless a CloudFormation stack supplies the id |
| Any other type | `--resource`, when the Cloud Control API supports the type |
| [Cannot be imported](#cannot-be-imported) | Nothing works; the plan reports `unsupported` |

[Importing by resource type](import-resource-types.md) lists the `--resource`
value each type expects and describes the Cloud Control API fallback.

### Found without a flag

cdkd finds these types by the
[lookups above](#how-cdkd-finds-each-resource) when you run `cdkd import`
with no `--resource`, or with `--auto`.

| Service | Types |
| --- | --- |
| ACM | `AWS::CertificateManager::Certificate` |
| API Gateway v2 | `AWS::ApiGatewayV2::Api` |
| AppSync | `AWS::AppSync::GraphQLApi` |
| Bedrock AgentCore | `AWS::BedrockAgentCore::Browser`, `AWS::BedrockAgentCore::CodeInterpreter` |
| Budgets | `AWS::Budgets::Budget` |
| CloudFront | `AWS::CloudFront::Distribution` |
| CloudTrail | `AWS::CloudTrail::Trail` |
| CloudWatch, Logs | `AWS::CloudWatch::Alarm`, `AWS::Logs::LogGroup` |
| CodeBuild, CodeCommit | `AWS::CodeBuild::Project`, `AWS::CodeCommit::Repository` |
| Cognito | `AWS::Cognito::UserPool` |
| DLM | `AWS::DLM::LifecyclePolicy` |
| DocumentDB | `AWS::DocDB::DBInstance`, `AWS::DocDB::DBCluster`, `AWS::DocDB::DBSubnetGroup` |
| DynamoDB | `AWS::DynamoDB::Table`, `AWS::DynamoDB::GlobalTable` |
| EC2 | `AWS::EC2::VPC`, `AWS::EC2::Subnet`, `AWS::EC2::SecurityGroup`, `AWS::EC2::NatGateway`, `AWS::EC2::EIP`, `AWS::EC2::InternetGateway`, `AWS::EC2::RouteTable`, `AWS::EC2::NetworkAcl`, `AWS::EC2::Instance` |
| ECR, ECS | `AWS::ECR::Repository`, `AWS::ECS::Cluster`, `AWS::ECS::Service`, `AWS::ECS::TaskDefinition` |
| EFS, FSx | `AWS::EFS::FileSystem`, `AWS::EFS::AccessPoint`, `AWS::FSx::FileSystem` |
| ElastiCache | `AWS::ElastiCache::CacheCluster`, `AWS::ElastiCache::SubnetGroup` |
| ELB v2 | `AWS::ElasticLoadBalancingV2::LoadBalancer`, `AWS::ElasticLoadBalancingV2::TargetGroup` |
| EMR | `AWS::EMR::Cluster` |
| EventBridge, Pipes | `AWS::Events::EventBus`, `AWS::Events::Rule`, `AWS::Pipes::Pipe` |
| Glue | `AWS::Glue::Database`, `AWS::Glue::Table`, `AWS::Glue::Job`, `AWS::Glue::Crawler`, `AWS::Glue::Connection`, `AWS::Glue::Trigger`, `AWS::Glue::Workflow`, `AWS::Glue::SecurityConfiguration` |
| IAM | `AWS::IAM::Role`, `AWS::IAM::ManagedPolicy`, `AWS::IAM::InstanceProfile`, `AWS::IAM::User`, `AWS::IAM::Group` |
| Kinesis, Firehose | `AWS::Kinesis::Stream`, `AWS::Kinesis::StreamConsumer`, `AWS::KinesisFirehose::DeliveryStream` |
| KMS | `AWS::KMS::Key`, `AWS::KMS::Alias` |
| Lambda | `AWS::Lambda::Function`, `AWS::Lambda::LayerVersion` |
| Neptune | `AWS::Neptune::DBInstance`, `AWS::Neptune::DBCluster`, `AWS::Neptune::DBSubnetGroup` |
| RDS | `AWS::RDS::DBInstance`, `AWS::RDS::DBCluster`, `AWS::RDS::DBProxy`, `AWS::RDS::DBProxyEndpoint`, `AWS::RDS::DBSubnetGroup` |
| Route 53 | `AWS::Route53::HostedZone` |
| S3 | `AWS::S3::Bucket`, `AWS::S3Express::DirectoryBucket`, `AWS::S3Tables::TableBucket`, `AWS::S3Vectors::VectorBucket` |
| Secrets Manager, SSM | `AWS::SecretsManager::Secret`, `AWS::SSM::Parameter` |
| Service Discovery | `AWS::ServiceDiscovery::Service`, `AWS::ServiceDiscovery::PrivateDnsNamespace`, `AWS::ServiceDiscovery::HttpNamespace`, `AWS::ServiceDiscovery::PublicDnsNamespace` |
| SNS, SQS | `AWS::SNS::Topic`, `AWS::SQS::Queue` |
| Step Functions | `AWS::StepFunctions::StateMachine` |
| WAF v2 | `AWS::WAFv2::WebACL` |

### Need `--resource`

cdkd has nothing to look these types up by. Each one has no name of its own,
belongs to a parent resource, or links two other resources. Pass the physical
id with `--resource`, `--resource-mapping` or `--resource-mapping-inline`.

You pass nothing when CloudFormation can supply the id: under
`--migrate-from-cloudformation`, or with `--auto` and a CloudFormation stack
of the same name.

| Service | Types |
| --- | --- |
| API Gateway | `AWS::ApiGateway::Account`, `AWS::ApiGateway::Authorizer`, `AWS::ApiGateway::Deployment`, `AWS::ApiGateway::Method`, `AWS::ApiGateway::Resource`, `AWS::ApiGateway::Stage` |
| API Gateway v2 | `AWS::ApiGatewayV2::Authorizer`, `AWS::ApiGatewayV2::Integration`, `AWS::ApiGatewayV2::Route`, `AWS::ApiGatewayV2::Stage` |
| AppSync | `AWS::AppSync::ApiKey`, `AWS::AppSync::DataSource`, `AWS::AppSync::GraphQLSchema`, `AWS::AppSync::Resolver` |
| Bedrock AgentCore | `AWS::BedrockAgentCore::Evaluator`, `AWS::BedrockAgentCore::Runtime` |
| CloudFormation | `AWS::CloudFormation::CustomResource`, `AWS::CloudFormation::WaitConditionHandle` |
| CloudFront | `AWS::CloudFront::CloudFrontOriginAccessIdentity`, `AWS::CloudFront::OriginAccessControl` |
| CloudWatch | `AWS::CloudWatch::AnomalyDetector` |
| EC2 | `AWS::EC2::NetworkAclEntry`, `AWS::EC2::Route`, `AWS::EC2::SecurityGroupIngress`, `AWS::EC2::SubnetNetworkAclAssociation`, `AWS::EC2::SubnetRouteTableAssociation`, `AWS::EC2::VPCGatewayAttachment` |
| EFS | `AWS::EFS::MountTarget` |
| ELB v2 | `AWS::ElasticLoadBalancingV2::Listener` |
| EventBridge Scheduler | `AWS::Scheduler::Schedule` |
| IAM | `AWS::IAM::AccessKey`, `AWS::IAM::Policy`, `AWS::IAM::UserToGroupAddition` |
| Lambda | `AWS::Lambda::EventInvokeConfig`, `AWS::Lambda::EventSourceMapping`, `AWS::Lambda::MicrovmImage`, `AWS::Lambda::Permission`, `AWS::Lambda::Url` |
| RDS | `AWS::RDS::DBProxyTargetGroup` |
| Route 53 | `AWS::Route53::RecordSet` |
| S3 | `AWS::S3::BucketPolicy` |
| S3 Tables | `AWS::S3Tables::Namespace`, `AWS::S3Tables::Table` |
| SNS, SQS | `AWS::SNS::Subscription`, `AWS::SNS::TopicPolicy`, `AWS::SQS::QueuePolicy` |

### Cannot be imported

The plan reports these types as `unsupported` and skips them.

| Resource type | Why |
| --- | --- |
| `AWS::CloudFormation::Stack` | A plain import cannot adopt a nested stack. Use `--migrate-from-cloudformation`, which walks the tree. |
| `AWS::AutoScaling::AutoScalingGroup` | cdkd can create, update, delete and detect drift on the type, but cannot import it. |
| `AWS::EMR::InstanceGroupConfig`, `AWS::EMR::InstanceFleetConfig` | Each is part of a cluster and has no name of its own. |

## Related

- [`cdkd export`](cli-export.md) and [Hand a Stack to CloudFormation](export.md):
  the opposite direction
- [State Store](state-management.md): state records, physical id
  formats, the bucket policy
- [Supported Resources](supported-resources.md): which types cdkd deploys
- [`cdkd bootstrap`](cli-bootstrap.md): cdkd-owned asset storage
