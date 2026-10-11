---
title: Asset publishing errors
description: "Fix a cdkd deploy that fails while uploading file assets to S3 or pushing Docker image assets to ECR."
---

# Asset publishing errors

Before it provisions anything, cdkd uploads the stack's file assets to an S3
bucket and pushes its Docker image assets to an ECR repository. A failure in
that step means the storage does not exist, or the identity running cdkd
cannot write to it.

On this page:

- ["Asset publishing failed"](#asset-publishing-failed)

## "Asset publishing failed"

The message depends on which step failed. A denied S3 upload shows up as the
AWS SDK's own error:

```
AccessDenied: User: arn:aws:iam::123456789012:user/myuser is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::cdkd-assets-123456789012-us-east-1/abc123.zip"
```

The check that runs before the upload names the bucket and key:

```
Error: Failed to check S3 object s3://cdkd-assets-123456789012-us-east-1/abc123.zip: AccessDenied: Access Denied
```

Docker image assets raise `AssetError`:

```
AssetError: ECR login failed: <docker output>
AssetError: Docker push failed: <docker output>
AssetError: Refusing to publish a Docker image asset: the destination region <region> is not a valid AWS region id
AssetError: Refusing to publish a Docker image asset: <account> is not a 12-digit AWS account id
```

| Cause | Fix |
| --- | --- |
| The asset bucket or ECR repository does not exist | [Create the asset storage](#create-the-asset-storage) |
| The identity cannot write to it | [Grant the publishing permissions](#grant-the-publishing-permissions) |
| A `Refusing to publish` error | [Fix the Docker asset's region or account](#fix-the-docker-asset-s-region-or-account) |

### Create the asset storage

```bash
cdkd bootstrap --region us-east-1
```

`cdkd bootstrap` creates the state bucket and cdkd's own asset storage for the
region: the `cdkd-assets-*` bucket and the `cdkd-container-assets-*` ECR
repository. No `cdk bootstrap` is needed.

The first `cdkd deploy` into a region normally creates this storage by
itself. This error therefore usually means one of three things:

- The automatic creation was turned off with `--no-auto-asset-storage`.
- The automatic creation failed. Look for its warning in the deploy output.
- Someone deleted the bucket or the repository afterwards.

#### A region that uses the CDK bootstrap bucket

In a region without cdkd's own storage, cdkd publishes to the destinations
named in the asset manifest, which is the CDK bootstrap bucket
(`cdk-hnb659fds-assets-*`). The same happens when you set
`--use-cdk-bootstrap-assets` or `context.cdkd.useCdkBootstrapAssets` in
`cdk.json`. cdkd does not create that bucket, so create it with the CDK CLI:

```bash
npx cdk bootstrap aws://123456789012/us-east-1
```

A custom bootstrap qualifier works, because cdkd reads the destinations from
the manifest. See [`cdkd bootstrap`](cli-bootstrap.md).

#### Deploy without publishing assets

```bash
cdkd deploy MyStack --skip-assets
```

### Grant the publishing permissions

cdkd publishes assets with the credentials of the identity that runs it. It
never assumes CDK's `cdk-hnb659fds-file-publishing-role-*`, so that identity
needs the policy below. Adjust the bucket ARN if the region was bootstrapped
with a custom `--asset-bucket` name.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "FileAssetObjects",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:PutObject"],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-123456789012-*/*",
        "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-*/*"
      ]
    },
    {
      "Sid": "FileAssetBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": [
        "arn:aws:s3:::cdkd-assets-123456789012-*",
        "arn:aws:s3:::cdk-hnb659fds-assets-123456789012-*"
      ]
    },
    {
      "Sid": "EcrAuthTokenMustBeStar",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "DockerAssetRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:DescribeRepositories",
        "ecr:DescribeImages",
        "ecr:BatchCheckLayerAvailability",
        "ecr:InitiateLayerUpload",
        "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload",
        "ecr:PutImage"
      ],
      "Resource": [
        "arn:aws:ecr:*:123456789012:repository/cdkd-container-assets-*",
        "arn:aws:ecr:*:123456789012:repository/cdk-hnb659fds-container-assets-*"
      ]
    }
  ]
}
```

Three parts of that policy are easy to get wrong:

- `ecr:GetAuthorizationToken` works only on `"Resource": "*"`. It cannot be
  narrowed to a repository ARN.
- The layer-upload actions are needed although cdkd makes no SDK call for
  them. The push is a `docker push` authenticated with a token minted from
  your credentials.
- `s3:ListBucket` goes on the bucket ARN, not the `/*` object ARN. The storage
  check before the upload needs it, and without it the deploy fails before any
  upload.

#### Permissions to create the storage

The identity that creates the storage needs more. That is the identity that
runs `cdkd bootstrap`, and also the one that runs the first `cdkd deploy`
into a region unless you pass `--no-auto-asset-storage`:

```json
{
  "Sid": "CreateAssetStorage",
  "Effect": "Allow",
  "Action": [
    "s3:CreateBucket",
    "s3:PutEncryptionConfiguration",
    "s3:PutBucketPublicAccessBlock",
    "s3:PutBucketPolicy",
    "ecr:CreateRepository",
    "ecr:PutImageTagMutability"
  ],
  "Resource": [
    "arn:aws:s3:::cdkd-assets-123456789012-*",
    "arn:aws:ecr:*:123456789012:repository/cdkd-container-assets-*"
  ]
}
```

Without these permissions the automatic creation fails. The deploy warns and
publishes to the CDK bootstrap bucket instead, and the upload then fails if
that bucket does not exist.

### Fix the Docker asset's region or account

cdkd builds the ECR registry's host name from the account id and the region,
and sends the ECR password to that host. When either value is malformed, cdkd
cannot be sure the host is ECR, so it refuses to publish.

- **Region**: it comes from `<StackName>.assets.json` in `cdk.out`, under
  `dockerImages.<hash>.destinations.<id>.region`. It must be a plain region id
  such as `us-east-1`. Fix the stack's `env.region` and re-synthesize.
- **Account**: it comes from your credentials
  (`aws sts get-caller-identity`), or from `accountId` when you call cdkd as a
  library, and must be the 12-digit id.

## Related

- [Troubleshooting](troubleshooting.md): the common problems and the list of
  every troubleshooting page
