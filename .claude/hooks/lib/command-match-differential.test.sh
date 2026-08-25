#!/usr/bin/env bash
# command-match-differential.test.sh
#
# A DIFFERENTIAL fence for the segmenter, per /work-issues section 5.
#
# WHY THIS EXISTS. `lib/command-match.sh` is a CLASSIFIER: command text goes in,
# "which gates consider this command, and where does it resolve" comes out. Five
# review rounds on go-to-k/cdkd#2027 each ended the same way -- a hand-picked
# case chasing one spelling, which silently changed the verdict for spellings
# nobody had enumerated. Two of those rounds shipped a regression WORSE than the
# bug being fixed, and both were found by a reviewer diffing against the parent
# commit rather than by any test in this repo.
#
# So this file does not add more cases. It runs the OLD implementation and the
# NEW one over the same corpus and fails on ANY difference that is not in the
# enumerated table below. A hand-picked case can only find what its author
# thought of; a differential finds everything the corpus covers.
#
# HERMETICITY HAS TWO AXES, and this fence needed both. Vendoring the baseline
# closed the GIT axis (CI shallow-clones, so `git show <sha>` had nothing to
# read). The ENVIRONMENT axis bit next: `~/repo` resolves through $HOME, so the
# recorded cells only matched on the machine that recorded them. When extending
# the corpus, ask of every new input: does this observable depend on ANYTHING
# outside the input string -- the machine, the user, the cwd, the clock, the
# locale? Audited at the time of writing: $HOME via `gate_expand_tilde` is the
# only such read reaching an observable (the emitter passes a literal fallback
# dir, so no $PWD dependence; no clock or TZ use; locale measured to make no
# difference over this ASCII corpus). Both are pinned below.
#
# HOW IT IS BUCKETED. Each differing cell is classified by WHAT THE FUNCTION NOW
# RETURNS -- not by which input produced it. Bucketing by input is how a total
# regression ends up inside a bucket named "intended": you recognise the input,
# wave it through, and never look at the value. Every allowed cell is pinned as
# `id + observable + new value`, so a cell that flips the OTHER way, or a new
# cell on the same input, is unenumerated and fails.
#
# MAINTENANCE CONTRACT. The baseline is a VENDORED GOLDEN FILE under
# `testdata/`, pinned to a SHA rather than to `origin/main`: once this work
# merges, a ref-based baseline would compare the code to itself and report a
# clean zero-difference run forever. It is vendored rather than read with
# `git show` because CI shallow-clones and the object is not there -- the fence
# then correctly refused to run, but a fence that cannot run in CI is not a
# fence. Its sha256 is verified on every run, so a drifted copy is loud. When a
# later change intentionally alters a verdict, its cells are added to the table
# below with a reason -- that table is the changelog of behaviour changes to the
# classifier.
#
# Run from the repo root: `bash .claude/hooks/lib/command-match-differential.test.sh`.

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_LIB="$HERE/command-match.sh"

# The implementation as it stood BEFORE go-to-k/cdkd#2027 (the parent of the
# lane). An ancestor commit, so `git show` resolves it offline.
BASELINE_SHA="8e84e4e20d6b7e957683ac6d8f69e21a77f1534f"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

pass=0
fail=0
fail_log=""
ok() { pass=$((pass + 1)); printf 'OK   %s\n' "$1"; }
ng() { fail=$((fail + 1)); fail_log+="FAIL $1\n"; printf 'FAIL %s\n' "$1"; }

# The baseline is VENDORED, not read from git. `git show <sha>` failed in CI,
# which shallow-clones and therefore does not have the object: the fence refused
# to run rather than report an unearned pass -- correct, but it meant the fence
# never ran there at all. A golden file needs no history, no network and no
# clone depth, and it survives a squash or history rewrite that renumbers the
# SHA.
OLD_LIB="$HERE/testdata/command-match.baseline.sh"
BASELINE_SHA256="2af09c64246d12cc4d9dab1bf14c8cbc8d16da738ddaa012877e68a4e30f6e85"

if [ ! -r "$OLD_LIB" ] || [ ! -s "$OLD_LIB" ]; then
  # Loud, not skipped. A differential that quietly does nothing when it cannot
  # find its baseline is the same silent-no-op this file exists to prevent.
  echo "FAIL differential: cannot read baseline fixture $OLD_LIB -- fence did NOT run" >&2
  exit 1
fi

