---
title: Output streams
description: "Which cdkd commands write only a machine-readable document to stdout, which do so under --json, and where progress lines go."
---

# Output streams

Five cdkd commands always write a machine-readable document to stdout and
send everything else to stderr, so you can pipe or redirect their output
without a flag. This page lists those commands, the ones that behave this way
only under `--json`, and the ones whose stdout is for reading.

```bash
cdkd synth MyStack > template.yaml 2> progress.log
cdkd synth MyStack | yq '.Resources | keys'
cdkd list --long --json | jq -r '.[].name'
cdkd state list | while read -r ref; do echo "state for: $ref"; done
cdkd local invoke MyStack/Handler --event event.json | tail -1 | jq .body
```

## Commands whose stdout is always the document

On these five commands, stdout carries the document and nothing else:

| Command | What stdout carries |
| --- | --- |
| `cdkd synth` | The selected stack's CloudFormation template, or nothing. See [`cdkd synth`](cli-synth.md#the-stdout-contract). |
| `cdkd list` | The stack listing: one id per line, YAML under `--long` / `--show-dependencies`, JSON under `--json`. |
| `cdkd state list` | The state records: one `Stack (region)` per line, JSON under `--json`. |
| `cdkd local invoke` | The function's response payload. |
| `cdkd local invoke-agentcore` | The agent's response, buffered or streamed frame by frame. |

Everything that is not the document goes to stderr. That includes progress
lines such as `Synthesizing CDK app...`, the CDK app's own stderr, and
`--verbose` output. A terminal shows both streams together, so the text you
see there is unchanged. To merge the streams in a script, use `2>&1`.

## Every command's stdout at a glance

| Command | When stdout carries only the document |
| --- | --- |
| `cdkd synth`, `cdkd list`, `cdkd state list`, `cdkd local invoke`, `cdkd local invoke-agentcore` | Always |
| `cdkd state resources`, `cdkd state show`, `cdkd state info`, `cdkd drift`, `cdkd events` | Under `--json` only |
| `cdkd deploy`, and the `cdkd local` servers (`start-api`, `run-task`, `start-service`, `start-agentcore`, `start-alb`, `start-cloudfront`) | Never |

Without `--json`, the commands in the second row print a formatted view for a
person, and their progress lines stay on stdout with that view.

The commands in the third row use stdout for the progress display, the route
table or container logs, so there is no document to capture.

### Edge cases

- **`cdkd state list --long` and `--tree`.** These print a formatted view, not
  a record per line. The view still goes to stdout, and cdkd's progress lines
  go to stderr as they do on the plain listing.
- **Container-image builds on the two `local invoke` commands.** For a
  container-image Lambda, or an AgentCore runtime that cdkd builds,
  `cdkd local invoke` and `cdkd local invoke-agentcore` print
  `Building container image (platform=...)` and `Skipping docker build ...` on
  stdout. The response is then the last stdout line, which is why the example
  at the top of the page uses `tail -1`.
- **The container's own output.** It is not affected by the build lines. The
  Lambda runtime emulator's `START`, `END` and `REPORT` lines and every
  handler log line go to stderr.

## Related

- [`cdkd synth`](cli-synth.md#the-stdout-contract): what the template on stdout looks like
- [`cdkd list`](cli-list.md#what-it-prints): the listing formats
- [Exit codes](cli-reference-exit-codes.md): the other half of scripting cdkd
- [CLI Reference](cli-reference.md): every command and the shared options
