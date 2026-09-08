---
title: CFn schema refresh runbook
description: "What the daily schema-fixture refresh job does, and what a maintainer does when it opens a pull request."
unlisted: true
---

# CFn schema refresh runbook

A scheduled job keeps `tests/fixtures/cfn-schemas/*.json` current with what AWS
publishes, because those fixtures decide SDK-vs-Cloud-Control routing and a
property missing from them is dropped silently. This page is the operator's
side of it: what arrives, and what to do with it.

The reasoning behind the design — why a scheduled PR rather than a CI check,
why the job is allowed to fail — is in
[Provider Rules](provider-rules.md#workflow-when-aws-publishes-new-properties).

## The short version

| What you see | What to do |
| --- | --- |
| No pull request | Nothing. Most days are this. |
| A pull request, CI green | Read the diff, squash merge. |
| A pull request, CI red | Something needs a decision — the PR names which class. |
| A pull request labelled `needs-decision`, assigned to you | The same thing, said where you can see it without opening the PR. |
| A pull request saying the nested-key check failed unreadably | Read that job's log; the other sections still hold. |
| A comment on an open pull request | New drift was added to it. Same classes. |
| A section naming a failed CI check | That check's own guidance is in the PR; its findings are not covered by the other sections. |

The job keeps **at most one pull request open**. While one is open, later runs
push the new drift onto that same branch and comment with what it added, so
nothing waits for a merge.

Your commits on that branch are safe **while the pull request is open**: the
push is additive and never forced, everything the job rewrites is derived and
recomputed from your current sources, and the classification you write does not
live in those files. Once a pull request is CLOSED without merging, its branch
loses that protection — a same-day re-run reuses the name and replaces it. If
you want to keep working on a closed one, rename the branch first.

## What the job does

Daily, on `bot/cfn-schema-refresh/<YYYY-MM-DD>`:

1. Switches to the open refresh pull request's branch, if there is one, so
   drift is measured against what that PR already carries.
2. Downloads AWS's public CloudFormation schema bundle. No AWS credentials are
   involved.
3. Rewrites only the fixtures that actually changed. A capture-date-only
   difference is not a change.
4. **Stops if nothing drifted, and no refresh pull request is open** — no
   branch, no pull request, no comment.
5. Otherwise regenerates the derived artifacts, then either opens a pull
   request or adds a commit and a diagnosis comment to the open one.
6. Marks the pull request with how many decisions are left, or clears the
   marking when there are none. This is the step that also runs on a
   no-drift day, so a decision you have settled stops being advertised.

Nothing that encodes a judgement is touched: no `unhandledByDesign`, no
`bogusTolerated`, no `NESTED_KEY_ALLOW_LIST`, no provider code.

The **standing backfill issue is not written by this job**. A separate
workflow, `backfill-umbrella-sync.yml`, regenerates its checklist whenever
`src/provisioning/property-coverage.generated.ts` changes on `main` — a refresh
merge, a hand-written backfill, a revert. Driving it from `main` is what keeps
the issue describing something that actually exists: written during the refresh
run instead, it described the job's own workspace, so closing a refresh PR
unmerged left the issue listing properties `main` does not have.

If a push onto an open pull request would not fast-forward — someone pushed
while the job ran — it gives up for that cycle with a warning rather than
forcing. The next run recomputes the same drift. A push that fails while the
branch has NOT moved is a different thing (a permission or branch-protection
problem), and fails the job loudly instead: a green daily run that lands
nothing, forever, is the failure mode worth being noisy about.

## A green pull request

Merge it. Properties were added and nothing else.

From the merge on, a template using one of those properties routes through
Cloud Control instead of being dropped. Before it, the same template got a
deploy-time warning — the value was never silently lost, but it did not work
either.

Newly unaccounted **writable** properties are listed in the pull request. They
reach the standing backfill issue when this PR MERGES, not when the job runs —
`backfill-umbrella-sync.yml` regenerates that checklist from `main`. Wiring
them into an SDK provider is separate, unhurried work.

**Writable** matters here: a schema property AWS computes and returns
(`readOnlyProperties` — an `Arn`, a `DomainName`) can never be a dropped value,
because there was nothing to send. Only settable properties represent work. In
a typical cycle most additions are read-only.

## How a decision reaches you

A refresh PR that needs one is **assigned to you, labelled `needs-decision`,
titled with the count, and opened by a one-line verdict at the top of its
body**. Of those, only the assignment sends a notification — it is applied
first for that reason — while the label and the title suffix are what the PR
list can still tell you afterwards, including that a PR was settled. The
verdict line is rewritten every cycle, so it does not age the way the rest of
the body does.

GitHub holds CI on a bot-created pull request at `action_required` until a
maintainer approves the workflows, so a decision-carrying PR does not
necessarily show a red check — before this marking existed it was
indistinguishable, in every list view, from a refresh that needed nothing.

The marking is **cleared by the next run** once you have committed the
classifications: the job recomputes the count while the PR is open, even on a
day AWS changed nothing, then drops the label, restores the plain title and
rewrites the verdict line. The **assignee stays** — the PR is still yours to
merge, and un-assigning it would drop it out of your assigned view at the
moment it became mergeable. So a standing `needs-decision` means work is
genuinely outstanding, not that nobody tidied up.

On a cycle that publishes nothing, the count can only CLEAR the marking — it
never changes a non-zero one in either direction. Removals are computed by
diffing against the branch's committed fixtures, so with nothing to refresh
that half of the count is empty by construction and a "2 decisions needed" PR
would otherwise be retitled "1" with nothing settled.
The same run also refuses to clear when regenerating produces changes the
branch has not committed — otherwise fixing a provider without running
`vp run gen:all-matrices` would clear the label while the PR's own CI stayed
red.

If the label is missing entirely and the run log says it could not add it,
create it once — `gh label create needs-decision` — and re-run. The job
deliberately does not create labels, so that deleting one stays a decision.

## A red pull request

Red is the hand-off, not a defect. The pull request names which class fired, on
which type, which provider lines mention it, and what the AWS SDK still models —
so the research is already done and what is left is the decision.

Two of them need a judgement and have their own sections below: a **removed or
renamed property**, and a **nested-key divergence**.

The rest are CI checks that read the schema fixtures, and the pull request gives
each one that failed its own section with the commands to settle it — so this
page does not enumerate them. What they have in common is worth knowing: a plain
schema **addition** reaches every one, which is the shape easiest to wave
through.

| Check | What an addition did |
| --- | --- |
| `property-coverage` | AWS re-added a property a provider had written off with a `bogusTolerated` rationale, so the rationale is now false |
| `audit:sdk-attr-coverage:check` | A new read-only `*Arn` / `*Url` on a type that had none, which a cross-resource `Fn::GetAtt` cannot resolve |
| `audit:enrichment-coverage:check` | A new computed attribute on a Cloud-Control type that nothing populates on read |
| `fixture-consumer-tests` | A unit test asserting something about a specific type's schema no longer matches the capture |

A fourth section, **"Fixtures this report could not read"**, means the
comparison itself failed for those types — neither their removals nor their
additions are accounted for anywhere in the pull request, so read the refresh
job's log.

### A property was removed or renamed

A provider still declares a property AWS no longer publishes.

| Option | Meaning | Choose it when |
| --- | --- | --- |
| Delete the declaration | cdkd stops sending the property | AWS dropped it from the API too |
| Add a `bogusTolerated` rationale | cdkd keeps sending it | The API still accepts it, or the name is SDK-only |

**Removal from the schema does not mean the API rejects it.** The schema is a
published model; the API is the behaviour.

**Most of these never reach you.** The job settles a removal itself when two
facts hold together — the type's own AWS SDK client still declares a member of
that name, and the provider actually wires the property rather than only listing
it — and it writes the tolerance with those facts as the reason. Both are read
from the checkout, and where both hold, "keep sending it" is the only answer
either one permits.

A removal reaches this section when one of them fails, or when the same refresh
added a name that could be the same field renamed. The pull request says which.

| What the PR says | What to do |
| --- | --- |
| Possible **rename** | Confirm it, then repoint the declaration at the new name. The SDK keeps the old name either way, so no evidence settles this. |
| The SDK **no longer declares** the name | Delete the declaration *and its wiring* from the provider. This is a behaviour change, which is why it is yours. |
| The job **could not find wiring** | Look before deleting. The evidence only sees a template read spelled `properties['X']`; table-driven wiring — a shorthand key in a lookup map, indexed by a loop variable — is invisible to it, and `AWS::SQS::Queue`'s `DelaySeconds` is delivered that way. Absence of evidence here is not evidence of absence. |

The rename test is deliberately narrow — it flags an addition whose spelling
extends or is extended by the removed name, so a rename that changes the middle
of a name is not flagged, and the absence of a flag is not evidence there was no
rename.

```bash
# After editing, this names anything still bogus — and any tolerance AWS has
# since made stale by re-adding the property.
vp test run property-coverage
```

**`aws cloudformation describe-type` is corroboration, not the authority.** A
removal here is about an SDK Provider's declaration, and cdkd's SDK Providers
call service APIs directly — the CFn type registry is the API being served only
for Cloud Control-routed types. It also adds no independent information: the
public bundle this job already read was measured byte-identical to the
authenticated capture on every type probed.

### A nested key diverged

A `NESTED_KEY_TARGETS` type gained a nested key whose spelling does not match
the AWS SDK model. The check reports divergences, not staleness, so
regenerating never clears one.

| Option | Meaning | Choose it when |
| --- | --- | --- |
| Fix the provider | cdkd starts sending the key | The SDK models it under a different spelling |
| Add a `NESTED_KEY_ALLOW_LIST` entry | cdkd never sends it | The SDK genuinely has no such member |

A `case-divergence` needs no judgement: the SDK models the key under a
different capitalisation, so rename it in the provider.

For `no-sdk-member` / `definition-member-missing`, rule out the installed SDK
simply lagging the service before allow-listing anything — an entry added over
a stale SDK hides a real dropped value:

```bash
# What is installed, versus what npm publishes today.
node -p "require('@aws-sdk/client-<service>/package.json').version"
npm view @aws-sdk/client-<service> version

# If a newer one exists, bump it and re-check before deciding.
vp run audit:nested-key-coverage:check
```

Only when the SDK is current and still lacks the member — and the service's own
API reference agrees — add a `NESTED_KEY_ALLOW_LIST` entry with a reason.

### Why this is not decided for you

Most of the work is done for you. AWS publishes a third description of each
service — the SDK — and the job consults it, so the pull request already says
whether a removed property is still modelled there — searched case-insensitively
across every client the provider imports, because SDK and CFn capitalisation
routinely differ. That is the evidence the decision turns on, and it usually
settles the question.

For a nested-key divergence it also reports whether the installed client is
behind npm. If it is current, the "the SDK just lags" reading is eliminated
outright. If it is behind, that reading is live — but whether a bump actually
fixes the divergence is an interface-level question a name lookup cannot answer,
so re-run the check after bumping rather than assuming.

What is left is genuinely undecidable from the repository:

- A **rename looks exactly like a removal** at the name level, which is why
  this repository carries hand-maintained rename maps at all.
- `no-sdk-member` means the **installed** SDK version lacks the member. That
  can be the SDK lagging the service rather than the service lacking it.
- Adding an allow-list entry is a promise that cdkd will never send the value.
  That is a policy choice, not a lookup.

The asymmetry matters more than the ambiguity: the silencing option
(`bogusTolerated`, `NESTED_KEY_ALLOW_LIST`) is always available and always
turns CI green. Anything choosing automatically under uncertainty converges on
it, and that quietly disables the checks that exist to catch dropped values.

## Running it by hand

```bash
# Pull a refresh forward, or check what AWS has changed. No credentials needed.
vp run gen:cfn-schemas-from-zip

# One type, through the authenticated path. Required for types the public
# bundle does not carry.
node scripts/refresh-cfn-schemas.mjs 'AWS::Service::Type'

# See what changed, then let the coverage test name what is unaccounted.
git diff tests/fixtures/cfn-schemas/
vp test run property-coverage
```

Trigger the scheduled job without waiting for the next day from the repository's
Actions tab, or with `gh workflow run cfn-schema-refresh.yml`.

## Branch names are reserved

The open-pull-request guard matches on the branch prefix
`bot/cfn-schema-refresh/` in this repository. A pull request of your own from a
branch under that prefix reads as the open refresh PR, and the job will push its
drift onto your branch. Fork PRs are excluded, so this only applies to branches
here.

## Related

- [Provider Rules](provider-rules.md) — why the job is shaped this way, and the `bogusTolerated` conventions
- [Provider Development](provider-development.md) — adding a provider, including its first fixture capture
- [State Management](state-management.md) — what a routing change does to an existing resource's state record
