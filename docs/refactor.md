---
title: Keep Resources When You Rename or Move Constructs
description: "Rename a construct, move it under another parent, or move it to another stack without cdkd deploy replacing the AWS resource: run cdkd refactor first."
---

# Keep Resources When You Rename or Move Constructs

Reorganizing CDK code changes logical IDs. Renaming a construct, moving it
under another parent construct, or moving it to another stack all give the
resource a new logical ID or a new stack. `cdkd deploy` then deletes the old
resource and creates a new one, and a table, bucket or database loses its
data. Run [`cdkd refactor`](cli-refactor.md) after the code change and before
the deploy to keep the resource instead.

::: steps

1. **Change the CDK code.**

   Rename the construct, wrap it in a new parent, or move it to another
   stack. Change nothing else about the resource in the same step.

2. **See what the deploy would do.**

   ```bash
   cdkd diff MyStack --fail-on=destructive
   ```

   The renamed resource shows up as `will be destroyed` for the old logical
   ID, beside an addition of the new one. When cdkd can tell the two are the
   same resource, the removal says so:
   `(moved to MyStack.NewId, run 'cdkd refactor' to keep it)`. For a move
   between stacks, diff both: `cdkd diff OldStack NewStack`.

3. **Preview the refactor.**

   ```bash
   cdkd refactor MyStack --dry-run
   ```

   Each line `OldId -> NewId` is a resource cdkd will keep. For a move between
   stacks, select both stacks: `cdkd refactor OldStack NewStack --dry-run`.

4. **Run it.**

   ```bash
   cdkd refactor MyStack
   ```

   It asks for confirmation and then renames the records in cdkd state. No
   AWS resource is touched.

5. **Check, then deploy.**

   ```bash
   cdkd diff MyStack --fail
   cdkd deploy MyStack
   ```

   The diff shows no change for the refactored resources, and the deploy keeps
   them.

:::

## When cdkd refactor stops

| Message | What to do |
| --- | --- |
| `Ambiguous (...)` | Two resources look the same. Edit the mapping file it prints and pass it with `--override-file`. |
| `Not refactored: ... also changes ...` | You changed the resource's properties too. Revert that change, refactor, deploy, then reapply the change. |
| `... has no cdkd state` | A move's destination stack has not been deployed yet. Deploy it first. |
| `... did not finish` from `cdkd deploy` or `cdkd destroy` | An earlier refactor was interrupted mid-move. Run `cdkd refactor <that stack>` to finish it. |

[cdkd refactor](cli-refactor.md) has every option, how pairs are found, and
what happens when a refactor is interrupted.
