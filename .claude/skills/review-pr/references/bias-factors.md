# Step 3 — bias factors

Read at step 3, after the base tier is known. Carries the up-bias and down-bias
trigger lists, the security surface list, and the measured incidents behind each.

Orchestrator: [../SKILL.md](../SKILL.md).

3. **Bias factors** from the `paths` list:

   **Up-bias triggers** (tier UP one step, clamped at 3-axis):

   - Any path matches **security / process-launch surface**:
     - `src/utils/role-arn.ts`
     - `src/utils/docker-cmd.ts`
     - `src/local/cognito-jwt.ts`
     - `src/local/authorizer-resolver.ts`
     - `src/local/authorizer-cache.ts`
     - `src/local/sigv4-verify.ts`
     - `src/local/agentcore-sigv4-sign.ts`
     - `src/local/docker-runner.ts`
     - `src/local/docker-image-builder.ts`
     - `src/local/ecr-puller.ts`
     - `src/local/ecs-secrets-resolver.ts`
     - `src/local/ecs-task-runner.ts`

     **What belongs here**: a file is listed when it (a) verifies or mints
     authn material or loads credentials, (b) resolves secret material, or
     (c) launches a process or derives the executable path one is launched
     from. Consumers of those primitives are NOT listed. Several entries are
     thin re-export shims over cdk-local — they stay listed on purpose: a
     shim edit changes WHICH implementation cdkd consumes. The list rots two
     silent ways (an entry stops existing; a live surface never gets added —
     both seen in issue #1972);
     `tests/unit/scripts/security-surface-list-sync.test.ts` fences the first
     and the three-copy sync, the second needs the (a)/(b)/(c) test re-applied
     when this area changes.

   - Any path under `src/provisioning/providers/**` (deletion-sensitive —
     `integ-destroy` scope; real-AWS regressions cost cleanup time)
   - **> 1 fix-back ROUND on the PR** ("multiple sub-agents wrote the diff").
     Count DISTINCT `fix:` SUBJECTS across the PR's commits AND every commit
     its timeline recorded as a former HEAD. `git log main..<branch>` alone is
     what a FLATTEN erases, so that spelling killed the trigger on exactly the
     PRs rewritten most — and this repo flattens by policy
     (`flatten-before-rebase-gate.sh`). go-to-k/cdkd#2638. Subjects rather than
     shas because an amend re-shas one round. Replaying both hooks over the 60
     most recently merged PRs, the resolved TIER differs on 4; exactly one of
     those, go-to-k/cdkd#2557, needs the timeline, and a merged PR's branch is
     deleted, which flatters the other three.

     `pr-review-gate.sh` takes the MAX of this and the branch's own `fix:`
     commit count, so it can resolve HIGHER than the number below; and it skips
     the query entirely once the tier can no longer change, so it can also
     report 0 where this prints more. Read this as the tier-relevant floor, not
     as the hook's internal count:

     ```bash
     gh api graphql -F owner=go-to-k -F repo=cdkd -F number=<N> -f query='
     query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){
       pullRequest(number:$number){
         commits(first:100){nodes{commit{messageHeadline}}}
         timelineItems(first:100,itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT]){nodes{
           ... on HeadRefForcePushedEvent{beforeCommit{messageHeadline} afterCommit{messageHeadline}}}}}}}' \
       | jq '[(.data.repository.pullRequest.commits.nodes[]?.commit.messageHeadline),
              (.data.repository.pullRequest.timelineItems.nodes[]?
                 | .beforeCommit.messageHeadline, .afterCommit.messageHeadline)]
             | map(select(. != null and test("^fix(\\(|:)"))) | unique | length'
     ```

     Exact paths, not `.. | .messageHeadline?`. GraphQL returns `data` and
     `errors` together with HTTP 200, and a recursive-descent read harvests
     every `messageHeadline` in the document — blocks this query did not ask
     for included — which up-biases a PR with one round. The HOOK's copy is
     fenced by the `graphql-malformed` case in `pr-review-gate.test.sh`; this
     snippet is prose, so keep the two spellings in step by hand.
   - **The code this PR edits shipped a defect in a RECENT PR.** A judgement
     trigger, not a path list: `pr-review-gate.sh` reads the diff's stats and
     paths plus the BRANCH's own commit subjects, and has no view of the edited
     file's HISTORY — so it cannot see this and may not require the marker.
     Raise the tier anyway and say why. Read the tell off the history
     step 1 gathered — 2 or more `fix:` commits among a touched file's last 3 —
     rather than from what you remember about the area. Measured on
     go-to-k/cdkd#2593: the heuristic said `inline`, while that log on
     `src/deployment/recreate-targets.ts` showed the two preceding merges were
     both data-loss-guard fixes and the nearer one (go-to-k/cdkd#2565) had
     fixed a fail-open in the very function this PR edits again. Code +
     security ran and converged on the same two untested response shapes.
     Recency is evidence about the code, the way a security path is.

   **Security add-on reviewer (additive — NOT part of the tier ladder).**
   Whenever ANY security / process-launch path matches (surface list +
   `src/provisioning/providers/**`), OR the PR is a **security fix** (secrets
   / credentials, redaction / masking / escaping, sensitive-value
   persistence, GHSA-tied) — ALSO dispatch **`pr-security-reviewer`**, in
   addition to the size tier. The size tier decides BREADTH; a security
   defect is a DEPTH concern a tiny PR can carry — the GHSA-p5qg-v9gv-hc7w
   rollback blocker was surfaced by the generic reviewer only on a second,
   prompted round; a standing security lens catches that class in round one.

   **Down-bias triggers** (tier DOWN one step, clamped at inline) — only when
   ALL paths fall in the listed buckets:

   - **Pure INERT docs**: every path matches `.gitignore`, `README.md`,
     `docs/**`, `package.json` (top-level dep bumps only), `tests/**/*.md`.
     **Agent-instruction files are deliberately NOT here** — `CLAUDE.md`,
     `.claude/rules/**`, `.claude/skills/**`, `.claude/agents/**`,
     `.claude/hooks/**`, `.claude/settings*.json`, `.markgate.yml` change how
     every future session behaves; a defect there has a wider blast radius
     than most code. (`tests/**/*.md` catches integ READMEs; it is
     deliberately NOT a blanket `**/*.md`, which re-admitted every excluded
     agent-instruction file. The hook's `DOWN_DOCS_REGEX` carries the same
     list minus `tests/**/*.md` — it reaches that shape through its
     tests-only bucket; keep the two in sync.)
   - **Test-only**: every path matches `tests/**`

   Both fire → up wins (security wins).

   **Down-bias is a statement about RISK, never about budget.** If a
   "docs-only" diff changes a rule the agent will follow, or a "test-only"
   diff changes what a checker ACCEPTS, the low-risk premise is false — do
   not down-bias, and say why.
