---
title: State backup and bucket security
description: "How to restore an earlier cdkd state record, how the state bucket is configured, which IAM actions cdkd needs on it, and why S3 replication keeps copies that cdkd cannot delete."
---

# State backup and bucket security

The state bucket is versioned, so S3 keeps every earlier `state.json` and you
can restore one. The same versioning means that a deleted object's earlier
versions stay readable, so this page also covers who should be able to read
the bucket and which permissions let cdkd remove what it deletes.

```bash
aws s3api list-object-versions \
  --bucket cdkd-state-123456789012 \
  --prefix cdkd/MyStack/us-east-1/state.json
```

This page is part of [State Management](state-management.md).

## Restore an earlier version of a record

Every save of `state.json` leaves the previous one in the bucket as an earlier
object version. Restoring means downloading one of those versions and
uploading it as the current object.

::: steps
1. List the versions of the record

   ```bash
   aws s3api list-object-versions \
     --bucket cdkd-state-123456789012 \
     --prefix cdkd/MyStack/us-east-1/state.json
   ```

2. Download the version you want

   ```bash
   aws s3api get-object \
     --bucket cdkd-state-123456789012 \
     --key cdkd/MyStack/us-east-1/state.json \
     --version-id 3HL4kqtJlcpXroDTDmJ.rUAR3z7fFpPc \
     state-restore.json
   ```

3. Put it back as the current version

   Make sure no cdkd command is running on the stack first.

   ```bash
   aws s3 cp state-restore.json \
     s3://cdkd-state-123456789012/cdkd/MyStack/us-east-1/state.json
   ```
:::

A restored record describes the stack as it was when that version was written,
and AWS may have changed since. Run `cdkd diff` and `cdkd drift MyStack`
afterwards to see the differences.

A restored record in an older schema version needs no extra step. cdkd
upgrades it the next time it writes the record.

### When no earlier version helps

If the record and AWS disagree and no stored version matches, these commands
bring them back together:

| Goal | Command |
| --- | --- |
| See what differs | [`cdkd drift MyStack`](cli-drift.md) |
| Stop tracking the stack and keep its resources | `cdkd state orphan MyStack` |
| Track existing resources again | [`cdkd import`](import.md) |

## Keep a copy outside the bucket

To keep a copy outside the state bucket, sync the state prefix to another
bucket on a schedule:

```bash
aws s3 sync s3://cdkd-state-123456789012/cdkd/ \
  s3://my-state-backups/$(date +%Y%m%d)/
```

A backup holds the same values as the state bucket. It also keeps values that
cdkd later removes from the original, so protect the backup the same way you
protect the state bucket.

## Who should be able to read the bucket

