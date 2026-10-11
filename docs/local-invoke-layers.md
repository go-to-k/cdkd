---
title: Layers in cdkd local invoke
description: "How cdkd local invoke mounts Lambda layers: where each layer comes from, the order layers are merged in, layers in another account or partition, and the entries it rejects."
---

# Layers in cdkd local invoke

[`cdkd local invoke`](local-invoke.md) gives the function its layers, so a
handler that imports a library from a layer works locally. The same rules
apply to the functions [`cdkd local start-api`](local-start-api.md) runs.

```bash
cdkd local invoke MyStack/Handler --event event.json
cdkd local invoke MyStack/Handler \
  --layer-role-arn arn:aws:iam::123456789012:role/LayerReader
```

## How layers are mounted

cdkd mounts the function's layers read-only at `/opt`, as Lambda does. It
does not inspect a layer's contents, so the layout inside the layer
(`/opt/python`, `/opt/nodejs`, `/opt/lib`) is yours to get right.

When the function has several layers, cdkd merges their contents in template
order. If two layers contain the same file, the later layer wins, as on AWS.

## Where a layer comes from

How cdkd finds a layer depends on how the `Layers` entry is written:

- **A reference to a `LayerVersion` in the same stack**, written as
  `{ Ref: <LayerVersion> }` or `{ Fn::GetAtt: [<LayerVersion>, 'Ref'] }`.
  cdkd uses the layer's asset directory in the cloud assembly.
- **A layer-version ARN string.** cdkd downloads the layer with
  `lambda:GetLayerVersion` and unzips it to a temporary directory.

## Layers in another account

Your own credentials make the download. For a layer they cannot read,
typically one in another account, pass `--layer-role-arn <arn>`. Public
layers published by AWS, such as Lambda Powertools, need no role.

## Layers in other partitions

A layer ARN is used in the partition it names, so
`aws-cn`, `aws-us-gov`, `aws-eusc` and the ISO partitions work. The partition
must match the ARN's region: `arn:aws-cn:lambda:us-east-1:...` is refused.

## Entries that are rejected

cdkd stops with an error that names the entry when a `Layers` entry is one
of these:

- a string that is not a layer-version ARN, which covers a malformed ARN, a
  function ARN, an unversioned layer ARN, and a partition that disagrees with
  the region,
- a reference that does not point at an `AWS::Lambda::LayerVersion`,
- a reference to a `LayerVersion` with no asset path in the assembly.

## Related

- [`cdkd local invoke`](local-invoke.md): the worked example, the options and
  the supported runtimes
- [Containers, reloading and debugging](local-start-api-containers.md#lambda-code-layers-and-images):
  when `start-api` merges layers
