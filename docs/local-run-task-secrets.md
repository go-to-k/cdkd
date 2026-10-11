---
title: Secrets in cdkd local run-task
description: "How cdkd local run-task fetches a container's Secrets from Secrets Manager and SSM, how the values reach the container, and which secret names it refuses to forward."
---

# Secrets in cdkd local run-task

[`cdkd local run-task`](local-run-task.md) fetches every entry in a
container's `Secrets` once, at startup, and sets each one as an environment
variable in the container. This is what ECS does when it starts the task.

```ts
taskDef.addContainer('web', {
  image: ecs.ContainerImage.fromAsset('app'),
  secrets: {
    DB_PASSWORD: ecs.Secret.fromSecretsManager(dbSecret, 'password'),
  },
});
```

```bash
cdkd local run-task MyStack/TaskDef --from-state
```

`ecs.Secret.fromSecretsManager(dbSecret)` synthesizes a reference to the
secret's ARN, so the command needs `--from-state` or `--from-cfn-stack` to
learn the ARN. [Environment variables and secrets](local-run-task.md#environment-variables-and-secrets)
covers that step.

## Which `ValueFrom` forms are fetched

After references are resolved, cdkd fetches each `Secrets[].ValueFrom`
according to its form:

| `ValueFrom` | Call |
| --- | --- |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>` | `GetSecretValue` |
| `arn:aws:secretsmanager:<region>:<account>:secret:<name>:<json-key>::` | `GetSecretValue`, then the `<json-key>` field of the JSON value |
| `arn:aws:ssm:<region>:<account>:parameter/<name>` | `GetParameter` with decryption |

## When a secret cannot be fetched

The run stops, and the error names the container and the secret. Fix your
credentials or the IAM policy and run the command again.

## How the value reaches the container

cdkd passes the value to `docker run` through the environment of the
`docker run` process, so the value does not appear on a command line.

The exception is
[finch on macOS and Windows](local-emulation.md#finch-on-macos-and-windows),
where cdkd refuses to run a task that has secrets.

## Secret names that are not forwarded

cdkd drops a secret, with a warning naming it, when the secret's name would
change how the container client itself behaves. A secret named `DOCKER_HOST`,
for example, would point the client at another Docker daemon, which would let
a template redirect it. If the container needs such a secret, rename it.

Two kinds of name are dropped. The first is a name that is empty or contains
`=` or a NUL character. The second is a name, in any letter case, that the
container client (Docker, podman, nerdctl, finch) or one of its credential
helpers reads:

| Family | Examples |
| --- | --- |
| Docker connection, TLS and behaviour settings | `DOCKER_HOST`, `DOCKER_CONFIG`, `DOCKER_TLS_VERIFY` |
| Process, loader and trust variables | `PATH`, `HOME`, `GCONV_PATH`, `SSL_CERT_FILE`; the `LD_` / `DYLD_` prefixes |
| SSH helper variables | `SSH_AUTH_SOCK`, `SSH_ASKPASS` |
| AWS variables `docker-credential-ecr-login` reads | `AWS_PROFILE`, `AWS_ECR_CACHE_DIR`; the `AWS_ENDPOINT_URL_` prefix |
| gcloud variables `docker-credential-gcloud` reads | `GCE_METADATA_HOST`; the `CLOUDSDK_` prefix, except `CLOUDSDK_AUTH_ACCESS_TOKEN`, which is forwarded |
| Interpreter variables of a credential helper written in a scripting language | `SHELLOPTS`, `PS4`, `PYTHONPATH`, `PYTHONWARNINGS`, `BROWSER`, `REQUESTS_CA_BUNDLE`, `NODE_OPTIONS`, `RUBYOPT`, `PERL5OPT`, `OPENSSL_CONF`; the `BASH_FUNC_` prefix |
| podman connection and config files | `CONTAINER_HOST`, `CONTAINERS_CONF`, `REGISTRY_AUTH_FILE` |
| nerdctl connection, config and CNI | `CONTAINERD_ADDRESS`, `NERDCTL_TOML`, `CNI_PATH` |
| finch's Lima layer | `SSH` |
| Base directories the above fall back to | `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`; on Windows `APPDATA`, `PROGRAMDATA`, `PROGRAMFILES`, `LOCALAPPDATA` |

## Related

- [`cdkd local run-task`](local-run-task.md): the worked example and the
  options
- [Value resolution in local execution](local-emulation-value-resolution.md):
  how `--from-state` and `--from-cfn-stack` resolve a secret's ARN
