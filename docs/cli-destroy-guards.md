---
title: "cdkd destroy: data guards and final snapshots"
description: "Why cdkd destroy fails on a bucket or ECR repository that still holds data, and how DeletionPolicy: Snapshot and --skip-final-snapshot work."
---

# cdkd destroy: data guards and final snapshots

Two rules keep a destroy from losing data you did not agree to lose. A bucket
or image repository that still holds data is not deleted unless the resource
opted in. A resource whose `DeletionPolicy` is `Snapshot` gets a final
snapshot before it is deleted.

Both rules match CloudFormation, and both apply to `cdkd destroy` and
`cdkd state destroy`. This page is part of
[cdkd destroy](cli-destroy.md).

## Non-empty S3 buckets and ECR repositories

A bucket that still holds objects, or an ECR repository that still holds
images, fails its delete. The data survives, the destroy exits `2`, and the
resource stays in the state record.

To have the destroy empty the resource for you, opt in from your CDK code and
deploy that change before you destroy:

```ts
import { RemovalPolicy } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';

new s3.Bucket(this, 'Uploads', {
  removalPolicy: RemovalPolicy.DESTROY,
  autoDeleteObjects: true, // destroy empties the bucket, then deletes it
});

new ecr.Repository(this, 'Images', {
  removalPolicy: RemovalPolicy.DESTROY,
  emptyOnDelete: true, // destroy deletes the repository with its images
});
```

Three resource types have this guard. cdkd recognises the opt-in by a tag
that CDK puts on the resource.

| Resource type | Opt-in in CDK | Tag cdkd reads |
| --- | --- | --- |
| `AWS::S3::Bucket` | `autoDeleteObjects: true` | `aws-cdk:auto-delete-objects` |
| `AWS::ECR::Repository` | `emptyOnDelete: true`, or the legacy `autoDeleteImages` | `aws-cdk:auto-delete-images` |
| `AWS::S3Express::DirectoryBucket` | None; set the tag yourself | `aws-cdk:auto-delete-objects` set to `true` |

With the opt-in, cdkd does the following:

- **S3 bucket:** deletes every object version and delete marker, then the
  bucket.
- **ECR repository:** deletes the repository with `force: true`, which removes
  its images with it.
- **S3 Express directory bucket:** empties the bucket, then deletes it.

Without the opt-in, the delete fails with a "bucket is not empty" error for an
S3 bucket, a "still contains images" error for a repository, and an "is not
empty" error for a directory bucket.

### Destroying without redeploying

If you do not want to change the CDK code, empty the resource by hand and run
the destroy again:

```bash
# S3: a versioned bucket also needs every object version and delete marker
# deleted. S3 Express directory buckets have no versioning, so this is enough
# for them.
aws s3 rm s3://<bucket> --recursive
aws ecr batch-delete-image --repository-name <repo> --image-ids <ids>

cdkd destroy MyStack
```

### Edge cases

- **A directory bucket.** CDK has no `autoDeleteObjects` for an S3 Express
  directory bucket. Declare the tag in `Tags` on the L1 `CfnDirectoryBucket`.
- **Objects written while the bucket is being emptied.** For both bucket types
  cdkd retries the emptying, so it picks up objects that arrive while it runs.
  That includes objects such as ALB access logs that land after the
  auto-delete custom resource cleaned up and before the bucket is deleted.
- **A replacement during `cdkd deploy`.** When a deploy replaces one of these
  three types, the delete of the old copy is governed by
  `--force-stateful-recreation` instead of the opt-in. Passing that flag
  accepts a recreation that loses data, so it also allows cdkd to empty the
  replaced resource.

### Compared with other tools

CloudFormation reports `DELETE_FAILED` in all three cases; for ECR, unless
`EmptyOnDelete: true` is set. Terraform requires `force_destroy` on a bucket
and `force_delete` on a repository.

cdkd also follows CloudFormation in two deletes that go the other way. An
`AWS::SecretsManager::Secret` is deleted at once, with no recovery window. IAM
role policy attachments that were made outside the template are
force-detached.

## `DeletionPolicy: Snapshot`: final snapshots on delete (`--skip-final-snapshot`)

