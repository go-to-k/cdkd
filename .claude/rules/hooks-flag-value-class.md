---
description: How a cdkd gate reads a flag VALUE out of raw command text - the shared GATE_PERL_WORD shell-word prelude and its five consumers
paths:
  - '.claude/hooks/lib/command-match.sh'
  - '.claude/hooks/gh-body-english-gate.sh'
  - '.claude/hooks/issue-dup-check-gate.sh'
  - '.claude/hooks/issue-deferral-criteria-gate.sh'
  - '.claude/hooks/issue-classification-label-gate.sh'
  - '.claude/hooks/pr-body-item-number-gate.sh'
  - 'tests/unit/scripts/gate-perl-word-consumers.test.ts'
---

# Reading a flag VALUE out of raw command text

Split out of [hooks.md](hooks.md) 2026-09-06: that file is loaded WHOLE on every
`.claude/hooks/**` touch and was at its byte cap, and this content is only
wanted when the prelude or one of its consumers is under the knife.

**One value class for the FIVE gates that extract with perl (`GATE_PERL_WORD`,
2026-09-05).** The english / dup-check / deferral / classification /
pr-body-item-number gates pull a `--body-file` or `-F`
path and an inline `--body` value out of RAW command text with `perl` (a global
scan over a slurp, which `[[ =~ ]]` cannot do). All five
spelled it `(["\x27]?)([^"\x27\s]+)\1`, which ENUMERATES where a quote may sit
instead of taking one shell WORD. That lost SIX families at once, each
measured, each fail-OPEN wherever polarity allowed: a quoted path containing a
SPACE; `-f body='<text>'` (quote INSIDE the value); the glued `-F<path>` /
`-fbody=<text>`; a glued `-F<path>` on a SHORT-flag-only command, which never
even ARMED; a path followed by an unquoted `;`; and ANSI-C `$'…'`, read as
literal ASCII while bash sends the decoded bytes. The worst was the first:
english-gate rc=0 on a JAPANESE body where the plain spelling gave 2, i.e. the
English-only rule bypassable by a directory name with a space. **The
per-shape table, the measured rc for each, and the shell-word grammar live in
`lib/command-match.sh` beside the constant** — sites four and five were found
only by the sibling note the others carry, the last three only by a review
round, so the notes and the constant are the thing to keep current. Derive the
list — `grep -l GATE_PERL_WORD .claude/hooks/*-gate.sh` — rather than trusting
either count here or in the library;
`tests/unit/scripts/gate-perl-word-consumers.test.ts` fences the two against
the tree.
