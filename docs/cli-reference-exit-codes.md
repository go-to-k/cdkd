---
title: Exit codes
description: "What cdkd's exit codes 0, 1, 2, 3, 70 and 130 mean, which commands use each, and how a script should react."
---

# Exit codes

A cdkd command exits `0` when it succeeded, `1` when it failed, and `2` when
it finished but left some of the work undone. Three more codes are specific to
one situation each. This page is the table for every command; each command's
own page lists the codes that command uses.

```bash
cdkd destroy MyStack --yes
case $? in
  0) echo "destroyed" ;;
  2) echo "partly destroyed; run it again" ;;
  *) echo "failed" ;;
esac
```

## What each code means

| Exit | Meaning |
| --- | --- |
| `0` | Success. The command completed and no resource is in an error state. |
| `1` | The command failed: an auth error, bad arguments, a synthesis crash, or any other error. |
| `2` | Partial failure. See [Exit `2`](#exit-2-partial-failure). |
| `3` | `cdkd diff` only: the deploy it previews would refuse to start. |
| `70` | cdkd stopped on an internal error, most likely a bug. |
| `130` | `cdkd local` only: interrupted with {kbd:ctrl+c}. |

[Local Execution](local-emulation.md) links to the pages of the `cdkd local`
commands, which have their own tables.

## Exit `1` as a result

Two commands use `1` to report a finding instead of an error, so that a CI
job can gate on it:

- `cdkd drift` exits `1` when it finds drift. A resource deleted outside cdkd
  counts as drift.
- `cdkd diff --fail-on any-change` (or `--fail`) exits `1` on any change.
  `cdkd diff --fail-on destructive` exits `1` on a change that replaces,
  deletes or orphans a resource.

## Exit `2`: partial failure

Exit `2` means the work completed, but a resource failed, was skipped, or was
only partially compared. cdkd keeps the state it has, and running the command
again usually resolves the problem. A script that treats every non-zero exit
from `cdkd destroy` as a hard failure can branch on `2` to schedule a retry.

What counts as a partial failure depends on the command:

- **`cdkd destroy`, `cdkd state destroy`.** A resource delete failed, or a
  delete was skipped. A skipped delete is one that cdkd did not confirm, so
  the resource may still exist and still be billing.
  [Destroy: skipped resources](cli-destroy-skipped.md)
  has the causes and remedies.
- **`cdkd deploy`.** The stack deployed, but a resource was left unaddressed.
  That is a skipped delete, a replacement whose old resource survives, a
  replacement refused because another state prefix records the stack (or the
  check could not run), or a resource that a failed create made and whose
  delete then failed. Under
  [`--allow-unaddressed`](cli-deploy-safety-ci-flags.md#allow-unaddressed-deploy) the
  deploy exits `0` in that case.
- **`cdkd publish-assets`.** The assets of one or more stacks failed to
  publish.
- **`cdkd rollback`.** An operation failed or was skipped, or a reverted
  operation left an untracked resource or was not fully reversed. When an
  operation fails, `cdkd rollback` keeps its journal, the file in the state
  bucket that lists what the failed deploy did, so you can run it again.
  [`cdkd rollback`](cli-rollback.md) lists what the journal records.
- **`cdkd state refresh-observed`.** Reading a resource back from AWS failed,
  or AWS reports the resource as not found. Those resources keep the
  properties recorded for them before.
- **`cdkd drift`.** Nothing drifted, but at least one comparison did not
  happen, for a reason you can act on. Whether running again clears the code
  depends on the cause. With `--accept` or `--revert`, exit `2` also means the
  run refused a resource deleted outside cdkd, or left one not reverted. See
  [`cdkd drift`](cli-drift.md).

### The summary line at exit `2`

The summary line that cdkd prints for each stack changes with the exit code.
On destroy:

```text
✓ Stack MyStack destroyed (12 deleted, 0 errors)                 # exit 0
⚠ Stack MyStack partially destroyed (10 deleted, 2 errors). State preserved — re-run 'cdkd destroy' / 'cdkd state destroy' to clean up.   # exit 2
```

The warning line continues with advice for the failure. When deletes were
skipped and none failed, the line reads `(N deleted, S skipped, 0 errors)`
and says that cdkd did not confirm the skipped resources were deleted.

On deploy:

```text
✓ Deployment completed successfully                              # exit 0
⚠ Stack MyStack deployed, but 1 resource(s) were left unaddressed — they may still exist in AWS. This counts toward a non-zero exit (2 unless something else fails; pass --allow-unaddressed to exit 0).   # exit 2
⚠ Stack MyStack deployed, but 1 resource(s) were left unaddressed — they may still exist in AWS. Exiting 0 because --allow-unaddressed was passed.   # exit 0
```

The second deploy line does not promise exit `2`. In a run over several
stacks, a later stack can still fail, and a failure exits `1`.

## Exit `3`: the deploy would refuse

Only `cdkd diff` exits `3`. It means the deploy that the diff previews would
refuse to start, so running the deploy changes nothing until you fix what the
diff named.

cdkd prints the full preview first, and lists the reasons under a
`Blocking (cdkd deploy will refuse):` heading. Exit `3` is separate from
`--fail`, so a CI job can tell "there is work to do" from "the work cannot
begin". [Exit 3](cli-diff.md#exit-3-the-deploy-would-refuse) lists the
conditions.

## Exit `70`: an internal error

Exit `70` means cdkd stopped on an internal error, which is most likely a bug.
cdkd prints a message saying so, and `70` replaces any code the command had
already set.

A stack lock may still be held after this exit. The lock expires on its own
after its time limit. To release it sooner, run
[`cdkd force-unlock`](cli-force-unlock.md) once nothing else is working on the
stack.

## Exit `130` and the other `cdkd local` codes

A `cdkd local` command exits `130` when you interrupt it with {kbd:ctrl+c}.

- On SIGTERM, `local start-service` and `local start-alb` also exit `130`.
  `local start-api`, `local start-cloudfront` and `local start-agentcore`
  exit `0`.
- `cdkd local run-task` exits with the exit code of its essential container.
  A container that exits `70` therefore yields `70`, without the
  internal-error message.

## Related

- [Output streams](cli-reference-output.md): the other half of scripting cdkd
- [`cdkd diff`](cli-diff.md): the conditions behind exit `3`
- [Destroy flags & guards](cli-destroy.md): skipped deletes and how to clear them
- [CLI Reference](cli-reference.md): every command and the shared options