# INTEGRITY. The fixture is a snapshot of a past generation, so a drifted copy
# would silently redefine what "unchanged" means and every allowed cell below
# would be measured against the wrong thing.
sha256_of() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 | awk '{print $NF}'
  else printf 'NO-HASHER'; fi
}
marker_line=$(grep -n 'VENDORED CONTENT BEGINS' "$OLD_LIB" | head -1 | cut -d: -f1)
if [ -z "$marker_line" ]; then
  echo "FAIL differential: baseline fixture $OLD_LIB has no content marker -- fence did NOT run" >&2
  exit 1
fi
baseline_got=$(tail -n "+$((marker_line + 1))" "$OLD_LIB" | sha256_of)
if [ "$baseline_got" = "NO-HASHER" ]; then
  ng "baseline integrity: no sha256 tool available, so the fixture could NOT be verified against $BASELINE_SHA"
elif [ "$baseline_got" = "$BASELINE_SHA256" ]; then
  ok "baseline integrity: fixture body matches $BASELINE_SHA byte-for-byte"
else
  ng "baseline integrity: fixture body is $baseline_got, expected $BASELINE_SHA256 from $BASELINE_SHA -- the vendored copy has DRIFTED and every comparison below is against the wrong baseline"
fi

# ---------------------------------------------------------------- the corpus
# Base64 so newlines, both quote characters and backticks survive intact. The
# shapes come from all five review rounds PLUS families nobody had exercised:
# quoting variants, concatenated assignments, process substitution, heredocs,
# multi-line bodies, globs and degenerate inputs.
CORPUS="$TMPDIR/corpus.b64"
cat > "$CORPUS" <<'CORPUS_EOF'
Z2l0IGNvbW1pdCAtbSB4
Z2l0IHB1c2ggb3JpZ2luIEhFQUQ=
Z2l0IHN3aXRjaCAtYyBmZWF0L3g=
Z2l0IG1lcmdlIG9yaWdpbi9tYWlu
Z2l0IGNoZWNrb3V0IC0tIGYudHh0
Z2l0IHJlc3RvcmUgZi50eHQ=
Z2ggcHIgY3JlYXRlIC0tdGl0bGUgeA==
Z2ggcHIgZWRpdCAxIC0tYm9keSB4
Z2ggcHIgbWVyZ2UgMSAtLXNxdWFzaA==
Z2ggYXBpIHJlcG9zL28vci9wdWxscy8x
Z2ggaXNzdWUgY3JlYXRlIC0tdGl0bGUgeA==
Z2l0IC1DIC9hYnMvcmVwbyBjb21taXQgLW0geA==
Z2ggLUMgL2Ficy9yZXBvIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2l0IC1DIHN1YiBjb21taXQgLW0geA==
Z2ggLUMgc3ViIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2l0IC1DICIvYSBiIiBjb21taXQgLW0geA==
Z2ggLUMgIi9hIGIiIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2l0IC1DICcvYSBiJyBjb21taXQgLW0geA==
Z2ggLUMgJy9hIGInIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2l0IC1DICIkVyIgY29tbWl0IC1tIHg=
Z2ggLUMgIiRXIiBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DICRXIGNvbW1pdCAtbSB4
Z2ggLUMgJFcgcHIgbWVyZ2UgMSAtLXNxdWFzaA==
Z2l0IC1DICIke1dPUktUUkVFfSIgY29tbWl0IC1tIHg=
Z2ggLUMgIiR7V09SS1RSRUV9IiBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DICIkKGdpdCByZXYtcGFyc2UgLS1zaG93LXRvcGxldmVsKSIgY29tbWl0IC1tIHg=
Z2ggLUMgIiQoZ2l0IHJldi1wYXJzZSAtLXNob3ctdG9wbGV2ZWwpIiBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DICQoZ2l0IHJldi1wYXJzZSAtLXNob3ctdG9wbGV2ZWwpIGNvbW1pdCAtbSB4
Z2ggLUMgJChnaXQgcmV2LXBhcnNlIC0tc2hvdy10b3BsZXZlbCkgcHIgbWVyZ2UgMSAtLXNxdWFzaA==
Z2l0IC1DIGBwd2RgIGNvbW1pdCAtbSB4
Z2ggLUMgYHB3ZGAgcHIgbWVyZ2UgMSAtLXNxdWFzaA==
Z2l0IC1DIH4vcmVwbyBjb21taXQgLW0geA==
Z2ggLUMgfi9yZXBvIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2l0IC1DIC90bXAvfi94IGNvbW1pdCAtbSB4
Z2ggLUMgL3RtcC9+L3ggcHIgbWVyZ2UgMSAtLXNxdWFzaA==
Z2l0IC1DIH5ub2JvZHkvd3QgY29tbWl0IC1tIHg=
Z2ggLUMgfm5vYm9keS93dCBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DIC90bXAvd3QvKi8gY29tbWl0IC1tIHg=
Z2ggLUMgL3RtcC93dC8qLyBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DIC90bXAve2EsYn0vd3QgY29tbWl0IC1tIHg=
Z2ggLUMgL3RtcC97YSxifS93dCBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DIC90bXAvdz8vd3QgY29tbWl0IC1tIHg=
Z2ggLUMgL3RtcC93Py93dCBwciBtZXJnZSAxIC0tc3F1YXNo
Z2l0IC1DIC9vbmUgLUMgL3R3byBjb21taXQgLW0geA==
Z2l0IGNvbW1pdCAtbSAicmVwcm86IGdpdCAtQyAkVyBjb21taXQgZmFpbGVkIg==
Z2l0IC1DIC9hYnMvcmVwbyBjb21taXQgLW0gInNlZSBnaXQgLUMgJFcgY29tbWl0Ig==
Z2ggLVIgZ28tdG8tay9jZGtkIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2ggLVIgZ28tdG8tay9jZGtkIHByIGNyZWF0ZSAtLXRpdGxlIHg=
Z2ggLS1yZXBvIGdvLXRvLWsvY2RrZCBwciBtZXJnZSAxIC0tc3F1YXNo
Z2ggLS1yZXBvIGdvLXRvLWsvY2RrZCBwciBjcmVhdGUgLS10aXRsZSB4
Z2ggLS1yZXBvPWdvLXRvLWsvY2RrZCBwciBtZXJnZSAxIC0tc3F1YXNo
Z2ggLS1yZXBvPWdvLXRvLWsvY2RrZCBwciBjcmVhdGUgLS10aXRsZSB4
Z2ggLWggZ2l0aHViLmNvbSBwciBtZXJnZSAxIC0tc3F1YXNo
Z2ggLWggZ2l0aHViLmNvbSBwciBjcmVhdGUgLS10aXRsZSB4
Z2ggLS1ob3N0bmFtZSBnaXRodWIuY29tIHByIG1lcmdlIDEgLS1zcXVhc2g=
Z2ggLS1ob3N0bmFtZSBnaXRodWIuY29tIHByIGNyZWF0ZSAtLXRpdGxlIHg=
Z2ggLVIgImdvLXRvLWsvY2RrZCIgcHIgbWVyZ2UgMSAtLXNxdWFzaA==
Z2ggLVIgImdvLXRvLWsvY2RrZCIgcHIgY3JlYXRlIC0tdGl0bGUgeA==
Y2QgL2Ficy93dCAmJiBnaXQgY29tbWl0IC1tIHg=
Y2Qgc3ViICYmIGdpdCBjb21taXQgLW0geA==
Y2QgIiRXIiAmJiBnaXQgY29tbWl0IC1tIHg=
Y2QgIi9hIGIiICYmIGdpdCBjb21taXQgLW0geA==
Y2Qgfi93dCAmJiBnaXQgY29tbWl0IC1tIHg=
Y2QgL3RtcC93dC8qLyAmJiBnaXQgY29tbWl0IC1tIHg=
Y2QgIiRXIiAmJiBnaXQgLUMgL2Ficy9zaWRlIGNvbW1pdCAtbSB4
Y2QgIiRXIiAmJiBnaXQgLUMgc3ViIGNvbW1pdCAtbSB4
Y2QgIiRXIiAmJiBjZCAvYWJzL3d0ICYmIGdpdCBjb21taXQgLW0geA==
Z2l0IGNvbW1pdCAtbSB4ICYmIGNkICIkVyIgJiYgZ2l0IHB1bGw=
Y2QgL2Ficy9vbmUgJiYgY2Qgc3ViICYmIGdpdCBjb21taXQgLW0geA==
Rk9PPWJhciBnaXQgY29tbWl0IC1tIHg=
Rk9PPWJhciBnaCBwciBtZXJnZSAxIC0tc3F1YXNo
Rk9PPSJiYXIiIGdpdCBjb21taXQgLW0geA==
Rk9PPSJiYXIiIGdoIHByIG1lcmdlIDEgLS1zcXVhc2g=
Rk9PPSBnaXQgY29tbWl0IC1tIHg=
Rk9PPSBnaCBwciBtZXJnZSAxIC0tc3F1YXNo
RD0iJEhPTUUiL3d0IGdpdCBjb21taXQgLW0geA==
RD0iJEhPTUUiL3d0IGdoIHByIG1lcmdlIDEgLS1zcXVhc2g=
Rk9PPSJiYXIiYmF6IGdpdCBjb21taXQgLW0geA==
Rk9PPSJiYXIiYmF6IGdoIHByIG1lcmdlIDEgLS1zcXVhc2g=
TVNHPSJhIidiJyBnaXQgY29tbWl0IC1tIHg=
TVNHPSJhIidiJyBnaCBwciBtZXJnZSAxIC0tc3F1YXNo
QT0xIEI9MiBnaXQgY29tbWl0IC1tIHg=
QT0xIEI9MiBnaCBwciBtZXJnZSAxIC0tc3F1YXNo
TVNHPSQoZWNobyBnaXQgY29tbWl0IC1tIHgp
TVNHPSIkKGVjaG8gZ2l0IGNvbW1pdCAtbSB4KSI=
Q0RLRF9TS0lQX0NJX0dSRUVOX0dBVEU9MSBnaCBwciBtZXJnZSAxIC0tc3F1YXNo
Q0RLRF9BTExPV19ESVJUWV9SRVNUT1JFPTEgZ2l0IGNoZWNrb3V0IC0tIGYudHh0
R0hfUEFHRVI9Y2F0IGdoIHByIGVkaXQgMTIzIC0tYm9keSB4
b3V0PSQoZ2l0IGNvbW1pdCAtbSB4KQ==
ZWNobyAiJChnaXQgY29tbWl0IC1tIHgpIg==
ZWNobyAkKGdpdCBjb21taXQgLW0geCk=
KGdpdCBjb21taXQgLW0geCk=
ZGlmZiA8KGdpdCBjb21taXQgLW0geCkgZg==
b3V0PSQoZWNobyAkKGdpdCBjb21taXQgLW0geCkp
b3V0PWBnaXQgY29tbWl0IC1tIHhg
Z2l0IC1DICQoCiBnaXQgcmV2LXBhcnNlIC0tc2hvdy10b3BsZXZlbCAKKSBjb21taXQgLW0geA==
Z2ggcHIgY29tbWVudCAxIC0tYm9keSAiZG9uJ3QgbWVyZ2UgeWV0IgpnaXQgY29tbWl0IC1tIHg=
ZWNobyBkb24ndDsgZ2l0IGNvbW1pdCAtbSB5
Z2ggcHIgY29tbWVudCAxIC0tYm9keSAiZG9uJ3QgbWVyZ2UgeWV0CmdpdCBjb21taXQgLW0geA==
ZWNobyBhXDsgZ2l0IGNvbW1pdCAtbSB4
Z2ggaXNzdWUgY3JlYXRlIC0tYm9keSAid2Ugc2hvdWxkIGFkZCBhIGdpdCBjb21taXQgaG9vayI=
ZWNobyAiUnVuOiBnaXQgY29tbWl0IC1tIHgi
ZWNobyAnbmV4dCBzdGVwOiBnaCBwciBtZXJnZSAtLXNxdWFzaCc=
Z2l0IGNvbW1pdC10cmVlIEhFQURee3RyZWV9IC1tIHg=
ZWNobyBoaQpnaXQgY29tbWl0IC1tIHg=
Z2ggcHIgY3JlYXRlIC0tYm9keSAibGluZTEKZ2l0IGNvbW1pdCAtbSB4CmxpbmUzIg==
Z2ggcHIgY3JlYXRlIC0tYm9keSAibGluZTEKbGluZTIiCmdpdCBjb21taXQgLW0geA==
Y2F0IDw8RU9UCmdpdCBjb21taXQgLW0geApFT1Q=
Y2F0IDw8RU9UCmdpdCBjb21taXQgLW0geA==
Z2ggaXNzdWUgY29tbWVudCAxIC0tYm9keSAid2UgcmFuOgpnaXQgLUMgJFcgY29tbWl0IC1GIGYKYW5kIGl0IGZhaWxlZCI=
Z2ggcHIgY3JlYXRlIC0tdGl0bGUgdCAtLWJvZHkgIkZpeC4KClJ1bjogZ2l0IC1DIFwiJFdcIiBjb21taXQgLUYgbXNnCgpEb25lLiI=
Z2l0IGFkZCAtQSAmJiBnaXQgY29tbWl0IC1tIHg=
Z2l0IC1DICIkVyIgYWRkIC1BICYmIGdpdCAtQyAiJFciIGNvbW1pdCAtRiAvdG1wL21zZw==
Z2l0IHB1c2ggJiYgZ2ggcHIgY3JlYXRlIC0tdGl0bGUgeA==
ZWNobyBkb25lOyBnaCBwciBtZXJnZSAx
dHJ1ZSB8IGdoIHByIG1lcmdlIDE=
aWYgZ2l0IGNvbW1pdCAtbSB4OyB0aGVuIGVjaG8gb2s7IGZp
c3VkbyBnaXQgY29tbWl0IC1tIHg=
ZWNobyBmIHwgeGFyZ3MgZ2l0IGNvbW1pdCAtbQ==
Y2FzZSBhIGluIGEpIGdpdCBjb21taXQgLW0geCA7OyBlc2Fj
dGltZW91dCAzMCBnaXQgY29tbWl0IC1tIHg=
Y2QgL3RtcC9icmFuZC1uZXcgJiYgZ2l0IGluaXQgJiYgZ2l0IGNvbW1pdCAtbSBpbml0
ICAg
Z2l0
Z2g=
Cg==
Z2l0IC1DIC9hYnMvcmVwbw==
Z2l0IC1jIHVzZXIubmFtZT0iSmFuZSBEb2UiIGNvbW1pdCAtbSB4
Z2l0IC1jIHVzZXIubmFtZT0nSmFuZSBEb2UnIGNvbW1pdCAtbSB4
Z2l0IC0tYXV0aG9yPSJKYW5lIERvZSIgY29tbWl0IC1tIHg=
Z2l0IC1jIGNvcmUuZWRpdG9yPSJ2aW0gLWYiIGNvbW1pdCAtbSB4
Z2l0IC1jIHVzZXIubmFtZT0iSmFuZSBEb2UiIHN0YXR1cw==
Z2l0IC1jIGs9ImFcIiBiIiBjb21taXQgLW0geA==
Z2ggLS1yZXBvICJnbyB0by9rIiBwciBtZXJnZSAx
Z2l0IC1jIHVzZXIubmFtZT0iSmFuZSBEb2UiIC1DIC9hYnMvcmVwbyBjb21taXQgLW0geA==
Z2l0IGNoZWNrb3V0IG1haW4gJiYgZ2l0IGNoZWNrb3V0IC0tIGYudHh0
Z2l0IGNoZWNrb3V0IC1iIHdpcCAmJiBnaXQgcmVzdG9yZSAtLSBmLnR4dA==
Z2l0IC1jIHVzZXIubmFtZT1PXCJCcmllbiBjb21taXQgLW0geA==
Z2l0IC1jIGFsaWFzLng9InJ1biBjb21taXQgbGF0ZXIiIHN0YXR1cw==
Z2l0IC1jIGZvbz0ieCBjb21taXQgLW0geSIgc3RhdHVz
Z2l0IC1DIC90bXAvb1wibmVpbGwvcmVwbyBjb21taXQgLW0geA==
Z2l0IC1jIGs9YVwiYiBjaGVja291dCAtLSBmLnR4dA==
CORPUS_EOF