Treat `state.json` as sensitive. cdkd keeps the secrets it recognises out of
the record, but some values are stored as they are.
[Secrets in state](state-management-secrets.md#values-that-are-stored-in-the-clear)
lists them. Limit who can read the state bucket and its earlier object
versions accordingly.

## How `cdkd bootstrap` configures the bucket

| Setting | Value |
| --- | --- |
| Versioning | Enabled |
| Default encryption | SSE-S3 (`AES256`) |
| Bucket policy | Denies access from outside the account |

### A bucket you create yourself

A bucket that you create and pass with `--state-bucket` should match those
settings. Versioning matters most, because without it there is no earlier
version to restore.

```bash
aws s3api put-bucket-versioning \
  --bucket my-team-state \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket my-team-state \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
```

To encrypt with a KMS key, set `SSEAlgorithm` to `aws:kms` and add
`KMSMasterKeyID` with the key ARN.

## IAM actions cdkd needs on the bucket

The principal that runs cdkd needs the actions below on the state bucket.
This bucket policy grants them to one role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::123456789012:role/CdkdDeployRole"
      },
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject",
        "s3:ListBucket",
        "s3:ListBucketVersions",
        "s3:DeleteObjectVersion",
        "s3:GetReplicationConfiguration"
      ],
      "Resource": [
        "arn:aws:s3:::cdkd-state-123456789012",
        "arn:aws:s3:::cdkd-state-123456789012/*"
      ]
    }
  ]
}
```

| Action | Applies to | Why cdkd needs it |
| --- | --- | --- |
| `s3:GetObject`, `s3:PutObject`, `s3:DeleteObject` | Objects | Read, write and delete records, locks and the other objects |
| `s3:ListBucket` | Bucket | List stacks |
| `s3:ListBucketVersions` | Bucket | Find earlier versions of an object cdkd deleted |
| `s3:DeleteObjectVersion` | Objects | Remove those versions |
| `s3:GetReplicationConfiguration` | Bucket | Optional; lets cdkd warn about [replication](#s3-replication-keeps-copies-cdkd-cannot-delete) |

### A policy scoped to one state prefix

Some policies limit an identity to its own state prefix, with a resource such
as `arn:aws:s3:::cdkd-state-123456789012/team-a/*`. Such a policy must also
grant `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on the bucket's
[stack registry](state-store-registry.md#permissions):

```text
arn:aws:s3:::cdkd-state-123456789012/_cdkd-registry/*
```

Without that grant, cdkd warns and falls back to a check that needs
`s3:ListBucket` on the whole bucket.

## Earlier versions of deleted objects

On a versioned bucket, deleting an object only adds a delete marker. Every
earlier version stays readable to anyone who asks for it by `VersionId`. Some
of the objects cdkd deletes can hold secrets, so after deleting one of them
cdkd also deletes its earlier versions. This page calls that step the purge.
The purge is what `s3:ListBucketVersions` and `s3:DeleteObjectVersion` are
for.

### What cdkd purges

| Object | What its earlier versions can hold |
| --- | --- |
| `rollback-journal.json` | The properties of a failed write, such as a literal password |
| `custom-resource-responses/` objects | A handler's full response, `Data` included |
| `cdkd-migrate-tmp/` templates | A template body |
| `deployments/` event streams | Event text, which cdkd treats as sensitive |
| `cdkd-bootstrap/{region}.json` | Bucket and repository names; no secret |
| `lock.json` | The lock holder; no secret |

Each object is purged by the commands that delete it:

- `rollback-journal.json`: a successful `cdkd deploy`, a clean
  `cdkd rollback`, `cdkd destroy` and `cdkd state destroy`.
- `custom-resource-responses/` objects: `cdkd deploy` and `cdkd gc`.
- `cdkd-migrate-tmp/` templates: `cdkd import --migrate-from-cloudformation`,
  `cdkd export`, and macro expansion in `cdkd deploy` and `cdkd diff`.
- `deployments/` event streams: `cdkd events prune`,
  `cdkd destroy --purge-events`, and the pruning cdkd does when it writes
  events.
- `cdkd-bootstrap/{region}.json`: `cdkd bootstrap --destroy`.
- `lock.json`: every lock release, a takeover of an expired lock, and
  `cdkd force-unlock`.

### What cdkd does not purge

cdkd keeps the earlier versions of `state.json`, because they are how you
[restore a record](#restore-an-earlier-version-of-a-record). It also keeps the
earlier versions of the exports index, `_index/{region}/exports.json`. Only
[`cdkd scrub`](cli-scrub.md) purges those two.

### If the two version actions are missing

Nothing fails. The command succeeds and prints a warning that counts and names
the affected keys and names the two actions to grant. The earlier versions
stay readable by anyone who can read the bucket with a `VersionId`.

One purge is quieter. When `lock.json` cannot be purged on an ordinary
release, cdkd logs the failure only under `--verbose`, because the lock holds
no secret and a release happens after every command.

Grant both actions or neither. With only `s3:ListBucketVersions`, the purge
lists the versions and then every delete is refused. The warning is the only
sign.

Adding the two actions to an older policy fixes future runs. Versions that
were left behind before then have to be removed by hand, with
`aws s3api list-object-versions` and `aws s3api delete-object --version-id`.

## S3 replication keeps copies cdkd cannot delete

If the state bucket has Cross-Region or Same-Region Replication enabled, the
purge removes earlier versions from the state bucket only. The copies in the
destination bucket remain, and anyone with `GetObject` there can read them by
`VersionId`.

No cdkd setting changes this, for two reasons. S3 never replicates a delete
that names a version ID, and a purge is such a delete. And cdkd does not
delete from any bucket other than the state bucket.

### How cdkd warns you

cdkd warns when replication applies, provided the principal has
`s3:GetReplicationConfiguration`. After a purge that removed an object's
contents, cdkd reads the bucket's replication configuration once per run. If a
rule covers the purged keys, cdkd prints a warning that names the destination
buckets.

Without the permission cdkd stays silent, and the purge itself is unaffected.

The check prefers a false warning to a missed one. It reports a rule that is
filtered by tags, and a disabled rule that has already copied objects.

### What you can do

- Purge the destination bucket yourself, with `list-object-versions` and
  `delete-object --version-id`.
- Narrow the replication rule so that it excludes the prefixes cdkd purges
  under.
- Accept that the replica keeps the history, and restrict
  `s3:GetObjectVersion` on the destination.

If you narrow the rule, these are the prefixes to exclude:

| Prefix | What cdkd purges there | Cost of excluding it |
| --- | --- | --- |
| `cdkd/` | The rollback journal, `lock.json`, `deployments/` | `state.json` and its history stop replicating too |
| `custom-resource-responses/` | Handler responses | None |
| `cdkd-migrate-tmp/` | Transient templates | None |
| `cdkd-bootstrap/` | The asset-storage marker | None |

The first prefix is whatever `--state-prefix` you use, so read the prefixes
from your own bucket before you write a rule.

### Other copies of the bucket

The same applies to any other copy, including the
[`aws s3 sync` backup](#keep-a-copy-outside-the-bucket). A purge on the state
bucket removes nothing from a backup or a replica.

## Related

- [Secrets in state](state-management-secrets.md): what cdkd masks and what
  it stores in the clear
- [`cdkd scrub`](cli-scrub.md): remove secrets from records and their earlier
  versions
- [`cdkd bootstrap`](cli-bootstrap.md): creates the state bucket
- [State Management](state-management.md): the layout of the bucket
