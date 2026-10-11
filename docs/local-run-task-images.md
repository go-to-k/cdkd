---
title: Images in cdkd local run-task
description: "How cdkd local run-task resolves a container image that references the stack, which registry hosts it authenticates to as ECR, and which images it builds locally as CDK assets."
---

# Images in cdkd local run-task

[`cdkd local run-task`](local-run-task.md#images) pulls a public image, logs
in to ECR for a private one, and builds a CDK asset image from the cloud
assembly. This page covers three cases where the image a container names
needs more explanation.

## Images that reference the stack

An image taken from an ECR repository in the same stack has no fixed URI in
the template:

```ts
const repo = new ecr.Repository(this, 'Repo');

taskDef.addContainer('web', {
  image: ecs.ContainerImage.fromEcrRepository(repo, 'latest'),
});
```

CDK synthesizes the image URI as an `Fn::Sub` or `Fn::GetAtt` that refers to
the repository, the account and the region. cdkd resolves each part before
it fetches the image:

| Part of the image URI | Resolved from | Needs a state flag |
| --- | --- | --- |
| `${AWS::AccountId}`, `${AWS::Region}`, `${AWS::Partition}`, `${AWS::URLSuffix}` | STS and the region | No |
| A same-stack `AWS::ECR::Repository` (`${<LogicalId>}`, or `Fn::GetAtt` of `Arn` \| `RepositoryUri`) | The deployed repository name | Yes |

The repository's name exists only after a deploy, so the stack must have
been deployed first. Pass the flag that matches how it was deployed:

```bash
# deployed with cdkd deploy
cdkd local run-task MyStack/TaskDef --from-state

# deployed with the AWS CDK CLI
cdkd local run-task MyStack/TaskDef --from-cfn-stack
```

Without either flag, a reference to a same-stack repository fails with an
error that names the two flags.

## Which registry hosts are treated as ECR

cdkd must log in before it can pull from a private ECR registry, so it
decides from the image's host name whether the registry is ECR. It logs in
to the exact host the image names. An image on a FIPS endpoint, a dual-stack
endpoint or another account's registry therefore authenticates on its own
endpoint.

| Host shape | Recognized |
| --- | --- |
| `<account>.dkr.ecr.<region>.<urlSuffix>` | Yes |
| `<account>.dkr.ecr-fips.<region>.<urlSuffix>` | In commercial and GovCloud regions |
| `<account>.dkr-ecr[-fips].<region>.on.aws` (dual-stack) | In commercial and GovCloud regions |
| A host whose suffix belongs to another region's partition | No |
| A region prefix cdkd does not know yet | No |

An image whose host has a region prefix cdkd does not know yet is pulled
anonymously, and a debug line says that the host looked like ECR.

Letter case in the host is ignored. A host that contains a non-ASCII
character is refused.

### Partition and URL suffix by region

cdkd derives the partition and the URL suffix from the region. It uses the
same mapping wherever it substitutes `${AWS::Partition}` and
`${AWS::URLSuffix}`.

| Region prefix | Partition | URL suffix |
| --- | --- | --- |
| `us-gov-*` | `aws-us-gov` | `amazonaws.com` |
| `cn-*` | `aws-cn` | `amazonaws.com.cn` |
| `us-iso-*` | `aws-iso` | `c2s.ic.gov` |
| `us-isob-*` | `aws-iso-b` | `sc2s.sgov.gov` |
| `eu-isoe-*` | `aws-iso-e` | `cloud.adc-e.uk` |
| `us-isof-*` | `aws-iso-f` | `csp.hci.ic.gov` |
| `eusc-*` | `aws-eusc` | `amazonaws.eu` |
| everything else | `aws` | `amazonaws.com` |

## Which images are built as CDK assets

A CDK asset image, such as one from `ContainerImage.fromAsset`, is built
locally from the cloud assembly. cdkd recognizes an asset image by the name
of the repository in its URI, which must be a container-assets repository:

| Repository | Recognized |
| --- | --- |
| `cdk-<qualifier>-container-assets-<acct>-<region>`, any qualifier | Always |
| `cdkd-container-assets-<acct>-<region>` | Always |
| A custom name from `cdkd bootstrap --container-repo <name>` | Under `--from-state`, when the region's bootstrap marker can be read |

An asset image that cdkd does not recognize is pulled from ECR. The pull is
slower than a local build, and the result is otherwise the same.

## Related

- [`cdkd local run-task`](local-run-task.md): the worked example, the options
  and `--ecr-role-arn`
- [Value resolution in local execution](local-emulation-value-resolution.md):
  what `--from-state` and `--from-cfn-stack` read
