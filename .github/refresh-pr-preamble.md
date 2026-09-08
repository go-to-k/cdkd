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

It also separates out the nested-key divergences a **dependency bump** already
resolves. For those, the job downloads the published client and re-asks the
finding's own interface-scoped question there; the ones the published client
declares are grouped into one bump each rather than one decision per finding.
They stay counted — until the bump lands the value does not reach AWS — so what
is removed is the investigation, not the action.

It touches nothing else that encodes a judgement — no `unhandledByDesign`, no
`NESTED_KEY_ALLOW_LIST`, no provider code, and no dependency is bumped here. The
sections below name what fired, where, and what the AWS SDK says about it.

While this PR stays open, later runs push additional drift onto this branch
rather than opening a second PR, and comment with the new diagnosis. Your
classification commits are never overwritten: everything the job rewrites is
derived and recomputed from the current sources.

Types with no entry in the public bundle keep the authenticated `DescribeType`
path as their only refresh route and are left untouched here.

Runbook: https://github.com/go-to-k/cdkd/blob/main/docs/schema-refresh-runbook.md
