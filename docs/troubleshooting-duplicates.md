---
title: Possible duplicates after a server error
description: "What to do when cdkd warns that a failed create may have left a resource behind, or a retried create collides with one."
---

# Possible duplicates after a server error

When a create call fails with HTTP 500 / 502 / 503 / 504, AWS may have
created the resource and lost only the response. Some create calls give AWS
no way to recognise a repeated request (they carry no idempotency token), so
retrying such a call either creates a second resource or collides with the
first.

cdkd handles this for the calls on this page. It turns off the AWS SDK's own
retry of a 5xx. Before cdkd retries the create itself, it looks in AWS for a
resource the failed attempt may have made, and it reports each candidate as a
warning with a command that reads it. cdkd never adopts or deletes a
candidate. It then creates the resource again.

On this page:

- [What to do with a warning](#what-to-do-with-a-warning)
- [A warning that a KMS key, Cognito user pool or AppSync API may be an orphan](#a-warning-that-a-kms-key-cognito-user-pool-or-appsync-api-may-be-an-orphan)
- [A warning that an API Gateway API, authorizer, integration or deployment may be an orphan](#a-warning-that-an-api-gateway-api-authorizer-integration-or-deployment-may-be-an-orphan)
- [A warning that an EMR cluster, instance fleet or instance group may be an orphan](#a-warning-that-an-emr-cluster-instance-fleet-or-instance-group-may-be-an-orphan)
- [A warning that a Lambda layer version or event source mapping may be an orphan](#a-warning-that-a-lambda-layer-version-or-event-source-mapping-may-be-an-orphan)
- [A warning that a DLM lifecycle policy or ECS task definition revision may be an orphan](#a-warning-that-a-dlm-lifecycle-policy-or-ecs-task-definition-revision-may-be-an-orphan)
- [A warning that an EC2 VPC, subnet, internet gateway or Elastic IP may be an orphan](#a-warning-that-an-ec2-vpc-subnet-internet-gateway-or-elastic-ip-may-be-an-orphan)
- [`EntityAlreadyExists` on an IAM create after a server error](#entityalreadyexists-on-an-iam-create-after-a-server-error)
- [An "already exists" on a Lambda, EventBridge bus or ECR create after a server error](#an-already-exists-on-a-lambda-eventbridge-bus-or-ecr-create-after-a-server-error)
- [`DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for](#distributionalreadyexists-on-a-cloudfront-deploy-and-a-distribution-you-did-not-ask-for)

## What to do with a warning

1. Inspect each id with the read command the warning gives.
2. Delete the resource only after you confirm that it is this deploy's orphan
   and does not belong to another deploy.

Four things apply to every warning on this page:

- **A reset connection or a timeout** is as ambiguous as a 5xx, and the AWS
  SDK retries it inside one call. If the SDK's retry also fails, cdkd looks
  for a candidate before its own retry, as above. If the SDK's retry
  succeeds, cdkd looks right after the create, and the warning says the call
  "succeeded only after the AWS SDK sent it again". The warning never names
  the resource the create returned.
- **A clean lookup is not proof.** The list APIs are eventually consistent, so
  a duplicate may not be listed yet.
- **Without the lookup permission** cdkd warns that it could not look, and the
  deploy proceeds.
- **Some types report no creation time** (AppSync, API Gateway authorizers and
  integrations, the EC2 lookups). cdkd cannot tell when a candidate of such a
  type was made, so the candidate may be another stack's resource of the same
  name. The warning says so. A throttled request that the SDK retried
  triggers the same lookup, and for these types it can name an unrelated
  resource.

## A warning that a KMS key, Cognito user pool or AppSync API may be an orphan

| Call | Candidate cdkd reports | Read command | Lookup permission |
| --- | --- | --- | --- |
| `CreateKey` | A key with the same settings, created during the failed attempt | `describe-key` | `kms:ListKeys`, `kms:DescribeKey` |
| `CreateUserPool` | A pool with the same name, created during the failed attempt | `describe-user-pool` | `cognito-idp:ListUserPools` |
| `CreateGraphqlApi` | An API with the same name that this deploy did not record | `get-graphql-api` | `appsync:ListGraphqlApis` |
| `CreateApiKey` | A key on the same API with the same description that this deploy did not record | `list-api-keys` | `appsync:ListApiKeys` |

- After the warning a user pool name is shared by two pools. Before deleting
  one, check that it has no users, that it was created during the failed
  attempt, and that it carries no tags another stack sets.
- A KMS key cannot be deleted at once. `aws kms schedule-key-deletion` puts it
  in a 7-to-30-day pending window.
- An AppSync API key's id is the credential clients send, so the warning names
  a key only by its last four characters and its expiry. Find it in the
  `list-api-keys` output.

### "KMS key ... was created for ..., but a follow-up call failed"

This related warning means `CreateKey` succeeded and a later call on the key
(`EnableKeyRotation`, `DisableKey`) failed. cdkd's retry reuses that key, so
leave the key alone while the deploy is running. The key ends up outside cdkd
state only if the deploy then fails.

## A warning that an API Gateway API, authorizer, integration or deployment may be an orphan

The calls are `CreateAuthorizer` and `CreateDeployment` (REST API), and
`CreateApi`, `CreateIntegration` and `CreateAuthorizer` (HTTP / WebSocket API).

| Candidate cdkd reports | Delete command in the warning |
| --- | --- |
| An API with the same name and protocol, created during the failed attempt | Yes |
| A deployment of the same REST API with the same description, created during the failed attempt | Yes |
| An authorizer with the same name and type in the same API that this deploy did not record | No |
| An integration with the same type and URI in the same API that this deploy did not record | No |

An orphaned authorizer, integration or deployment is deleted with its API.
The lookup needs `apigateway:GET` on the API, or on the API list for
`CreateApi`.

## A warning that an EMR cluster, instance fleet or instance group may be an orphan

The calls are `RunJobFlow`, `AddInstanceFleet` and `AddInstanceGroups`. A
duplicate here is billed per instance-hour.

| Candidate cdkd reports | Commands in the warning |
| --- | --- |
| A cluster with the same name, created during the failed attempt, not terminating or terminated | `aws emr describe-cluster`, then `aws emr terminate-clusters` |
| A TASK instance fleet or group with the same name in the same cluster (any name, when the template sets none) | `list-instance-fleets` / `list-instance-groups`, then `modify-instance-fleet` / `modify-instance-groups` to scale it to zero |

- EMR cannot remove a fleet or group from a running cluster. Scaling it to
  zero stops the billing, and it goes away with its cluster.
- A candidate cluster with termination protection needs
  `modify-cluster-attributes --no-termination-protected` first. The warning
  does not chain that command, since the cluster may be another deploy's.
- A MASTER or CORE fleet or group is not looked up: a cluster holds at most
  one of each.

The cluster lookup needs `elasticmapreduce:ListClusters`.

## A warning that a Lambda layer version or event source mapping may be an orphan

| Call | Candidate cdkd reports | Commands in the warning | Lookup permission |
| --- | --- | --- | --- |
| `PublishLayerVersion` | A version of the same layer published during the failed attempt | `aws lambda get-layer-version`, then `aws lambda delete-layer-version` | `lambda:ListLayerVersions` |
| `CreateEventSourceMapping` | A mapping between the same function and event source that this deploy did not record | `aws lambda get-event-source-mapping`; no delete command | `lambda:ListEventSourceMappings` |

For a self-managed Kafka source the mapping is matched on the function only.
A mapping last modified before the failed attempt is not reported.

Where Lambda refuses a second mapping between the same function and source, as
it does for an SQS queue, the retry fails with `ResourceConflictException`
naming the orphan's UUID. Confirm the mapping is this deploy's, delete it and
re-run the deploy:

```bash
aws lambda delete-event-source-mapping --uuid <uuid>
```

## A warning that a DLM lifecycle policy or ECS task definition revision may be an orphan

| Call | Candidate cdkd reports | Commands in the warning | Lookup permission |
| --- | --- | --- | --- |
| `CreateLifecyclePolicy` | A policy with the same description and the same default or custom kind, created during the failed attempt, that this deploy did not record | `aws dlm get-lifecycle-policy`, then `aws dlm delete-lifecycle-policy` | `dlm:GetLifecyclePolicies`, `dlm:GetLifecyclePolicy` |
| `RegisterTaskDefinition` | An ACTIVE revision of the same family, registered during the failed attempt, that this deploy did not register | `aws ecs describe-task-definition`, then `aws ecs deregister-task-definition` | `ecs:ListTaskDefinitions`, `ecs:DescribeTaskDefinition` |

A policy with no description matches a create with none. Run the second
command only after confirming the candidate is this deploy's: another deploy
can create a policy with the same description, or register a revision of the
same family, in the same window.

## A warning that an EC2 VPC, subnet, internet gateway or Elastic IP may be an orphan

cdkd tags these resources only after the create returns, so an orphan has no
tags. It reports each untagged match this deploy did not record:

| Call | Candidate cdkd reports | Read command | Lookup permission |
| --- | --- | --- | --- |
| `CreateVpc` | A VPC with the same CIDR that is not a default VPC | `describe-vpcs` | `ec2:DescribeVpcs` |
| `CreateSubnet` | A subnet with the same CIDR in the same VPC | `describe-subnets` | `ec2:DescribeSubnets` |
| `CreateInternetGateway` | An internet gateway attached to no VPC | `describe-internet-gateways` | `ec2:DescribeInternetGateways` |
| `AllocateAddress` | An Elastic IP of the same domain, associated with nothing | `describe-addresses` | `ec2:DescribeAddresses` |

EC2 reports no creation time for these, so the warning gives no delete
command. For an Elastic IP the match also considers the network border group
or pool when the template sets one. An unassociated Elastic IP is billed until
released.

Two creates fail on the retry instead of duplicating:

- **Subnet.** A CIDR cannot repeat in a VPC, so the retry fails with
  `InvalidSubnet.Conflict`. Confirm the subnet the warning named is this
  deploy's, delete it and re-run:

  ```bash
  aws ec2 delete-subnet --subnet-id <id>
  ```

- **Security group.** A name cannot repeat in a VPC, so a replayed
  `CreateSecurityGroup` fails with `InvalidGroup.Duplicate`. No lookup runs
  for it.

## `EntityAlreadyExists` on an IAM create after a server error

One of `CreateRole`, `CreateUser`, `CreateGroup`, `CreateInstanceProfile` and
`CreatePolicy` failed with a 5xx although IAM had created the entity. cdkd's
retry then fails with `EntityAlreadyExists`, because the entity from the
first attempt holds the name. For a name cdkd generated, the error says the
entity is most likely the one this create's earlier attempt made.

That entity is in no state file. Confirm it is this deploy's, then either
adopt it or delete it, and re-run the deploy:

```bash
cdkd import MyStack --resource MyRole=mystack-myrole   # adopt
aws iam delete-role --role-name mystack-myrole          # or delete
```

After a reset connection or a timeout the request may never have reached IAM,
so the holder can be another resource. Confirm before deleting or importing.

### Access keys

`CreateAccessKey` is handled differently, because a duplicate key is a
credential whose secret nobody received.

- After a failure, cdkd lists the user's keys and deletes the one that attempt
  minted: a key the user did not have before, created after the attempt
  started, and not recorded by this process. It then creates a new key.
- After an SDK retry that succeeded following a reset or timeout, it does the
  same right after the create and keeps the key the create returned. It does
  not do this after a throttle or a refused connection, which minted nothing.
- A key it declines to delete is reported as a warning with the
  `aws iam delete-access-key` command.

`ListAccessKeys` is eventually consistent. A key IAM does not list yet is
neither deleted nor reported, and the retry mints a second one. After such a
failure, compare the user's keys with the key in cdkd state:

```bash
aws iam list-access-keys --user-name my-user
cdkd state show MyStack
```

## An "already exists" on a Lambda, EventBridge bus or ECR create after a server error

The create failed with a 5xx although AWS had created the resource, so cdkd's
retry fails against it. For a name cdkd generated, the error says the
resource is most likely what this create's earlier attempt made.

| Call | Error on the retry | Delete with |
| --- | --- | --- |
| `CreateFunction` | `ResourceConflictException` | `aws lambda delete-function` |
| `CreateFunctionUrlConfig` | `ResourceConflictException` | `aws lambda delete-function-url-config` |
| `AddPermission` | `ResourceConflictException` | `aws lambda remove-permission` |
| `CreateEventBus` | `ResourceAlreadyExistsException` | `aws events delete-event-bus` |
| `CreateRepository` | `RepositoryAlreadyExistsException` | `aws ecr delete-repository` |

That resource is in no state file. Confirm it is this deploy's, then delete it
or adopt it with `cdkd import`, and re-run the deploy.

After a reset connection or a timeout the request may never have reached the
service, so the holder can be another resource. Confirm before deleting or
importing.

## `DistributionAlreadyExists` on a CloudFront deploy, and a distribution you did not ask for

CloudFront answered a `CreateDistribution` with a 5xx, cdkd retried the
call, and CloudFront refused the retry. The first request had in fact
succeeded, and only its response was lost.

cdkd sends the same `CallerReference` on every attempt of one create.
CloudFront recognises the repeated reference and refuses the second request,
which is why you get this error and not a second distribution.

The deploy fails. The distribution from the first attempt is live and is in
no state file. CloudFront offers no way to adopt it, so you clean it up by
hand.

::: steps
1. Find the distribution by its origin domain or comment

   ```bash
   aws cloudfront list-distributions \
     --query "DistributionList.Items[].{
       Id:Id,Status:Status,Enabled:Enabled,Domain:DomainName,
       Origins:Origins.Items[].DomainName,Comment:Comment}"
   ```

   Do not filter with `contains(Origins.Items[0].DomainName, ...)`. JMESPath
   raises a TypeError on any distribution that has no origins.

2. Disable it and wait for the change to deploy (typically about 15 minutes)

   ```bash
   # note the ETag; set Enabled=false in the config
   aws cloudfront get-distribution-config --id <ID>
   aws cloudfront update-distribution --id <ID> --if-match <ETag> \
     --distribution-config file://disabled.json
   aws cloudfront wait distribution-deployed --id <ID>
   ```

3. Delete it

   ```bash
   aws cloudfront delete-distribution --id <ID> --if-match <NewETag>
   ```

4. Re-run the deploy

   ```bash
   cdkd deploy MyStack
   ```

   The next run uses a fresh caller reference, so it does not collide with the
   deleted distribution.
:::

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
