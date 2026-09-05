---
description: Keeping the docker argv out of user-visible failure text and the --verbose log (issue 2440)
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

Issue [#2440](https://github.com/go-to-k/cdkd/issues/2440). The DISPLAY-side
twin of `partitionSensitiveEnv`'s argv/env split
([layout-utils.md](layout-utils.md)).

**The defect.** `execFile` folds the whole command line into `err.message`, so
a docker failure with no stderr echoed the argv into a user-visible error
while the sibling debug line redacted the same bytes.

**The rule for a new site: COMPOSE, never hand-write.** All 27 docker failure
texts in the modules above go through `describeDockerFailure(error, args)` or
one of its two siblings in `docker-cmd.ts`. Each takes a REQUIRED `args` and
redacts internally, so a call site cannot get the text without handing over
the argv to redact it with — the guarantee is type-checked. **Pass the array
you actually spawned**: the redaction keys on it, and a plausible-looking
substitute silently leaks. This includes sites whose argv carries no user data
today, since an edit adding a `-e` pair later would otherwise reopen the hole
with no edit to the error site.

**What is masked**: the VALUE of `-e` / `--env` / `--opt` / `--label` /
`--build-arg`, in ALL THREE argv spellings (`--flag VALUE`, `--flag=VALUE`,
and pflag's attached `-eKEY=VALUE` — including its CLUSTERED forms
`-itdeKEY=VALUE` and `-itde KEY=VALUE`, which `docker run -itd` makes the
common ones); and every NON-LOCATOR param of
`--cache-from` / `--cache-to`, whose value is a comma-separated param list
rather than one pair. The KEY survives, and so does every locator cache param
— `type=s3,region=…,bucket=…` is the diagnostic. Four structural (positional, never value-based) passes, each
documented where it lives — `redactDockerArgvInText`, `nodeQuotedRendering`,
`QUOTED_ELEMENT_RE`, `repairSpawnRefusal`.

**A cache backend takes real credentials inline** (`secret_access_key`,
`access_key_id`, `session_token`, `token`), so `--cache-from` / `--cache-to`
are NOT the locators they look like — the
[#2623](https://github.com/go-to-k/cdkd/issues/2623) security review refused
the first cut's claim that they were. That mask keys on the PARAM NAME and
rides passes 1 / 1b only, since those are the ones that have the real argv;
the argv-free token scan deliberately does not model a comma list.

**It is an ALLOWLIST of locator params, not a denylist of credential ones,**
and round 2 is why: `cacheOptionToFlag` joins params with a bare `,` and no
quoting while BuildKit parses the value as CSV, so a value CONTAINING a comma
split into a masked head and a bare tail that printed verbatim — output that
LOOKS redacted. A param missing from the list costs one degraded diagnostic; a
param missing from a denylist costs a printed credential.

Round 3 showed the allowlist alone is not enough, because a continuation
fragment can NAME an allowlisted param (`token=aa,name=bbTAIL`). So
**everything after the first masked part is masked too** — the prefix before
the first credential survives, and BuildKit's own ordering puts `type=` there.
Two carve-outs, both measured: a bare `=`-free part at INDEX 0 is buildx's
legacy `--cache-from <NAME>` shorthand (a pure locator, and the whole
diagnostic — the continuation rule ate it for one round), and an empty value
is left empty rather than rendered `***`, which would assert a secret that
does not exist. `account_url` / `endpoint_url` / `url` / `url_v2` keep scheme
and host and lose userinfo, query and fragment: azblob builds an
UNAUTHENTICATED client from `account_url`, so a SAS token in its query is that
backend's SUPPORTED auth path, not an incidental URL credential. Those four
are the ONLY params exempt from mask-by-default, so their parse **fails
closed**: a value with no recognisable `//` authority is masked whole, the
userinfo strip anchors on the LAST `@` rather than a computed authority
boundary, and a host whose `:` is not followed by a pure PORT is masked as
`user:password` with its `@` cut away. All three were leaks first — a
scheme-less `user:pw@host:9000`, a password containing `?`, and a userinfo
containing a COMMA, which the param split cuts before the URL parse ever runs.

**The set has ONE spelling.** `ARGV_VALUE_TOKEN_RE`, the string-scanning form,
is now BUILT from `ARGV_VALUE_BEARING_FLAGS` rather than re-listed beside it
([#2623](https://github.com/go-to-k/cdkd/issues/2623)) — the two used to be
independent literals, so a flag added to one masked on the argv pass and
leaked on the text pass, a divergence neither one's tests can see.

**Why composers, not a fence.** This was a fence for four review rounds and
broke in every one — last because `err.cmd` carries the command line, so
`${err}` leaks it while touching no field.
`tests/unit/local/docker-argv-redaction-fence.test.ts` is the backstop,
anchored on the CATCH BLOCK; its header carries that history.

**Which flags stay unmasked, and why**, is recorded in
`ARGV_VALUE_BEARING_FLAGS`' JSDoc — including the two `docker build` flags
[#2623](https://github.com/go-to-k/cdkd/issues/2623) considered and left out
(`--secret` and `--build-context`, both carrying a LOCATOR rather than a
value — unlike the cache flags, which were in that bullet for one review round
and are now masked by param name).

**The fence's POPULATION is derived, and its root directory is part of the
guarantee.** It was rooted at `src/local` alone, so `src/assets/**` — where
`docker build` is composed for the deploy-time ECR publish AND for `cdkd local
run-task` — could not be seen at all ([#2623](https://github.com/go-to-k/cdkd/issues/2623)).
It now sweeps `src/local` + `src/assets` and selects on "spawns docker through
a shared helper" rather than on `promisify(execFile)`, which was an
implementation detail of the four modules #2440 happened to touch.