A resource whose `DeletionPolicy` is `Snapshot` gets a final snapshot before
cdkd deletes it, as under CloudFormation. `--skip-final-snapshot` deletes it
without the snapshot.

You meet this with ordinary CDK database stacks, because the RDS constructs
`DatabaseInstance` and `DatabaseCluster` default `removalPolicy` to
`SNAPSHOT`.

```bash
# final snapshot first, per the policy
cdkd destroy MyStack

# delete without it (data loss)
cdkd destroy MyStack --skip-final-snapshot
cdkd state destroy MyStack --skip-final-snapshot --yes
cdkd rollback MyStack --skip-final-snapshot
```

`cdkd deploy`, `cdkd destroy`, `cdkd state destroy` and `cdkd rollback` all
accept `--skip-final-snapshot`. Use it for dev and test stacks where you do
not want to pay or wait for the snapshot, and to get past
[the refusal below](#when-cdkd-refuses-to-delete).

> [!WARNING]
> A final snapshot is an AWS resource that outlives the destroy, and AWS bills
> for it. Delete it yourself when you no longer need it.

### How the final snapshot is created, by type

Eight resource types support a final snapshot. For five of them the delete
call itself takes the snapshot. For the other three cdkd takes the snapshot
first, waits for it, and then deletes.

| Resource type | How the final snapshot is created |
| --- | --- |
| `AWS::RDS::DBInstance` | `DeleteDBInstance` with `FinalDBSnapshotIdentifier` |
| `AWS::RDS::DBCluster` | `DeleteDBCluster` with `FinalDBSnapshotIdentifier` |
| `AWS::Neptune::DBCluster` | `DeleteDBCluster` with `FinalDBSnapshotIdentifier` (Neptune) |
| `AWS::DocDB::DBCluster` | `DeleteDBCluster` with `FinalDBSnapshotIdentifier` (DocDB) |
| `AWS::ElastiCache::CacheCluster` | `DeleteCacheCluster` with `FinalSnapshotIdentifier` |
| `AWS::EC2::Volume` | `CreateSnapshot`, waited to `completed`, then `DeleteVolume` |
| `AWS::Redshift::Cluster` | `CreateClusterSnapshot`, waited to `available`, then the delete |
| `AWS::ElastiCache::ReplicationGroup` | ElastiCache `CreateSnapshot`, waited to `available`, then the delete |

Three limits apply:

- An RDS instance that is a member of a cluster is deleted without a snapshot,
  as in CloudFormation.
- The two ElastiCache types take a snapshot for the Redis engine only. A
  Memcached cache cluster or replication group fails with AWS's rejection.
- A node type that cannot snapshot fails the same way.

CloudFormation reports `DELETE_FAILED` for the last two.

### Finding the snapshot afterwards

The snapshot is named `<base>-final-<utcTimestamp>`. The timestamp is
`yyyymmdd-hhmmss` in UTC. `<base>` is the resource's physical ID, changed by
these rules so that it is a valid snapshot name:

1. It is lowercased.
2. Every character outside `a-z`, `0-9` and `-` becomes `-`. Runs of `-`
   collapse to one, and leading and trailing `-` are dropped.
3. `r` is prepended when the result does not start with a letter.
4. For ElastiCache only, it is cut to the first 28 characters, and any
   trailing `-` is then dropped.

EC2 volumes, Redshift clusters and replication groups log the snapshot's
identifier as they create it. The other five types log only that the delete
takes a final snapshot. Their identifier spells out the physical ID, which may
come from a secret, so cdkd does not print it.

Find those among the service's manual snapshots by prefix:

```bash
# RDS DBCluster (for DocDB and Neptune, run the same command as `aws docdb` /
# `aws neptune`)
aws rds describe-db-cluster-snapshots --snapshot-type manual \
  --query "DBClusterSnapshots[?starts_with(
    DBClusterSnapshotIdentifier, 'my-cluster-final-'
  )].DBClusterSnapshotIdentifier"
# RDS DBInstance
aws rds describe-db-snapshots --snapshot-type manual \
  --query "DBSnapshots[?starts_with(
    DBSnapshotIdentifier, 'my-instance-final-'
  )].DBSnapshotIdentifier"
# ElastiCache CacheCluster
aws elasticache describe-snapshots \
  --query "Snapshots[?starts_with(
    SnapshotName, 'my-cache-final-'
  )].SnapshotName"
```

### When cdkd refuses to delete

cdkd refuses to delete a `Snapshot` resource when it has no way to take the
snapshot. The destroy then exits `2`.

This happens for the five types whose delete call takes the snapshot: RDS
instances and clusters, Neptune and DocDB clusters, and ElastiCache cache
clusters. cdkd can manage each of them in two ways: through its own code for
that service, or through Cloud Control, AWS's generic resource API. Cloud
Control's delete has no final-snapshot parameter, so on that route cdkd cannot
do what the policy asks. The state record of a resource cdkd manages through
Cloud Control says `provisionedBy: cc-api`.

To delete such a resource, take the snapshot by hand and then run the destroy
again with `--skip-final-snapshot`.

### Which policy cdkd reads

A destroy uses the `DeletionPolicy` recorded for the resource in the state
record. It does not read your template.

When the state record holds no policy for a resource, cdkd applies
CloudFormation's default:

| Resource | Default |
| --- | --- |
| `AWS::RDS::DBCluster` | `Snapshot` |
| `AWS::RDS::DBInstance` without `DBClusterIdentifier` | `Snapshot` |
| Every other resource, including a cluster-member `AWS::RDS::DBInstance` | `Delete` |

So an L1 `CfnDBCluster` or a standalone `CfnDBInstance` with no
`DeletionPolicy` gets a final snapshot on destroy. It gets one too when a
deploy removes it and when a rollback undoes its creation. If cdkd manages it
through Cloud Control, the delete is refused as for an explicit `Snapshot`.
Pass `--skip-final-snapshot` to delete without a snapshot.

`UpdateReplacePolicy` defaults to `Delete` for every type, so the delete of a
replaced resource takes no snapshot by default.

#### Edge cases

- **State written before schema v5** records no policy until a redeploy
  records it. Until then the defaults above apply.
- **A deploy that removes a resource from the template** falls back to the
  template's `DeletionPolicy` when the state record holds none.

### Deletes outside `cdkd destroy`

cdkd applies the same snapshot rule wherever it deletes a resource. Which of
the two policies decides depends on the delete:

| Delete | Policy that decides |
| --- | --- |
| `cdkd destroy`, `cdkd state destroy`, a deploy that removes the resource | `DeletionPolicy` |
| A rollback that undoes the resource's creation | `DeletionPolicy` |
| A replacement's delete of the old copy | `UpdateReplacePolicy` |
| A rollback's delete of a replacement's new copy | `UpdateReplacePolicy` |

The rollback row covers the automatic rollback, `cdkd rollback` and
`--revert-failed`. One rollback delete is an exception to the last row: when a
replacement's create made the new copy and then failed, the rollback deletes
that copy under its `DeletionPolicy`.

A type cdkd cannot snapshot, or a resource it manages through Cloud Control,
fails at every one of these deletes. CloudFormation fails the update in the
same cases.

### Re-running after a failed destroy

A destroy can fail after the snapshot was taken. What the re-run does then
depends on the type:

- **EC2 volume:** the snapshot is tagged `cdkd:final-snapshot-of: <volumeId>`,
  so the re-run reuses it.
- **Redshift and ElastiCache:** the re-run creates a second snapshot with a
  new timestamp, and AWS bills for both. Their snapshot names can be reused,
  so an existing snapshot with that name could hold older data.

[cdkd destroy internals](cli-destroy-internals.md#final-snapshots) has the rest:
per-type notes, what each delete does when a snapshot fails part-way, and how
a Cloud Control delete behaves under `DeletionPolicy: Delete`.

## Related

- [cdkd destroy](cli-destroy.md) — the command, its options and what can stop it
- [cdkd destroy: deletion protection](cli-destroy-protection.md) — `--remove-protection`
- [`cdkd rollback`](cli-rollback.md#deletionpolicy-on-a-rolled-back-create) — the same policy on a rolled-back create