# --------------------------------------------------------------- observables
# The two things a gate actually consumes -- does each guarded verb match, and
# where does the command resolve -- plus the segment count for the invariant.
cat > "$TMPDIR/emit.sh" <<'EMIT_EOF'
#!/usr/bin/env bash
set -u
. "$1"
CONSTS="GATE_RE_GIT_COMMIT GATE_RE_GIT_PUSH GATE_RE_GIT_COMMIT_OR_PUSH GATE_RE_GIT_MERGE GATE_RE_GIT_SWITCH GATE_RE_GIT_CHECKOUT_RESTORE GATE_RE_GH_PR_CREATE GATE_RE_GH_PR_EDIT GATE_RE_GH_PR_MERGE GATE_RE_GH_PR_CREATE_OR_MERGE GATE_RE_GH_PR_WRITE GATE_RE_GH_LABEL_CARRIER GATE_RE_GH_API GATE_RE_GH_BODY_CARRIER"
id=0
while IFS= read -r b64; do
  [ -n "$b64" ] || continue
  id=$((id + 1))
  cmd=$(printf '%s' "$b64" | base64 -d 2>/dev/null || printf '%s' "$b64" | base64 -D)
  # `awk END{print NR}`, not `grep -c ""`: grep EXITS 1 on a count of zero, so a
  # `|| echo 0` fallback produced "00" and the zero-segment check below silently
  # stopped matching the one case it exists for.
  n=$(gate_segments "$cmd" | awk 'END{print NR}')
  printf '%s\tsegcount\t%s\n' "$id" "$n"
  for c in $CONSTS; do
    eval "re=\${$c}"
    if gate_matches "$cmd" "$re" 2>/dev/null; then m=1; else m=0; fi
    printf '%s\tm:%s\t%s\n' "$id" "$c" "$m"
    t=$(gate_target_dir "$cmd" "/BASE" "$re" 2>/dev/null || echo "<err>")
    # A resolved target can itself contain a newline or tab; keep one row per
    # observable or the two tables stop aligning and every later row reads as a
    # difference.
    t=$(printf '%s' "$t" | tr '\n\t' '~~')
    printf '%s\tt:%s\t%s\n' "$id" "$c" "$t"
  done
