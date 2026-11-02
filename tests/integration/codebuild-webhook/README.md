# codebuild-webhook

`AWS::CodeBuild::Project` `Triggers` through the webhook calls (issue
[#5627](https://github.com/go-to-k/cdkd/issues/5627)).

A webhook lands on a real source repository, so this fixture takes two
parameters and FAILS without them, so a run that checked nothing cannot read as
a pass.

| Variable | Value |
|---|---|
| `CDKD_INTEG_WEBHOOK_REPO` | `<owner>/<name>` of a repository dedicated to this fixture, whose hooks `gh` can read |
| `CDKD_INTEG_WEBHOOK_CONNECTION_ARN` | an `AVAILABLE` GitHub connection that reaches it |

Use a throwaway private repository: the run creates and deletes a webhook on it.
Never point it at a repository anything else uses.

## Resources

- **AWS::CodeBuild::Project**: a `GITHUB` source authenticated by the connection.
  It never builds.
- **AWS::IAM::Role**: the L2's build role, granted the connection.

## What it verifies

Each row is one deploy, in order, and what CloudFormation does for it (CFn A/B
plus CloudTrail, recorded on the issue). Phases 1 to 6 assert the live
`project.webhook`.

| Phase | Template | Call | Live webhook |
|---|---|---|---|
| 1 | `Webhook: true` + filters | `CreateWebhook` | carries the filters |
| 2 | filters changed | `UpdateWebhook` | carries the new filters |
| 3 | `Triggers` removed | none | kept, filters too |
| 4 | `Webhook: true`, no filters | `UpdateWebhook` | no filters |
| 5 | `Webhook: false` | `DeleteWebhook` | gone |
| 6 | `Webhook: true` + filters | `CreateWebhook` | back, one hook on the repository |
| 7 | destroy | `DeleteProject` | project gone, no hook left on the repository |

Phase 1 also asserts `provisionedBy=sdk`, and every update keeps the project ARN.
