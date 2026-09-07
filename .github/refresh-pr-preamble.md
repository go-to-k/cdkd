Automated daily refresh of `tests/fixtures/cfn-schemas/*.json` against AWS's
public CloudFormation schema bundle.

**This PR may be RED, and that is the hand-off.** The job runs only the
mechanical chain (refresh, `gen:property-coverage`, backfill regeneration,
`gen:all-matrices`, `format`) and touches nothing that encodes a judgement — no
`unhandledByDesign`, no `bogusTolerated`, no `NESTED_KEY_ALLOW_LIST`, no
provider code. The section below names what fired, where, and what the AWS SDK
says about it.

While this PR stays open, later runs push additional drift onto this branch
rather than opening a second PR, and comment with the new diagnosis. Your
classification commits are never overwritten: everything the job rewrites is
derived and recomputed from the current sources.

Types with no entry in the public bundle keep the authenticated `DescribeType`
path as their only refresh route and are left untouched here.

Runbook: https://github.com/go-to-k/cdkd/blob/main/docs/schema-refresh-runbook.md
