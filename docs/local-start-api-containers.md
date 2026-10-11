---
title: Containers, reloading and debugging in cdkd local start-api
description: "How cdkd local start-api manages its Lambda containers: reloading on source edits with --watch, attaching a debugger with --debug-port-base, the container pool, and shutdown."
---

# Containers, reloading and debugging in cdkd local start-api

[`cdkd local start-api`](local-start-api.md) keeps a small pool of containers
for each Lambda and reuses them between requests. This page covers the flags
that change how those containers are started, reloaded and debugged.

```bash
# reload when the app source changes
cdkd local start-api --port 3000 --watch

# start every container at boot
cdkd local start-api --port 3000 --warm

# attach a Node debugger
cdkd local start-api MyStack/MyPublicApi --debug-port-base 9229 --warm
```

## The container pool

Each Lambda has its own pool of containers, named
`cdkd-local-<logicalId>-<pid>-<random>`.

- The first request to a Lambda starts its first container. Pass `--warm` to
  start one container per Lambda at boot, so that the first request is fast.
- The pool grows to at most `--per-lambda-concurrency` containers, `2` by
  default. Requests beyond that wait in a queue. A value above `4` is lowered
  to `4` with a warning.
- A container that has been unused for 60 seconds is removed.

## `--watch`

`--watch` reloads the server when you edit the CDK app. cdkd watches the
app's source directory, which is the directory holding `cdk.json`, and
reloads 500 ms after an edit.

```bash
cdkd local start-api --port 3000 --watch
```

A reload re-synthesizes the app, rediscovers the routes and swaps in new
containers. Requests already in flight finish on the old containers, and new
requests use the new ones. Several files changed at once cause one reload.

cdkd ignores `cdk.out`, `node_modules` and `.git`, and it honours
`watch.include` and `watch.exclude` in `cdk.json`.

### Edge cases

- **Synthesis fails.** The previous version keeps serving, and cdkd prints a
  warning.
- **`-a <dir>` names a synthesized assembly.** The reload skips the synthesis
  step.
- **WebSocket servers and mTLS files** are not reloaded. Restart the command.

## `--debug-port-base`

`--debug-port-base <port>` gives each Lambda its own Node debugger port. The
ports count up from `<port>` in the order cdkd discovers the Lambdas.

```bash
cdkd local start-api MyStack/MyPublicApi --debug-port-base 9229 --warm
```

A Node handler waits until a debugger attaches, so a request hangs until you
connect. Handlers in other runtimes are unaffected.

Two things make the ports easier to find:

- cdkd does not print which Lambda has which port. Every Lambda in the run
  takes one, authorizer and WebSocket Lambdas included. Serve one API at a
  time and count from the base.
- Pass `--warm`. Without it, a port is not open until the first request
  starts the container.

## Lambda code, layers and images

Functions run as they do under [`cdkd local invoke`](local-invoke.md). That
page documents the supported runtimes, how layers are resolved and how
container images are found. On `start-api` the same work happens at these
times:

- **Layers** are merged once per Lambda at boot. `--layer-role-arn` applies to
  layers named by ARN.
- **Container-image Lambdas** are resolved once at boot and again on each
  `--watch` reload. cdkd builds the image from the cloud assembly's Docker
  asset or pulls it from ECR. An edit to the Dockerfile or the build context
  produces a new image on the next reload.
- **Architecture and `/tmp` size** are applied to every container, as on
  `local invoke`.

`start-api` has no `--ecr-role-arn`. An ECR pull from another account works
only when your own credentials can read the repository.
[`cdkd local invoke`](local-invoke.md#container-image-lambdas) has the flag.

## Shutdown

{kbd:ctrl+c} or `SIGTERM` shuts the server down in order. cdkd waits for
requests in flight, closes the servers, and removes every container and
temporary directory. If a container is still starting, cdkd waits up to 20
seconds for it and then removes it by name with a warning.

A second {kbd:ctrl+c} exits immediately. The warning names the containers
left behind and, with `--profile`, a temporary credentials file to delete. See
[Stopping a server](local-emulation.md#stopping-a-server).

## Related

- [`cdkd local start-api`](local-start-api.md): the worked example, the
  options and exit codes
- [`cdkd local invoke`](local-invoke.md): runtimes, layers and container
  images
