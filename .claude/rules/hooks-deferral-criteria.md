---
description: cdkd issue-deferral-criteria-gate - what a PR-SHAPED deferral reason is, which body CHANNELS the gate reads, and the measured numbers behind both
paths:
  - '.claude/hooks/issue-deferral-criteria-gate.sh'
  - '.claude/hooks/issue-deferral-criteria-gate.test.sh'
---

# `issue-deferral-criteria-gate.sh`

Split out of [hooks.md](hooks.md) when that file crossed its per-file byte cap.
The `paths:` glob above is as narrow as the content: this loads only when the
gate or its suite is being worked on, which is the only time the per-channel
precedence and the mutation tallies below are worth their tokens.

- **`.claude/hooks/issue-deferral-criteria-gate.sh`** blocks `gh issue create`
  (and the `gh api repos/<o>/<r>/issues` mint) when the body's
  `Session-fit: next` line defers the work for a PR-SHAPED reason — `own PR`,
  `separate PR`, `shar(e|ing) a PR`, `(independent|separate) review surface`,
  `unreviewable`, `own review`, case-insensitively. **An ESCALATION, not a new
  rule**: `Session-fit` decides whether the work is finished in THIS session
  and none of its criteria is about the pull request — splitting across
  several PRs is normal and costs no session. Written down three times
  (`/work-issues` §3-b, §5-f, [session-report.md](session-report.md)) and on
  2026-09-04 an agent deferred THREE findings on that reasoning anyway
  (go-to-k/cdkd#2587 / #2588 / #2590), all later re-classified `now` and
  finished in the same session. Retro §10-b: a rule violated anyway escalates
  to a MECHANISM.
  **Not a ritual** — an earlier design asked for a "criteria audit" line,
  which boilerplate satisfies; this refuses the specific defect and leaves
  every legitimate `next` (a NEW fixture, external input, an independent
  subsystem) untouched. **Only `next` is gated**: a `now` line is never
  refused, and a body with no `Session-fit` line passes — filing hygiene
  belongs to the sibling issue gates. `gh issue edit` / `comment` are NOT
  gated: re-classification is the outcome this gate steers toward. The reason is read across WRAPPED lines (a 76-column body
  puts "needs its own PR" on the next line), bounded by a blank line, a
  heading, a list item, or the next NAMED field (`Session-fit` / `Severity` /
  `Effort` / `Estimate` / `Notes` / `Dup-check`) — mutation-probed, that
  boundary is what keeps a sibling `Notes:` line out of the reason. The named
  set is a deliberate TRADE, not an oversight: it also folds every OTHER field
  line (`Note:` singular, `Repro:`) into the reason, which the sibling ports
  avoid by taking any `word:` with a `://` carve-out — at the cost of missing
  a reason that wraps over a non-field colon line, which this repo pins in
  both directions, and the
  bullet case is what stopped a legitimate reason followed by a PR-mentioning
  bullet from folding it in. A FENCED CODE BLOCK is stripped first (``` and
  `~~~`), so a body quoting the refused line to argue ABOUT the rule is not
  blocked by its own quotation — the first `Session-fit:` match wins, and
  without the strip a quoted line beat the body's real `now`. Bold is accepted
  on the KEY and on the VALUE alike. Repo opt-in (`.markgate.yml`), shared
  command-position matcher, fails CLOSED when the library is unloadable.
  **It reads the body the command is about to WRITE**, porting
  `gh-body-english-gate`'s #2397 heredoc extraction: precedence is the heredoc
  body this command writes, then the file on disk (unless a TRUNCATING write
  superseded it — an APPEND still reads it), then a fallback that is the
  SEGMENT plus every OTHER segment that WRITES the body path — never the whole
  command, which refuses a filing whose sibling `git commit -m` message merely
  QUOTES a PR-shaped line, and not the segment alone, which loses a
  `printf … > b.md` writer — then an inline
  `--body` / `-b`, then `.body` out of a `gh api --input` JSON payload. The
  last two channels and the writer-aware split are #2707: `-b` and `--input`
  were read by nothing (rc=0 on a PR-shaped `next`), and a `$cmd`-always
  fallback REFUSED a filing whose sibling `git commit -m` message merely
  QUOTED such a line. An inline body is also newline-RESTORED before scanning
  — `gate_segments` emits one line per segment, so a multi-line `--body`
  arrived flattened and every reason terminator became unreachable, refusing a
  legitimate `next` whose `Effort:` line quotes
  [session-report.md](session-report.md)'s own "needing its own PR plus
  review" wording. The restore is a LOOKUP against this segment's
  own bytes, keyed on the extracted value collapsing back byte-for-byte. The
  slice is exact rather than approximate: the segmenter rewrites a newline to
  a SPACE and leaves every other byte alone, so collapsing the whole command
  the same way gives a string of identical length in which the segment appears
  verbatim, and its offset there is its offset in the raw command. Scoping is
  load-bearing — an unscoped table let a sibling `gh issue comment --body`
  decide the create's verdict — and restoration is ACCURACY rather than a
  safety direction: added line structure can also expose a later
  `Session-fit:` the flat line hid, because `scan_text` reads the first match
  per line. Without that the one-call shape was a FAIL-OPEN whenever
  the target path already existed: the gate judged the PREVIOUS body and
  passed (measured — stale file present rc=0, file absent rc=2). Unlike
  `issue-dup-check-gate`, an UNREADABLE `--body-file` still does not block:
  this gate objects to content it FINDS, so a refusal would be unclearable.
  **What it catches** — state the PREDICATE or the number is unreproducible,
  and the `--limit 300` window MOVES (255 → 259 in one day, 66 → 65 fires in
  another). Latest reading: of 300 bodies, 259 carry an anchored
  `Session-fit: next` FIELD LINE and it fires on **65** (25%), every hit on a
  literal vocabulary term. It does NOT catch reasoning that never names a PR:
  of its own three motivating deferrals it fires on go-to-k/cdkd#2590 but not
  #2587 ("its own real-AWS run and review round") or #2588 ("its own blast
  radius across future PRs"). The needle was deliberately NOT widened to chase
  those (implement.md: three spellings in three rounds means change
  instrument) — [session-report.md](session-report.md) no longer OFFERS a
  PR-shaped `next` criterion to cite. Bypass
  `CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1`, from the env or a leading assignment
  in the command text (#2368), for an INLINE quote of PR-shaped reasoning.
  Smoke test: `issue-deferral-criteria-gate.test.sh` (129 cases, bash 5.x and
  3.2.57). Re-probed wholesale on the 129-case suite: `exit 0` stub 70,
  `exit 2` stub 60, `$GW` reverted 47, short-flag 3, prelude guard 1. Per-fence tallies (the boundary, the
  six `key_re` field names, segment scoping, the fence strip, the heredoc
  arms) live in the suite header, which is re-measured wholesale each round.
  
  `(independent|separate)` → `independent` 1. **Three silent passes closed**:
  a BOLDED `next` VALUE (the key accepted `[*_]*`, the value did not);
  `separate review surface`, which cdk-local's port already refused while cdkd
  passed it; and a reason WRAPPING onto a line that merely contains a colon
  (`entirely:` ended the continuation) — the boundary now pins the NAMED
  fields. All three are LATENT: pre-fix and post-fix fire on the IDENTICAL 65
  of the 259, 0 corpus instances of any shape. No drift. The fence STRIP
  needed a second round: latching on any opener with no look-ahead made an
  UNCLOSED fence blank the rest of the body (rc=0 where the pre-strip hook
  said 2) — the heredoc latch class one construct over; it now opens only when
  the SAME marker recurs later.

**How a gate reads a flag VALUE out of raw command text** — the shared
`GATE_PERL_WORD` shell-word prelude, the SIX families the
`(["\x27]?)([^"\x27\s]+)\1` spelling lost with the measured rc for each, and
the shell-word grammar — lives in `.claude/hooks/lib/command-match.sh` BESIDE
the constant, because that is the file a change to it edits. Derive the
consumer list with `grep -l GATE_PERL_WORD .claude/hooks/*-gate.sh` rather
than trusting a count in prose;
`tests/unit/scripts/gate-perl-word-consumers.test.ts` fences it and the
library header against the tree.


Also converted: the redirect-target matchers, which compared RAW command text
against an already-unquoted path, so a heredoc writing `> /a\ b/x.md` was
invisible and the gate read the STALE file on disk. `issue-dup-check-gate` was
ACCIDENTALLY safe (no path extracted means it BLOCKS), so its miss was a FALSE
BLOCK; fixed anyway — that safety is a polarity a later edit could reverse.

**A non-empty test is only HALF the guard.** A prelude that is present and
does NOT COMPILE is just as silent as a missing one, because every extraction
runs `perl … 2>/dev/null` — measured, one broken literal disarmed four gates at
once with zero stderr. So each gate also calls `gate_perl_word_or_die <name> ||
exit 2`: a functional probe, once, AFTER arming and at **TOP LEVEL** — the
extraction helpers run inside `$( )`, where `exit 2` ends only the substitution
subshell, so an in-function guard PRINTED its refusal and the hook still
returned 0. Fenced by `tests/unit/scripts/gate-perl-word-consumers.test.ts`,
which also pins the consumer COUNT against the library header — that sentence
said "three gates" while five files consumed the constant.

Every one produces an actionable error message naming the exact replacement
command.
