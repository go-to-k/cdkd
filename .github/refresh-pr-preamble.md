Automated daily refresh of `tests/fixtures/cfn-schemas/*.json` against AWS's
public CloudFormation schema bundle.

**Read the TITLE, not the checks.** GitHub holds this pull request's
workflows at `action_required` until a maintainer approves them, so there is
no red check to wait for — there is no check at all yet. The count in the
title and the `needs-decision` label are the job's own verdict, produced by
running every fixture-driven check inside the run before CI is allowed to
start. Each decision is labelled `D1`…`DN` below.

**What is left is a hand-off, and that is by design.** The job runs the
mechanical chain (refresh, `gen:property-coverage`, backfill regeneration,
`gen:all-matrices`, `format`), and it settles one narrow class itself: a
removed property whose own SDK client still declares the name on a shape
reachable from an operation input, which the provider still reads off the
template, with no name on the type that could be it renamed. Those are listed
separately below with the evidence, and deleting the entry makes the next
cycle report the property again.

It touches nothing else that encodes a judgement — no `unhandledByDesign`, no
`NESTED_KEY_ALLOW_LIST`, no provider code. The sections below name what fired,
where, and what the AWS SDK says about it.

While this PR stays open, later runs push additional drift onto this branch
rather than opening a second PR, and comment with the new diagnosis. Your
classification commits are never overwritten: everything the job rewrites is
derived and recomputed from the current sources.

Types with no entry in the public bundle keep the authenticated `DescribeType`
path as their only refresh route and are left untouched here.

Runbook: https://github.com/go-to-k/cdkd/blob/main/docs/schema-refresh-runbook.md
