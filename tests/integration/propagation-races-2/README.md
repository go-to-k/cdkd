# Propagation Races 2

A second fresh-principal / propagation-race stress integ for cdkd. Every
resource here is a NEW consumer of a resource created moments earlier in the
SAME deploy, so each is its own propagation-race edge that cdkd must survive
without the user re-running `cdkd deploy`.

This fixture deliberately covers **different race edges** from the original
IAM-propagation stress integ (which exercised Lambda exec role / SFN role /
EventBridge target / SQS+SNS resource policy — the last of which surfaced
[#839](https://github.com/go-to-k/cdkd/issues/839), an SNS/SQS policy PUT not
retried on a fresh-role `PrincipalNotFound`). Many sibling APIs share the same
race; this fixture probes five of them.

## Race edges (fresh producer -> immediate consumer)

| # | Producer (fresh) | Consumer (validates the producer)            | AWS rejection until propagated |
|---|------------------|----------------------------------------------|--------------------------------|
| 1 | IAM InstanceProfile (+ role) | `AWS::EC2::Instance` `IamInstanceProfile` | `Invalid IAM Instance Profile ...` / `... does not exist` |
| 2 | S3 bucket + Lambda function | `AWS::Lambda::Permission` (`AddPermission`) | `Source ... does not exist` / function-not-ready 400 |
| 3 | IAM role | `AWS::S3::BucketPolicy` (`PutBucketPolicy`) | `Invalid principal in policy` |
| 4 | IAM role | `AWS::KMS::Key` key policy (`CreateKey`) | `MalformedPolicyDocumentException ... not valid` |
| 5 | IAM role (SNS caller) | `AWS::Cognito::UserPool` `SmsConfiguration.SnsCallerArn` (`CreateUserPool` **and** `SetUserPoolMfaConfig`) | `InvalidSmsRoleTrustRelationshipException` / `Role does not have a trust relationship allowing Cognito to assume the role` |

Edge 1 (InstanceProfile -> EC2) is the most race-prone: instance-profile
propagation is the slowest IAM surface, often 5-10s+.

Edge 5 is the only one that validates the SAME fresh role in TWO calls:
`EnabledMfas` makes cdkd follow the create with `SetUserPoolMfaConfig`, which
re-sends the identical `SmsConfiguration`. It was reported from a real
deployment as [#2901](https://github.com/go-to-k/cdkd/issues/2901), where cdkd
issued `CreateUserPool` 336ms after the role's own CREATE.

## Resources Created

- **VPC** — single AZ, no NAT gateways (cost), public subnet only
- **Security Group** — for the EC2 instance
- **IAM Role + InstanceProfile** — consumed by the EC2 instance
- **EC2 Instance** — t3.micro, Amazon Linux 2023, RAW L1 (`CfnInstance`) so it
  stays on the SDK provider path (an L2 instance emits `AvailabilityZone`, a
  silent-drop that flips the resource onto Cloud Control)
- **Lambda Function** (tiny inline) + **S3 bucket** + **`Lambda::Permission`**
  granting the bucket invoke rights
- **IAM Role + S3 bucket + BucketPolicy** referencing the role principal
- **IAM Role + KMS Key** whose key policy references the role principal
- **IAM Role (SNS caller) + Cognito User Pool** — RAW L1 (`CfnUserPool`) for
  the same reason the instance is: control over the exact property set. Not
  because the L2 routes elsewhere — the issue's own `RESOURCE_FAILED` event
  records `"provisionedBy": "sdk"`, so the reported L2 pool ran on the same SDK
  provider this edge exercises. What the L1 buys is that every property stays
  in the type's `handled` set, so a future L2 default cannot introduce a silent
  drop and move the resource off the path under test

All resources carry the `cdkd:integ-fixture=propagation-races-2` tag so the
verify script can assert each is gone post-destroy by a fixture-owned tag (NOT
the `aws:cdk:path` tag, which AWS reserves and cdkd cannot set).

## Pass condition

**Deploy SUCCEEDS.** The fixture is a race detector: if any consumer's create
fails because cdkd does not retry the fresh-principal propagation error, the
deploy fails and `verify.sh` prints which resource failed, the AWS error, and
the `cdkd events --format json` `RESOURCE_FAILED` lines for triage. On a
successful deploy it asserts each resource actually works (instance running,
Lambda invokable, bucket policy + KMS policy present, user pool AND its SMS MFA
config both bound to the fresh role), then destroys and
asserts every named resource is gone.

## Deploy

```bash
cdkd deploy CdkdPropagationRaces2Example
```

## Destroy

```bash
cdkd destroy CdkdPropagationRaces2Example
```

## Verify (deploy + assert + destroy + orphan check)

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 ./verify.sh
```
