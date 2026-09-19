---
description: Keeping the docker argv out of failure text and verbose logs
paths:
  - 'src/utils/docker-cmd.ts'
  - 'src/local/docker-runner.ts'
  - 'src/local/ecs-task-runner.ts'
  - 'src/local/ecs-network.ts'
  - 'src/local/ecr-puller.ts'
  - 'src/local/invoke-agentcore-watch-loop.ts'
  - 'src/assets/docker-build.ts'
  - 'src/assets/docker-asset-publisher.ts'
---

# Docker argv redaction

Issue [#2440](https://github.com/go-to-k/cdkd/issues/2440). `execFile` folds the
command line into `err.message`, so a failure echoes the argv.

- **COMPOSE, never hand-write.** Every docker failure text goes through
  `describeDockerFailure(error, args)` or a sibling in `docker-cmd.ts`, each
  taking a REQUIRED `args`. **Pass the array you spawned** — a plausible
  substitute leaks.
- **A chained `cause` is such a text too**: thread it with
  `redactedDockerCause(err, args)`, never the caught error. Its field copy is an
  ALLOWLIST — a denylist carried `err.cmd`, the command line, verbatim.
- **Masked**: the VALUE of `-e` / `--env` / `--opt` / `--label` /
  `--build-arg`, and every NON-LOCATOR param of `--cache-from` / `--cache-to`
  (cache backends take credentials inline, so those flags are NOT locators).
  KEYs and locator cache params survive. Every pass is structural — positional,
  never value-based — and covers **all four pflag spellings**: `--flag VALUE`,
  `--flag=VALUE`, and the cluster ATTACHED (`-itdeKEY=VALUE`) or SEPARATED
  (`-itde KEY=VALUE`), which are separate code paths.
- **Cache params are an ALLOWLIST of locators, not a denylist of credentials**:
  a missing allowlist entry costs a diagnostic, a missing denylist entry a
  printed credential. **Everything after the first masked part is masked too**,
  since a continuation fragment can NAME an allowlisted param. Carve-outs: an
  `=`-free part at INDEX 0, and an empty value.
- `account_url` / `endpoint_url` / `url` / `url_v2` are the ONLY
  mask-by-default exemptions: scheme and host survive, userinfo, query and
  fragment do not. The parse **fails closed** — no `//` authority masks the
  whole value, the userinfo strip anchors on the LAST `@`, a host whose `:` is
  not a pure port is masked as `user:password`, and a `@` in a LATER part fails
  the param.
- **One spelling only**: `ARGV_VALUE_TOKEN_RE` is BUILT from
  `ARGV_VALUE_BEARING_FLAGS`, whose JSDoc says which flags stay unmasked.
- Backstop: `tests/unit/local/docker-argv-redaction-fence.test.ts`, anchored on
  the CATCH BLOCK.