done < "$2"
EMIT_EOF

# ENVIRONMENT PINNING. `gate_expand_tilde` reads $HOME, so `git -C ~/repo …`
# resolved to a machine-specific path and the recorded cells only matched on the
# machine that recorded them -- CI failed with `/Users/runner/repo` against a
# table that said the recorder's own home path. Vendoring the baseline made this fence
# hermetic with respect to GIT; this is the same class of dependency on a
# different axis, the ENVIRONMENT.
#
# Pinned rather than normalized on purpose: normalizing means a transformation
# layer sitting between the implementations and the assertions, which is exactly
# where a fence can go green-but-inert. Pinning removes the variable instead of
# rewriting its value, and it makes the `~` case assert an exact known result.
# Removing the pin is self-detecting: every cell below would resolve under the
# real $HOME and fail as an undeclared change.
#
# LC_ALL is pinned as insurance, not from a measurement -- C and en_US.UTF-8
# were verified to produce byte-identical tables over this corpus, which is
# ASCII-only. It matters if someone adds a non-ASCII input later.
FENCE_HOME="/fence/home"
HOME="$FENCE_HOME" LC_ALL=C bash "$TMPDIR/emit.sh" "$OLD_LIB" "$CORPUS" > "$TMPDIR/old.tsv" 2>/dev/null
HOME="$FENCE_HOME" LC_ALL=C bash "$TMPDIR/emit.sh" "$NEW_LIB" "$CORPUS" > "$TMPDIR/new.tsv" 2>/dev/null

