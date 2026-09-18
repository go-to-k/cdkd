---
description: cdkd shared matcher - the heredoc latch inside an open $( ), its three load-bearing properties and the two heredoc paths' deliberate asymmetry
paths:
  - '.claude/hooks/lib/command-match.sh'
  - '.claude/hooks/lib/command-match.test.sh'
  - '.claude/hooks/lib/command-match-mutants.sh'
  - '.claude/hooks/lib/command-match-differential.test.sh'
---

# The heredoc latch inside an open `$( )`

Split out of [hooks.md](hooks.md) when the go-to-k/cdkd#3040 rounds took the
`.claude/hooks/main-tree-edit-gate.sh` payload 1 B past its 95,000 B cap — the
same split as [hooks-class-fences.md](hooks-class-fences.md) and its siblings.
The subject is the SHARED MATCHER, not that gate: the gate consumes
`gate_segments_marked` and never reads a heredoc delimiter itself, so this
file's `paths:` glob is the four matcher files alone. hooks.md keeps a
one-line pointer beside the `$( )`-heredoc entry it belongs to.

**Three things about that latch are load-bearing, each measured against shapes
bash executes and origin/main matched**: the opener scan reads the PHYSICAL
line, never the joined `$(` text — the join re-finds a closed opener and a
later bare delimiter swallows what is between; the scan is QUOTE-AWARE with a
per-depth STACK — `$(` and a bare `(` push the quote state, the matching `)`
restores it, a backtick frame is skipped TEXTUALLY to the next unescaped
backtick (no quote read inside one), `${…}` / `$((…))` / a `#` comment (after
an unescaped space, or a `)` closing a BARE `( )`, in the opener scan and in
`subst_open` — `$(x)#`, `\)#` and, since code review round 30, `a=(x)#` are
glue, the last one because a paren OUTSIDE every substitution has a kind too
and `subst_open` tracked none) are skipped whole — and it BAILS to "no
opener" on any line it cannot read to the end: an unbalanced quote, a new `$(`
or backtick open after it, or — sticky to the close — the opener's OWN frame
closing on that line (`y=$(cat <<'EOF') ; z=$(` — shells disagree there, as
for an `a=( )` frame's `)#`), an unterminated `$((` / `${`, or either span
holding a quote, backtick or backslash; so `'<<X'` mention plus a bare `X`
later is prose; and the latch is **QUOTED-DELIMITER ONLY** — the delimiter
being the whole WORD after quote removal (`heredoc_word`'s header has all six
shapes), in this arm and the top-level one, which latches an unquoted word
only when a whole identifier (`origin/main` latched a PREFIX — a decoy) and
skips a `<<` in a `#` comment, reachable only once the word was read properly
— and an unquoted or unreadable opener anywhere in it is a bail, sticky to its
close: `cat <<A <<'B'` expands the A body first, so recording only B dropped a
verb. That lexer state CARRIES across the physical lines of one `$( )` and
resets when it closes. A body line starting with the delimiter and carrying a
`)` ends the latch (bash 5 and 3.2 close there); bash 3.2 alone closes on ANY
`)` in a body — not modelled, and uniformly unmatched here where `origin/main`
matched part of that class by accident. A `<<EOF` body is expanded by bash, so
a substitution on a body line runs, and two rounds each measured a shape a
fall-through still dropped, so an unquoted body is read as commands, as
origin/main read it: a false refusal, never a miss. The top-level `tag` keeps
its drop-everything policy: a substitution inside an unquoted-delimiter
heredoc at TOP level is run by bash and matched by nothing, on origin/main and
here alike — a known fail-open predating this work, NOT widened by it, stated
so the two heredoc paths are not read as equivalent.

## When the two bashes read one line differently

An escaped character before a `#` INSIDE an open `$( )` is read two ways, and
it is worth stating as a shape rather than as a rule about one arm. bash 5.x
and zsh use the ordinary lexer, where `\ #` continues a word, so the `)` after
it closes the substitution; bash 3.2's `$( )` PRE-SCAN reads a comment and
swallows that `)`. **The shells that RUN the two resulting shapes are
disjoint**, so either reading leaves fail-opens the other closes — measured
through the real `main-tree-edit-gate` against a fixture repo, three shapes
are executed by 5.x and zsh and a fourth by 3.2 alone.

This walk and `close_paren` take bash 3.2's reading, which is `origin/main`'s,
so the class is unchanged by this work and go-to-k/cdkd#3303 owns it with all
four shapes' bytes. Two cheaper fixes were built and measured to open NEW
holes — glue in both machines (loses the 3.2 shape), and a flag marking the
whole logical line subshell-derived (the gate's raw-`cd` union compensation
only runs when EVERY segment is marked, and a quote opened inside the comment
region flips data and commands in a way no `cd`-context device can express).
That issue carries both measurements so the next attempt does not repeat them.

What IS recorded here is the narrow half: the glue record in this walk is for
an escaped **`)`** alone, because round 23 gave this walk a `)` comment-class
member `close_paren` does not have, and all three shells agree that a `)`
glues. `SO7` and `CP-BS2` pin that; `SO9` pins that an escaped SPACE is not
glue, and mutant `so-bs-glue-wide` is the widening it refuses.
