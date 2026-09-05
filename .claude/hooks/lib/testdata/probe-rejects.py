#!/usr/bin/env python3
"""Assert `gate_perl_word_ok` rejects a prelude with any ONE dimension removed.

Driven from `command-match.test.sh`. The guard's whole job is catching a library
that is PRESENT but does not work, and the case it is most likely to meet is a
sibling repo one revision behind -- this prelude is copied between cdkd,
cdk-local and cdk-real-drift on purpose, and a review measured a four-dimension
probe certifying exactly that stale copy: every assertion was pure ASCII at word
position 0, so neither the mid-word ANSI-C arm nor the byte-fidelity contract
was exercised.

Each mutation below deletes ONE dimension from the REAL prelude. A dimension
whose deletion still PASSES is one the probe does not actually certify, and the
case says so by name rather than as a count.

It lives in `testdata/` so neither `run-tests.sh` (which globs `lib/*.test.sh`)
nor the hook class fence picks it up as a suite of its own.
"""

import io
import os
import subprocess
import sys
import tempfile

# (name, old, new) -- each `old` must appear EXACTLY once, so a prelude edit that
# moves the anchor fails loudly here instead of silently mutating nothing.
MUTATIONS = [
    (
        "quoted span dropped from $GW",
        r'"(?:[^"\\]|\\.)*"|',
        "",
    ),
    (
        "backslash arm dropped from $GW",
        r"|\\.|[^\s",
        r"|[^\s",
    ),
    (
        "ANSI-C arm dropped from $GW",
        r"(?:\$\x27(?:[^\x27\\]|\\.)*\x27|",
        "(?:",
    ),
    (
        "metachar stop widened",
        r'[^\s"\x27;|&()<>\x60]',
        r'[^\s"\x27]',
    ),
    (
        "bare-run arm eats the $ sigil (mid-word ANSI-C)",
        r'((?:[^"\x27\\\$]|\$(?!\x27))+)',
        r'([^"\x27\\]+)',
    ),
    (
        "single-quote span dropped from $GW",
        r"|\x27[^\x27]*\x27|",
        "|",
    ),
    (
        "gate_unq decodes instead of returning bytes",
        "{ $o .= gate_ansi_c($1);",
        "{ $o .= gate_utf8_lenient(gate_ansi_c($1));",
    ),
]


def probe(lib_text: str) -> bool:
    """True when `gate_perl_word_ok` accepts this library text."""
    with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False, encoding="utf-8") as fh:
        fh.write(lib_text)
        path = fh.name
    try:
        r = subprocess.run(
            ["bash", "-c", '. "$1"; gate_perl_word_ok', "_", path],
            capture_output=True,
        )
        return r.returncode == 0
    finally:
        os.unlink(path)


def main() -> int:
    lib = sys.argv[1]
    text = io.open(lib, encoding="utf-8").read()

    # The control comes first and is not optional: if the real prelude were
    # rejected, every mutation below would "pass" for the wrong reason and the
    # whole block would read as six clean assertions.
    if not probe(text):
        print("FAIL probe-rejects: the UNMUTATED prelude is rejected (control)")
        return 1

    bad = 0
    for name, old, new in MUTATIONS:
        n = text.count(old)
        if n != 1:
            print(f"FAIL probe-rejects: {name} (anchor appears {n} times, expected 1)")
            bad += 1
            continue
        if probe(text.replace(old, new, 1)):
            print(f"FAIL probe-rejects: {name} (the probe ACCEPTED it)")
            bad += 1
        else:
            print(f"OK   probe-rejects: {name}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