old_rows=$(wc -l < "$TMPDIR/old.tsv" | tr -d ' ')
new_rows=$(wc -l < "$TMPDIR/new.tsv" | tr -d ' ')
corpus_n=$(grep -c . "$CORPUS" | tr -d ' ')

# FLOOR on the corpus itself. Everything below is vacuous if the tables are
# empty or misaligned, and an empty diff would then read as "no differences".
if [ "$corpus_n" -ge 100 ] && [ "$old_rows" -eq "$new_rows" ] && [ "$old_rows" -gt 3000 ]; then
  ok "corpus: $corpus_n inputs, $old_rows observable rows per side, tables aligned"
else
  ng "corpus: $corpus_n inputs, old=$old_rows new=$new_rows rows -- misaligned or too small; every assertion below is vacuous"
fi

if diff <(cut -f1,2 "$TMPDIR/old.tsv") <(cut -f1,2 "$TMPDIR/new.tsv") >/dev/null 2>&1; then
  ok "tables address the same (input, observable) cells on both sides"
else
  ng "tables do not address the same cells -- the comparison below is meaningless"
fi

# ------------------------------------------------- the enumerated intended set
ALLOWED="$TMPDIR/allowed.tsv"
cat > "$ALLOWED" <<'ALLOWED_EOF'
26	segcount	2	SEGCOUNT	git -C subst-quoted commit
27	segcount	2	SEGCOUNT	gh -C subst-quoted pr merge
28	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	git -C subst-bare commit
28	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	git -C subst-bare commit
29	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh -C subst-bare pr merge
29	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -C subst-bare pr merge
29	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -C subst-bare pr merge
30	segcount	2	SEGCOUNT	git -C backtick commit
30	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	git -C backtick commit
30	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	git -C backtick commit
31	segcount	2	SEGCOUNT	gh -C backtick pr merge
31	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh -C backtick pr merge
31	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -C backtick pr merge
31	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -C backtick pr merge
32	t:GATE_RE_GIT_COMMIT	/fence/home/repo	TARGET	git -C tilde commit
32	t:GATE_RE_GIT_COMMIT_OR_PUSH	/fence/home/repo	TARGET	git -C tilde commit
33	t:GATE_RE_GH_PR_MERGE	/fence/home/repo	TARGET	gh -C tilde pr merge
33	t:GATE_RE_GH_PR_CREATE_OR_MERGE	/fence/home/repo	TARGET	gh -C tilde pr merge
33	t:GATE_RE_GH_PR_WRITE	/fence/home/repo	TARGET	gh -C tilde pr merge
44	t:GATE_RE_GIT_COMMIT	/two	TARGET	git -C twice
44	t:GATE_RE_GIT_COMMIT_OR_PUSH	/two	TARGET	git -C twice
46	t:GATE_RE_GIT_COMMIT	/abs/repo	TARGET	-C real plus mention
46	t:GATE_RE_GIT_COMMIT_OR_PUSH	/abs/repo	TARGET	-C real plus mention
47	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh -R go-to-k/cdkd pr merge
47	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R go-to-k/cdkd pr merge
47	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R go-to-k/cdkd pr merge
48	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh -R go-to-k/cdkd pr create
48	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R go-to-k/cdkd pr create
48	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R go-to-k/cdkd pr create
48	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh -R go-to-k/cdkd pr create
48	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R go-to-k/cdkd pr create
49	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh --repo go-to-k/cdkd pr merge
49	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --repo go-to-k/cdkd pr merge
49	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --repo go-to-k/cdkd pr merge
50	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh --repo go-to-k/cdkd pr create
50	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --repo go-to-k/cdkd pr create
50	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --repo go-to-k/cdkd pr create
50	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh --repo go-to-k/cdkd pr create
50	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh --repo go-to-k/cdkd pr create
51	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr merge
51	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr merge
51	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr merge
52	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr create
52	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr create
52	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr create
52	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr create
52	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh --repo=go-to-k/cdkd pr create
53	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh -h github.com pr merge
53	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -h github.com pr merge
53	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -h github.com pr merge
54	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh -h github.com pr create
54	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -h github.com pr create
54	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -h github.com pr create
54	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh -h github.com pr create
54	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -h github.com pr create
55	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh --hostname github.com pr merge
55	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --hostname github.com pr merge
55	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --hostname github.com pr merge
56	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh --hostname github.com pr create
56	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --hostname github.com pr create
56	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --hostname github.com pr create
56	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh --hostname github.com pr create
56	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh --hostname github.com pr create
57	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr merge
57	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr merge
57	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr merge
58	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr create
58	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr create
58	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr create
58	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr create
58	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R "go-to-k/cdkd" pr create
84	segcount	1	SEGCOUNT	assignment from subst
85	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	assignment from quoted subst
85	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	assignment from quoted subst
89	segcount	1	SEGCOUNT	subst assignment
90	segcount	2	SEGCOUNT	subst in echo quoted
90	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	subst in echo quoted
90	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	subst in echo quoted
94	segcount	2	SEGCOUNT	nested subst
95	segcount	1	SEGCOUNT	backtick body
106	segcount	1	SEGCOUNT	verb inside quoted body
106	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	verb inside quoted body
106	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	verb inside quoted body
107	segcount	2	SEGCOUNT	body then real command
110	segcount	1	SEGCOUNT	issue body with -C
110	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	issue body with -C
110	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	issue body with -C
111	segcount	1	SEGCOUNT	pr body multi-para
128	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	flag value with a space, double quotes
128	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	flag value with a space, double quotes
129	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	flag value with a space, single quotes
129	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	flag value with a space, single quotes
133	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	escaped quote inside a flag value
133	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	escaped quote inside a flag value
134	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh repo flag with a spaced value
134	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh repo flag with a spaced value
134	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh repo flag with a spaced value
135	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	spaced value then a real -C
135	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	spaced value then a real -C
135	t:GATE_RE_GIT_COMMIT	/abs/repo	TARGET	spaced value then a real -C resolves the target
135	t:GATE_RE_GIT_COMMIT_OR_PUSH	/abs/repo	TARGET	spaced value then a real -C resolves the target
139	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	verb inside a spaced flag value is no longer the verb
139	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	verb inside a spaced flag value is no longer the verb
140	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	verb inside a spaced flag value is no longer the verb
140	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	verb inside a spaced flag value is no longer the verb
ALLOWED_EOF

