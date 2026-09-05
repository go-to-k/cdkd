---
description: cdkd hook SOURCE-integrity guards - awk-apostrophe-gate and hook-lib-parse-detector, why a broken hook file locks the session out, and what each arm covers
paths:
  - '.claude/hooks/awk-apostrophe-gate.sh'
  - '.claude/hooks/awk-apostrophe-gate.test.sh'
  - '.claude/hooks/hook-lib-parse-detector.sh'
  - '.claude/hooks/lib/command-match.sh'
---

# Keeping the hook files parseable

Split out of [hooks.md](hooks.md), which was 122 bytes under its 80,000 B
payload cap when this entry was written — the same split as
[hooks-main-tree-edit.md](hooks-main-tree-edit.md) and
[hooks-cwd-detector.md](hooks-cwd-detector.md).

## The failure these two exist for

`.claude/hooks/lib/command-match.sh` embeds its awk program as **one
single-quoted shell word**. An apostrophe anywhere inside it closes that word
and the rest of the file is parsed as shell. The dangerous position is an awk
**comment**, where an apostrophe reads as ordinary English prose and looks
harmless — `this line's quoting`, `the body's segments`.

The consequences compound in a way no other file in this repo shares:

1. the file fails `bash -n`;
2. every gate sources it and **fails CLOSED**, which is correct — a hook that
   cannot parse the command cannot bless it;
3. `main-tree-edit-gate` matches `Edit|Write|Bash`, so **all three tools go
   away at once**;
4. the session therefore cannot repair the file it just broke. Only a
   human-typed command can, because a human shell does not pass through
   PreToolUse hooks.

**It happened three times in one sitting** (go-to-k/cdkd#2650). The second time
was after a comment reading `NO APOSTROPHE APPEARS IN THIS COMMENT` had been
added to the very function involved — a warning in prose does not survive the
next edit. The third time was with the first revision of `awk-apostrophe-gate`
already registered: the write went through a `python3` heredoc inside a Bash
call, and a gate watching only `Edit|Write` never saw it.

## The three arms

- **Edit / Write** — the gate BUILDS the post-edit content (Write's `content`,
  or Edit's `old_string` replaced by `new_string`) and runs `bash -n` on it.
  Refuses only when the file parses NOW and would not after. **This is an exact
  check, not a pattern**, so it catches every syntax break rather than the
  apostrophe class alone. The first revision was a heuristic — apostrophe in a
  comment that appeared to sit inside a single-quoted awk word — and had false
  positives immediately: a test file carrying an awk fixture inside a heredoc
  tripped it. False positives on a blocking gate are how a gate gets routed
  around, which is why it is not a sniff any more.
- **Bash** — refuses an INTERPRETER write (`python` / `perl` / `ruby` / `node`
  in an in-place or redirecting shape) aimed at `.claude/hooks/**`, and names
  Edit/Write instead. The content is inside the interpreter and cannot be
  inspected from the payload, so this arm refuses the SHAPE rather than
  guessing at the result. The in-place flag is matched by regex, not by a
  `" -i"` glob: perl takes it clustered, and `perl -pi -e ...` — the command
  that repaired the third lockout — contains no ` -i` substring.
- **PostToolUse (`hook-lib-parse-detector.sh`)** — after any Bash call whose
  text mentions the hooks directory, runs `bash -n` over every shell file
  there. Non-blocking by design; what it adds is **immediacy**. A broken
  library is otherwise silent until the next command, by which time every tool
  is refused. Reported at the moment of the write, the fix is one edit away
  instead of one human away.

## Writing prose inside the awk program

Rewrite the possessive: `this line's quoting` → `the quoting on this line`.
For a literal quote in awk CODE use the `\047` escape, as
`strip_noncommand_spans` does — not a `'"'"'` splice inside prose. The splice
is legal (it closes and reopens the word) and appears in existing comments, so
the gate does not flag it; it is simply harder to read than `\047`.

Smoke test: `awk-apostrophe-gate.test.sh` — 12 cases covering both accident
vectors, the legal splice, an apostrophe outside the awk word, a read that
merely names the path, and the scope bounds. Both accident cases were watched
going red under mutation before being trusted.
