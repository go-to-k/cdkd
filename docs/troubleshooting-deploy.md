---
title: Failures during a deploy
description: "Fix a cdkd deploy that fails on a replacement, a Lambda function, an ACM certificate or a custom resource."
---

# Failures during a deploy

These entries are for a deploy that starts provisioning and then fails on one resource. A name that is already taken is covered by ["Resource already exists" Error](troubleshooting.md#resource-already-exists-error) on the main Troubleshooting page.

On this page:

- [Replacing a resource, and the refusal that guards it](#replacing-a-resource-and-the-refusal-that-guards-it)
- [Lambda Deployment Fails](#lambda-deployment-fails)
- [an ACM certificate deploy fails with "did not reach ISSUED status"](#an-acm-certificate-deploy-fails-with-did-not-reach-issued-status)
- ["Custom resource X: Y resolved to the value of a secret"](#custom-resource-x-y-resolved-to-the-value-of-a-secret)
- [A changed custom-resource ServiceToken is refused](#a-changed-custom-resource-servicetoken-is-refused)

## Replacing a resource, and the refusal that guards it

Some properties cannot be changed on a live resource. When you change one,
cdkd replaces the resource, which means deleting the old one and creating a
new one. A replacement needs no flag, and the deploy says that it is
happening:

```
Replacing MyBucket (AWS::S3::Bucket) - immutable properties changed: BucketName
```

cdkd refuses a replacement in two cases.

### The resource holds data

```
ProvisioningError: Failed to update resource MyBucket
Caused by: MyBucket (AWS::S3::Bucket) requires replacement (immutable property changed: BucketName) but it is a stateful resource — S3 bucket is not provably empty. Re-run with --force-stateful-recreation to confirm the data loss, or change the resource definition to avoid the immutable-property change.
```

Replacing a resource deletes the old one, and with it any data it holds. For
a resource that holds data, cdkd therefore asks you to confirm. Either revert
the change to the immutable property, or accept the data loss:

```bash
cdkd deploy MyStack --force-stateful-recreation
```

The guard is skipped for a resource carrying `UpdateReplacePolicy: Retain`.
See the
[stateful-resource guard](cli-deploy-safety.md#stateful-resource-guard).

### The type cannot be updated in place at all

```
ResourceUpdateNotSupportedError: AWS::EC2::NatGateway (MyNat) cannot be updated in place: use cdkd deploy with --replace, or change the resource definition to create a new version.
```

For such a type, every change is a replacement. The end of the message names
the remedy, and it differs per type. This failure exits with code `2` instead of
`1`.

```bash
cdkd deploy MyStack --replace
```

## Lambda Deployment Fails

```
ProvisioningError: Failed to create resource MyFunction
Caused by: Failed to create Lambda function MyFunction: <the AWS error>
```

The AWS error on the `Caused by:` line tells you which problem you have. Two
are common.

### `Error occurred while GetObject. S3 Error Code: NoSuchKey.`

The function's code was never uploaded. Either the deploy ran with
`--skip-assets`, or the asset bucket was emptied. Deploy without
`--skip-assets`, and compare what the stack expects with what the bucket
holds:

```bash
# what the stack expects
jq '.files' cdk.out/MyStack.assets.json

# what was published
aws s3 ls s3://cdkd-assets-123456789012-us-east-1/
```

Use `cdk-hnb659fds-assets-123456789012-us-east-1` when the region publishes to
the CDK bootstrap bucket (see ["Asset publishing failed"](troubleshooting-assets.md#asset-publishing-failed)).

### `The role defined for the function cannot be assumed by Lambda.`

The function's new execution role is not yet visible everywhere in IAM. cdkd
already retried for about 48 seconds before it reported the error. Re-run the
deploy.

You do not need `addDependency` to avoid this. cdkd creates the role before
the function because the function references it, so passing `role: role` to
`lambda.Function` is enough.

### A template with no `Code` or `Role`

cdkd catches a function with no `Code` or `Role` before any AWS call, with
`Code is required for Lambda function MyFunction`.

## an ACM certificate deploy fails with "did not reach ISSUED status"

```
ACM certificate SiteCert (arn:aws:acm:us-east-1:123456789012:certificate/...) did not reach
ISSUED status within 600s.
```

A DNS-validated certificate reaches `ISSUED` only once its validation records
exist in your DNS zone. On a first deploy they usually do not exist yet, so
cdkd's 10-minute wait runs out. While it waits, cdkd prints the records the
certificate needs. Before it reports the error, cdkd deletes the certificate
it requested, so a failed attempt leaves nothing behind.

Add the printed CNAME records to your DNS zone, then re-run:

```bash
cdkd deploy MyStack
```

The records stay valid for the next attempt. ACM derives a domain's validation
CNAME from the domain and the account, not from the certificate, and
[documents](https://docs.aws.amazon.com/acm/latest/userguide/dns-validation.html)
that a replacement certificate does not need validation repeated.

### Change how long the deploy waits

| Goal | Command |
| --- | --- |
| Wait up to 20 minutes | `CDKD_ACM_POLL_ATTEMPTS=120 cdkd deploy MyStack` |
| Do not wait | `cdkd deploy MyStack --no-wait` |

- `CDKD_ACM_POLL_ATTEMPTS` (default 60) is the number of polls, and
  `CDKD_ACM_POLL_INTERVAL_MS` (default 10000) the gap between them.
- With `--no-wait` the certificate is created and recorded in state, and the
  deploy returns at once. Resources that use the certificate fail until it
  issues.

`--resource-timeout` does not lengthen this wait by itself. Two limits apply:
the number of polls, and the per-resource deadline, which defaults to 30
minutes. The deploy waits for whichever is shorter. To poll past 30 minutes,
raise both:

```bash
CDKD_ACM_POLL_ATTEMPTS=270 cdkd deploy MyStack \

  # 45 min of polling
  --resource-timeout AWS::CertificateManager::Certificate=50m
```

Do not set the deadline below the total polling time. When the deadline
passes, cdkd stops waiting for the create without cancelling it, so the
cleanup that deletes the certificate may not run.

### The message says the certificate could NOT be deleted

The cleanup failed, for example because of a throttle or a missing
permission. cdkd is not tracking that certificate, so `cdkd destroy` will not
remove it. The message names the ARN and the command:

```bash
aws acm delete-certificate --certificate-arn <arn> --region us-east-1
```

## "Custom resource X: Y resolved to the value of a secret"

```
Custom resource DbInit: Password resolved to the value of a secret (a Secrets Manager secret, or an SSM SecureString parameter -- including one read through a plain {{resolve:ssm:...}} reference or a nested stack parameter). CloudFormation does not support secure dynamic references in custom resources, so cdkd does not send the secret's value to the handler. Pass the secret's name or ARN instead and have the handler read it.
```

A property of the custom resource turned out to hold a secret's value, and
cdkd refuses to send a secret to a custom resource handler. The template did
not show that the value was a secret, so the check that reads the template
(["The following custom resources pass a secure dynamic reference"](troubleshooting-templates.md#the-following-custom-resources-pass-a-secure-dynamic-reference))
could not catch it. cdkd refuses before the handler runs.

The secret arrives by one of two routes:

- A plain `{{resolve:ssm:...}}` reference names a parameter that is a
  SecureString. Pass the parameter's name or ARN, and have the handler read
  the value.
- A nested stack's child stack reads a parameter that the parent filled from
  a secret. Pass the secret's name down as the parameter, and not the resolved
  value.

A value derived from a secret, such as its base64 encoding or a fragment of
it, is refused too.

### The same refusal during a rollback

A rollback that resolves an older record again is refused the same way. That
includes `cdkd rollback --revert-failed`, which sends the properties a failed
update attempted as the event's `OldResourceProperties`. The message then
names the property as `OldResourceProperties.<path>`.

## A changed custom-resource ServiceToken is refused

```
Refusing to deploy S: a custom resource's ServiceToken changes, which CloudFormation does not allow ("Modifying service token is not allowed"). Nothing was sent to either handler.
  - Cr: ServiceToken changes to arn:aws:lambda:...:function:new, away from the handler its record names.
```

The custom resource now points at a different handler. Either its
`serviceToken` names another provider, or the Lambda function behind it was
renamed or moved under a new construct id, which changes its ARN.
CloudFormation refuses this change too. If cdkd updated the resource in
place, whatever the old handler created would be left with nothing managing
it.

Choose which handler should own the resource:

- **You want the new handler.** Give the custom resource a new logical id,
  with a new construct id or `overrideLogicalId`. The deploy then creates a
  new resource through the new handler and deletes the old one through its
  old handler.
- **You want to keep the existing resource.** Deploy its previous
  `ServiceToken`.

### A row reading `its recorded ServiceToken is ...`

The state record holds no token cdkd can compare, so cdkd cannot tell whether
the handler changed. If the handler did not change, set `ServiceToken` in
`state.json` to the ARN of the handler that created this resource (the one it
was last deployed with) and re-deploy.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