paste "$TMPDIR/old.tsv" "$TMPDIR/new.tsv" \
  | awk -F'\t' '$3 != $6 {print $1"\t"$2"\t"$6}' > "$TMPDIR/diffs.tsv"

diff_n=$(wc -l < "$TMPDIR/diffs.tsv" | tr -d ' ')

# Any differing cell not pinned in the table is a behaviour change nobody
# declared. That is the whole fence.
unexplained=""
while IFS=$'\t' read -r id obs newval; do
  [ -n "$id" ] || continue
  if ! awk -F'\t' -v i="$id" -v o="$obs" -v v="$newval" \
      '$1==i && $2==o && $3==v {found=1} END{exit(found?0:1)}' "$ALLOWED"; then
    unexplained="$unexplained\n  id=$id  $obs  now=$newval"
  fi
done < "$TMPDIR/diffs.tsv"

if [ -z "$unexplained" ]; then
  ok "differential: all $diff_n differing cells are enumerated intended changes"
else
  ng "differential: UNDECLARED behaviour change(s) vs $BASELINE_SHA:$(printf '%b' "$unexplained")"
fi

# Floors PER CLASS. A corpus that stops covering a class would otherwise report
# "no differences" and read exactly like a clean run.
for spec in "NOW_MATCH:55" "NOW_MISS:5" "TARGET:8" "SEGCOUNT:12"; do
  cls="${spec%%:*}"; floor="${spec##*:}"
  seen=$(awk -F'\t' -v c="$cls" '$4==c' "$ALLOWED" | while IFS=$'\t' read -r id obs val rest; do
    awk -F'\t' -v i="$id" -v o="$obs" -v v="$val" '$1==i && $2==o && $3==v {print}' "$TMPDIR/diffs.tsv"
  done | grep -c . | tr -d ' ')
  if [ "$seen" -ge "$floor" ]; then
    ok "class $cls: $seen intended cells still observed (floor $floor)"
  else
    ng "class $cls: only $seen cells observed, floor $floor -- the corpus stopped covering this class, so its absence is no longer evidence"
  fi
