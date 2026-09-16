# Step 0 — is it your turn to review?

Read at step 0, before opening a round on a head you have not reviewed. It is
conditional on a query, so nothing here is needed on a run that skips the wait.

Orchestrator: [../SKILL.md](../SKILL.md).

0. **A PUSH is not a round-completion signal — a REPLY is. Check for one
   before opening a round on a head you have not reviewed.**

   Decide it from WHOSE TURN IT IS, never from a push timestamp. A round is a
   conversation turn: your comment ends yours, the author's ends theirs. Two
   push-timestamp spellings were tried and both skip the wait SILENTLY — a
   `committed` timeline event carries the COMMIT date, not the push time (and
   that is the ordinary non-force-push shape, so the error is the common
   case), and an empty `$PUSH` makes jq's `.created_at > ""` true for every
   comment ever written, which reads as "they replied". Neither errors.

   ```bash
   PR=<N>; REPO=go-to-k/cdkd
   ME=$(gh api user -q .login)
   THEM=$(gh pr view "$PR" --repo "$REPO" --json author -q .author.login)
   # All three surfaces: issue comments, review BODIES, and review-thread
   # replies. A contributor answering from "Files changed" -- GitHub's default
   # -- writes only the last two, and `issues/<N>/comments` never shows them.
   said() { # said <login> -> newest ISO timestamp, or empty
     { gh api "repos/$REPO/issues/$PR/comments" --paginate -q ".[]|select(.user.login==\"$1\")|.created_at"
       gh api "repos/$REPO/pulls/$PR/comments"  --paginate -q ".[]|select(.user.login==\"$1\")|.created_at"
       gh api "repos/$REPO/pulls/$PR/reviews"   --paginate -q ".[]|select(.user.login==\"$1\" and .submitted_at!=null)|.submitted_at"
     } | sort | tail -1
   }
   MINE=$(said "$ME"); THEIRS=$(said "$THEM")
   ```

   Then, in order — the first match wins:

   - `MINE` empty → **no round has happened**; nothing to complete. Proceed.
   - `THEIRS` newer than `MINE` → **their turn ended**. Proceed. ISO-8601 sorts
     lexically, so compare with bash's `[[ "$THEIRS" > "$MINE" ]]` — NOT
     `[ ... ]`, whose `>` is undefined for strings and which zsh rejects
     outright (`condition expected: >`, measured). In a shell you do not
     control:
     `[ "$(printf '%s\n%s\n' "$MINE" "$THEIRS" | sort | tail -1)" = "$THEIRS" ]`
     plus a `!=` guard for the equal case.
   - otherwise → **you spoke last and they have not answered**. Compute
     `now - MINE`; under ~30 minutes, WAIT. Waiting means arming a signal, not
     a bare intention: a foreground `sleep` is blocked, so start a background
     poll (or a `Monitor`) and end the turn as WAITING naming it. At ~30
     minutes or more, proceed and say which head you reviewed.

   Residual, stated rather than papered over: a contributor who replies and
   THEN pushes again reads as "their turn ended", so that push is reviewed
   immediately. That is the pre-rule behaviour, and erring toward reviewing is
   the safe direction — an unnecessary round costs a comment, a missed one
   costs the contributor a stall.

   A contributor pushes MID-round routinely — to bank work before a rebase,
   to start CI on a partial change, after a fix they know is not the whole
   round. Nothing distinguishes those from the push that finishes a round, so
   a push alone does not say "your turn": go-to-k/cdkd#2840 measured 7 pairs
   of adjacent opposite-author comments under 5 minutes across 15 PRs, the
   tightest 39 s, and the concrete cost on go-to-k/cdkd#2753 was a review
   round answering a head the author had already moved past plus a second
   comment repeating requests their reply had crossed.

   **The rule is on the REVIEWER side on purpose.** Both contributor-side
   signals proposed in that issue — mark the PR draft while responding, or
   apply a `review ok` label — were refused: nothing can enforce either, the
   label needs triage permission a fork contributor does not have (measured:
   403 on go-to-k/cdkd#2809), and both fail SILENTLY, so a contributor who
   forgets the ritual is punished by a review that never arrives and no way
   to see why. This version requires nothing of the contributor, is not
   opt-in, and applies to every contributor uniformly.

   The ~30 minute bound is measured, not picked: across this contributor's
   PRs, 41 of 43 replies landed within 30 minutes of the push they answered.

   Skip the wait outright, each condition decidable from a command rather than
   a judgement: the maintainer asked for this review in the current turn; the
   PR is yours (`[ "$ME" = "$THEM" ]`); or `MINE` is empty, which is the same
   first-branch test as above — there is no round for the push to be
   completing.

   When you do open a round, name the head sha you reviewed. That is what
   lets a crossed reply be recognised as crossed instead of re-litigated.
