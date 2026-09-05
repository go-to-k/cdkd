---
description: Keeping the docker argv out of user-visible failure text and the --verbose log (issue 2440)
paths:
  - 'src/utils/docker-cmd.ts'
  - 'src/local/docker-runner.ts'
  - 'src/local/ecs-task-runner.ts'
  - 'src/local/ecs-network.ts'
  - 'src/local/invoke-agentcore-watch-loop.ts'
---

# Docker argv redaction

Issue [#2440](https://github.com/go-to-k/cdkd/issues/2440). The DISPLAY-side
twin of `partitionSensitiveEnv`'s argv/env split
([layout-utils.md](layout-utils.md)).

**The defect.** `execFile` folds the whole command line into `err.message`, so
a docker failure with no stderr echoed the argv into a user-visible error
while the sibling debug line redacted the same bytes.

**The rule for a new site: COMPOSE, never hand-write.** All 20 docker failure
texts in the modules above go through `describeDockerFailure(error, args)` or
one of its two siblings in `docker-cmd.ts`. Each takes a REQUIRED `args` and
redacts internally, so a call site cannot get the text without handing over
the argv to redact it with — the guarantee is type-checked. **Pass the array
you actually spawned**: the redaction keys on it, and a plausible-looking
substitute silently leaks. This includes sites whose argv carries no user data
today, since an edit adding a `-e` pair later would otherwise reopen the hole
with no edit to the error site.

**What is masked**: the VALUE of `-e` / `--env` / `--opt` / `--label`; the KEY
survives. Four structural (positional, never value-based) passes, each
documented where it lives — `redactDockerArgvInText`, `nodeQuotedRendering`,
`QUOTED_ELEMENT_RE`, `repairSpawnRefusal`.

**Why composers, not a fence.** This was a fence for four review rounds and
broke in every one — last because `err.cmd` carries the command line, so
`${err}` leaks it while touching no field.
`tests/unit/local/docker-argv-redaction-fence.test.ts` is the backstop,
anchored on the CATCH BLOCK; its header carries that history.

**Which flags stay unmasked, and why**, is recorded in
`ARGV_VALUE_BEARING_FLAGS`' JSDoc. `--build-arg` in
`src/assets/docker-build.ts` is the same class in a subsystem this fence
cannot reach: [#2623](https://github.com/go-to-k/cdkd/issues/2623).