done

# ------------------------------------------------- machine independence guard
# The audit that found the $HOME dependency was done by hand, once. This makes
# it repeat itself: if any observable ever carries the INVOKING user's home
# path, something in the resolver has started reading the environment again (or
# the pin above was removed), and the tables have quietly become machine-
# specific rather than input-specific.
real_home="${HOME:-}"
if [ -n "$real_home" ] && [ "$real_home" != "$FENCE_HOME" ]; then
  leaked=$(cut -f3 "$TMPDIR/new.tsv" "$TMPDIR/old.tsv" 2>/dev/null | grep -F "$real_home" | sort -u | head -3)
  if [ -z "$leaked" ]; then
    ok "machine independence: no observable carries the invoking user's HOME ($real_home)"
  else
    ng "machine independence: observable(s) carry the invoking HOME, so this table is machine-specific: $(printf '%s' "$leaked" | tr '\n' ' ')"
  fi
else
  ok "machine independence: invoking HOME is unset or equals the pinned value; guard not applicable"
fi

# ------------------------------------------------------------- the invariant
# Not a case: a property. The segmenter must never return ZERO segments for a
# non-empty command, because zero segments means every gate considers nothing
# and all of them exit 0 at once. That is how round 4 disarmed the whole system
# with one unbalanced apostrophe in a `--body`.
zero_seg=""
while IFS=$'\t' read -r id obs val; do
  [ "$obs" = "segcount" ] || continue
  [ "$val" = "0" ] || continue
  b64=$(sed -n "${id}p" "$CORPUS")
  cmd=$(printf '%s' "$b64" | base64 -d 2>/dev/null || printf '%s' "$b64" | base64 -D)
  # An empty / whitespace-only command legitimately has no segments.
  [ -z "$(printf '%s' "$cmd" | tr -d '[:space:]')" ] && continue
  # `gh` alone: zero on BOTH sides, pre-existing, listed as a known gap.
  [ "$cmd" = "gh" ] && continue
  zero_seg="$zero_seg\n  id=$id  $(printf '%s' "$cmd" | head -1 | cut -c1-60)"
done < "$TMPDIR/new.tsv"

if [ -z "$zero_seg" ]; then
  ok "invariant: no non-empty command segments to ZERO (every gate would be disarmed at once)"
else
  ng "invariant: command(s) segment to ZERO -- every gate is disarmed for these:$(printf '%b' "$zero_seg")"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
