---
title: cdkd gc internals
description: "How cdkd gc matches asset references, which parts of a reference it compares case-insensitively, and how it deletes."
unlisted: true
---

# cdkd gc internals

Background for contributors on how [`cdkd gc`](cli-gc.md) decides that an
asset is referenced, and how it deletes. The user-facing behaviour is on the
command's own page.

## Reference shapes

References are collected from each resource's `properties`,
`observedProperties` and `attributes`, and from the stack `outputs`, of every
state file in the bucket.

- `{S3Bucket, S3Key}` / `{Bucket, Key}` pairs (Lambda `Code` and similar), and
  any other object shape carrying the asset bucket name as a value. Every
  sibling string in that object is protected.
- `s3://` URIs.
- Virtual-hosted and path-style `https://…<urlSuffix>` URLs, with query strings
  stripped.
- ECR image URIs, by `:tag` and/or `@sha256:digest`.
- Content-addressed `<sha256>.<ext>` tokens anywhere in a state string, which
  protects keys embedded in joined lists.
- References inside base64-encoded values, one decode level deep. This covers
  `Fn::Base64`-resolved EC2 / Auto Scaling UserData that fetches assets at
  boot.

`<urlSuffix>` matches every partition's suffix (`amazonaws.com`,
`amazonaws.com.cn`, `c2s.ic.gov`, `sc2s.sgov.gov`, `cloud.adc-e.uk`,
`csp.hci.ic.gov`, `amazonaws.eu`), not just the one the gc region uses. The
scan reads state written by any cdkd binary for any region, and a suffix the
matchers miss would read as unreferenced and be deleted.

ECR hosts additionally match the FIPS
(`<acct>.dkr.ecr-fips.<region>.<urlSuffix>`) and dual-stack
(`<acct>.dkr-ecr.<region>.on.aws`, `<acct>.dkr-ecr-fips.<region>.on.aws`)
endpoints.

## Case sensitivity

DNS is case-insensitive and object keys are not, so each shape folds exactly
the parts that name the same live thing and compares the rest byte for byte.
An error in either direction deletes a live object: a reference collected in a
spelling the candidate never matches leaves the live object unprotected.

| Reference shape | Folded to lower case | Compared exactly |
| --- | --- | --- |
| `s3://<bucket>/<key>` | scheme | bucket (the URI authority), object key |
| `https://<bucket>.s3.<region>.<suffix>/<key>` (virtual-hosted) | scheme, bucket label, `s3` label, region, URL suffix | object key |
| `https://s3.<region>.<suffix>/<bucket>/<key>` (path style) | scheme, `s3` label, region, URL suffix | bucket (a path segment), object key |
| `<acct>.dkr.ecr.<region>.<suffix>/<repo>:<tag>` | host | tag |
| `<acct>.dkr.ecr.<region>.<suffix>/<repo>@sha256:<digest>` | host, and the digest is normalized to lower case as it is collected | — |

The bucket name folds only where it is a DNS label, the virtual-hosted shape,
where an upper-cased spelling reaches the same live object. It stays exact in
path style and in an `s3://` URI, which S3 compares byte for byte.

An ECR tag is kept verbatim, because ECR tags are case-sensitive. A digest is
folded, because it is compared for equality against ECR's always-lower-case
`imageDigest`.

## Region and marker

The region gc reports, the region its clients target and the region its marker
key is built from are one value, and the delete plan names it. `cdkd bootstrap`
writes the marker through the same resolver and the same reconciliation, so
the read and write sides cannot drift apart.

## Response placeholders

The placeholder sweep is account-scoped because the keys carry no region. It
matches the producer's own key shape, `cdkd-{epoch}-{suffix}.json`, and does
not delete everything under the prefix by age.

Only the default prefix is swept. The provider registry can be configured with
a different response prefix, and nothing persists which one a past deploy
used, so gc cannot discover a non-default layout. It under-collects, which is
the safe direction.

The provider's own cleanup also purges noncurrent versions of the keys it
deletes on the normal path.

## Deletion

Deletion is chunked: `DeleteObjects` at 1,000 keys per call and
`BatchDeleteImage` at 100 images per call. Any per-item failure is surfaced as
a hard error.

The noncurrent-version purge fails soft, and its two missing permissions fail
differently. A missing `s3:ListBucketVersions` denies the listing outright. A
missing `s3:DeleteObjectVersion` comes back as per-key entries in
`DeleteObjects`' `Errors` array while the call itself reports success, which
cdkd reads and reports.

## Related

- [`cdkd gc`](cli-gc.md)
- [`cdkd bootstrap`](cli-bootstrap.md)
- [State Store](state-management.md)
