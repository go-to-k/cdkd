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
Z2l0IC0tZXhlYy1wYXRoIC94IC95IGNvbW1pdCAtbSB4
Z2l0IC1jIGE9YiBqdW5ranVuayBjb21taXQgLW0geA==
Z2l0IC1jIGE9YiAtWCBleHRyYTEgZXh0cmEyIHB1c2ggb3JpZ2luIEhFQUQ=
Z2l0IC1DIC9hL2IgLWMgeD15IHogdyBtZXJnZSBvcmlnaW4vbWFpbg==
Z2l0IC1jIGE9YiBqdW5rIHN3aXRjaCAtYyBmZWF0L3g=
Z2l0IC1jIGE9YiBqdW5rIGNoZWNrb3V0IC0tIGYudHh0
Z2ggLVIgby9yIC0tanNvbmZsYWcgeCB5IHByIG1lcmdlIDQyIC0tc3F1YXNo
Z2ggLVIgby9yIC0tanNvbmZsYWcgeCB5IHByIGNyZWF0ZSAtLXRpdGxlIHg=
Z2l0IC1jIHVzZXIubmFtZT0iSmFuZSBEb2UiIGxvZyAtLWdyZXAgY29tbWl0
Z2l0IC0tbm8tcGFnZXIgLWMgYT1iIGxvZyAtLWdyZXAgcHVzaA==
Z2ggLVIgJCgKIGVjaG8gby9yCikgcHIgbWVyZ2UgNDIgLS1zcXVhc2g=
Z2l0IC1jIGE9JCgKIGVjaG8gYgopIGNvbW1pdCAtbSB4
b3V0PSQoCiBjZCAveAogZ2l0IGNvbW1pdCAtbSB5Cik=
Z2l0IC1DICQoCiBlY2hvIC9hL2IKKSBwdXNoIG9yaWdpbiBIRUFE
ZWNobyAiJCgKIGdpdCBjb21taXQgLW0geAopIg==
Z2l0IGxvZyAtLWdyZXAgY29tbWl0
Z2l0IHNob3cgLS1zdGF0IGNvbW1pdA==
Z2l0IGNvbmZpZyBhbGlhcy5jaSBjb21taXQ=
Z2l0IHN0YXR1cyAtLXBvcmNlbGFpbg==
Z2l0IHJldi1wYXJzZSAtLXNob3ctdG9wbGV2ZWw=
Z2l0IHdvcmt0cmVlIGFkZCAuY2xhdWRlL3dvcmt0cmVlcy94IC1iIHggb3JpZ2luL21haW4=
Z2l0IGJyYW5jaCAtLW1lcmdlZCBvcmlnaW4vbWFpbg==
Z2ggcHIgbGlzdCAtLXNlYXJjaCBtZXJnZQ==
Z2ggLVIgby9yIHByIGNyZWF0ZSAtYiAneCBwciBtZXJnZSB5Jw==
Z2ggLVIgby9yIHByIGNyZWF0ZSAtYiAieCBwciBtZXJnZSB5Ig==
TVNHPSQoZWNobyBnaXQgY29tbWl0IC1tIHgp
Z2l0IGRpZmYgbWFpbiAtLSBjb21taXQubWQ=
Z2l0IC1DIC90bXAvd3QgbG9nIC0tb25lbGluZSAtMw==
Z2l0IGNvbW1pdCAtbSAicmVwcm86IGdpdCAtQyAkVyBjb21taXQgZmFpbGVkIg==
Z2ggaXNzdWUgY29tbWVudCAxIC0tYm9keSAid2UgcmFuOgpnaXQgLUMgJFcgY29tbWl0IC1GIGYi
Y2QgL3RtcC9uZXdkaXIgJiYgZ2l0IGluaXQgJiYgZ2l0IGNvbW1pdCAtbSB4
Z2ggLVIgZ28tdG8tay9jZGstbG9jYWwgaXNzdWUgY29tbWVudCA0MiAtLWJvZHkgJ3dlIGNhbidcJyd0IHByIG1lcmdlIDk5IHVudGlsIENJIGlzIGdyZWVuJw==
Z2ggLVIgby9yIGlzc3VlIGNvbW1lbnQgMSAtLWJvZHk9J25leHQ6IHByIG1lcmdlIDUn
Z2ggLVIgby9yIGlzc3VlIGNvbW1lbnQgMSAtYiduZXh0OiBwciBtZXJnZSA1Jw==
Z2ggLVIgby9yIGlzc3VlIGNvbW1lbnQgMSAtLWJvZHk9JCduZXh0OiBwciBtZXJnZSA1Jw==
Z2l0IC1DIC90bXAvbyduZWlsbC9yZXBvIGNvbW1pdCAtbSB4
Z2l0IC1jIHVzZXIubmFtZT1PJ0JyaWVuIC1DIC93L3QgY29tbWl0IC1tIHg=
Z2l0IC1jIGE9YiAtQyAvdG1wL28nbmVpbGwvcmVwbyBjb21taXQgLW0geA==
Z2l0IC1jIGNvcmUucGFnZXI9J2xlc3MgLVMnIGNvbW1pdCAtbSB4
Z2ggLS10ZW1wbGF0ZSAnYSBiJyBwciBtZXJnZSA0Mg==
Z2l0IC1DIGAKIGVjaG8gL2EvYgpgIGNvbW1pdCAtbSB4
Z2ggLVIgYAogZWNobyBvL3IKYCBwciBtZXJnZSA0MiAtLXNxdWFzaA==
Z2l0IC1DIGBwd2RgIGNvbW1pdCAtbSB4
Z2l0IC1DIC93dCBjaGVja291dCAtLSBmLnR4dCAjIHVuZG8gcHJvYmUsIHRoZW4gZ2l0IGNoZWNrb3V0IG1haW4=
Z2l0IC1jIGE9YiAtQyAvd3QgY2hlY2tvdXQgLS0gZi50eHQgIyBzZWUgZ2l0IGNoZWNrb3V0IG1haW4=
Z2ggLVIgby9yIHByIG1lcmdlIDIxOTUgLS1zcXVhc2ggLS1kZWxldGUtYnJhbmNoICMgdGhlbiBnaCBwciBtZXJnZSA5
Z2ggLUMgL3JlcG8vcHIgcHIgbWVyZ2UgNDIgLS1zcXVhc2g=
Z2l0IC1DIC9yZXBvIC1jIGNvcmUucGFnZXI9J2xlc3MgLVMnIGNvbW1pdCAtbSB4
Z2l0IC1DIC9yZXBvIC1jIGNvcmUucGFnZXI9J2xlc3MgLVMnIGNoZWNrb3V0IC0tIGYudHh0
Z2l0IC1DIC9yZXBvIC0td29yay10cmVlPS9Vc2Vycy9vJ2JyaWVuL3d0IGNvbW1pdCAtbSB4
Z2ggLVIgby9yIC0tdGVtcGxhdGUgJ2EgYicgcHIgY3JlYXRlIC0tdGl0bGUgeA==
Z2ggLVIgby9yIC0tdGVtcGxhdGUgJ2EgYicgcHIgbWVyZ2UgNDI=
Z2l0IC1DIC9yZXBvIC1jIGE9J2IgYycgcHVzaCBvcmlnaW4gSEVBRA==
Z2l0IC1DIC9yZXBvIC1jIHg9eSAtLXdvcmstdHJlZT0nL2EgYicgbWVyZ2Ugb3JpZ2luL21haW4=
Z2l0IC1DIC93dCAtLXdvcmstdHJlZT0veC9vJ2JyaWVuIGNoZWNrb3V0IC0tIGYudHh0
Z2l0IC1DIC93dCAtLXdvcmstdHJlZT0veC9vJ2JyaWVuIHJlc3RvcmUgZi50eHQ=
Z2ggLVIgby9yIC0tdGVtcGxhdGU9L2EvbyduZWlsbCBwciBtZXJnZSAyMTk1IC0tc3F1YXNo
Z2l0IC1DIC93dCAtLXdvcmstdHJlZT0veC9vYnJpZW4gY2hlY2tvdXQgLS0gZi50eHQ=
Z2ggLVIgby9yIC0tdGVtcGxhdGU9L2Evb25laWxsIHByIG1lcmdlIDIxOTUgLS1zcXVhc2g=
ZWNobyAicjogYGdpdCAtQyAvYWJzL3JlcG8gY2hlY2tvdXQgLS0gZi50eHRgIg==
ZWNobyAncjogYGdpdCAtQyAvYWJzL3JlcG8gY2hlY2tvdXQgLS0gZi50eHRgJw==
Z2l0IGNvbW1pdCAtbSAiYnVpbHQgYXQgYGRhdGVgOyBzZWUgbG9nIg==
Z2ggaXNzdWUgY29tbWVudCAxIC0tYm9keSAnUnVuIGBnaXQgcHVzaGAgZmlyc3Qn
Z2l0ICJjb21taXQiIC1tIHg=
Z2l0ICdjb21taXQnIC1tIHg=
Z2l0IGMibyJtbWl0IC1tIHg=
Z2l0IFxjb21taXQgLW0geA==
Z2l0ICItQyIgL2Ficy9yZXBvIGNvbW1pdCAtbSB4
Z2l0IFwtQyAvYWJzL3JlcG8gY29tbWl0IC1tIHg=
Z2ggInByIiBtZXJnZSAxIC0tc3F1YXNo
Z2ggcHIgIm1lcmdlIiAxIC0tc3F1YXNo
Z2l0ICJjaGVja291dCIgLS0gZi50eHQ=
Z2l0IC1DIC9hYnMvcmVwbyAicmVzdG9yZSIgZi50eHQ=
ImNkIiAvYWJzL3JlcG8gJiYgZ2l0IGNvbW1pdCAtbSB4
Z2l0IC1jIHVzZXIubmFtZT14eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4eHh4IC1DIC9hYnMvcmVwbyAiY29tbWl0IiAtbSB4
Z2l0IC1DIC9hYnMvcmVwbyBsb2cgLS1ncmVwICJjb21taXQi
Z2l0IC1DIC9hYnMvcmVwbyBzaG93ICJjb21taXQi
Z2l0IC1DIC9hYnMvcmVwbyBncmVwIC1uICJjb21taXQiIC0tIHNyYw==
Z3JlcCAtbiAnPT4nIHgudHMgJiYgZ2l0IGNvbW1pdCAtbSB4
Z2ggaXNzdWUgY29tbWVudCA0MiAtLWJvZHkgIm5leHQ6IHByIG1lcmdlIDUi
Z2l0IC1jIGFsaWFzLng9InJ1biBjb21taXQgbGF0ZXIiIHN0YXR1cw==
eD0kKGVjaG8gImEpYiI7IGdpdCBjb21taXQgLW0geSkgOyBlY2hvIGhpID4gZg==
eD0kKGVjaG8gJ2EpYic7IGdpdCBjb21taXQgLW0geSkgOyBlY2hvIGhpID4gZg==
Z2l0IC1DICQoZWNobyAiL2Ficy9yZXBvKXgiKSBjb21taXQgLW0geA==
KCBnaXQgY29tbWl0IC1tIHggKSA7IGVjaG8gaGkgPiBm
KCAodHJ1ZSkgOyBnaXQgY29tbWl0IC1tIHggKSA7IGVjaG8gaGkgPiBm
ZWNobyAiYSAoYiIgJiYgZ2l0IGNvbW1pdCAtbSB4
eD0kKGVjaG8gImEpYiIpICYmIGdpdCAtQyAvYWJzL3JlcG8gY29tbWl0IC1tIHg=
ZGlmZiA8KGdpdCBjb21taXQgLW0geCkgZiA7IGVjaG8gaGkgPiBn
ZGlmZiA8KGVjaG8gaGkpIGYgOyBnaXQgY29tbWl0IC1tIHg=
KCBlY2hvICJhKWIiIDsgZ2l0IGNvbW1pdCAtbSB4ICkgOyBlY2hvIGhpID4gZw==
aWYgKGdpdCBjb21taXQgLW0geCk7IHRoZW4gdHJ1ZTsgZmk=
YmFzaCAtYyAiZ2l0IGNvbW1pdCAtbSB4IiA7IGVjaG8gaGkgPiBn
Z2l0IC1DICQoZWNobyAkJ2FcJ2InKSBjb21taXQgLW0geA==
Y2RcIC90bXAgOyBnaXQgY29tbWl0IC1tIHg=
Y2RcXCAvdG1wIDsgZ2l0IGNvbW1pdCAtbSB4
Z2l0IGNvbW1pdFwgLW0geA==
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
# --- go-to-k/cdkd#2156: the TRIGGER inverted from narrow to over-approximate --
# Two classes, and they are named for the CHANGE that produced them rather than
# for the verdict, so a cell landing in the wrong one is visible:
#   WIDE_TRIGGER  a segment whose FLAG PREFIX the old grammar could not parse
#                 (a flag with two values, a bare token between flags) now
#                 matches. Every one of these is 0 -> 1: measured against
#                 origin/main over this same corpus, the change produces 40
#                 differing cells and NOT ONE of them loses a match, which is
#                 the superset property the constant's own comment claims.
#   MLSUBST       a multi-line `$( )` no longer truncates the enclosing command.
# The false-refusal controls (ids 158-173) deliberately appear in NEITHER: they
# are inputs that must keep matching nothing, so a row here for one of them
# means the widening reached prose.
ALLOWED="$TMPDIR/allowed.tsv"
# --- go-to-k/cdkd#2156 review round 1: the three blockers --------------------
#   MLBACKTICK  the multi-line BACKTICK spelling of a substitution, which the
#               first version left splitting while the docs called the class
#               closed. Its `$( )` twin is MLSUBST above.
#   APOSTROPHE  ids 174-181 exist to pin a NON-change: the quote-escape-reopen
#               idiom and `--body='...'` must reach NOTHING but their own body
#               carrier, and the three apostrophe PATHS must keep resolving.
#               Most produce no differing cell at all, which is the point --
#               they are here so a future widening that reaches into a quoted
#               body shows up as an undeclared cell rather than as silence.
# There is deliberately NO class for the leftmost-verb fix. Measured: it
# produces ZERO differing cells here, because this fence observes match /
# target / segcount and the defect was in the TAIL the strip helpers return --
# an observable this fence does not have. Its cases therefore live in
# command-match.test.sh, asserting the extracted value. Ids 186-189 are still
# in the corpus so the shapes are exercised; adding `rest` and `selector` as
# observables would fence them here too, and is the honest follow-up.
#   ACCEPTED_FR  ids 175-177: the three FALSE REFUSALS admitted in round 3's
#                security review, deliberately. `--body='next: pr merge 5'` and
#                its `-b'...'` / `=$'...'` spellings now reach the merge gates.
#                They are here so the trade stays VISIBLE and floored: forbidding
#                them cost dirty-path-restore-gate plus both merge gates going
#                rc=2 -> rc=0 on `--work-tree=/x/o'brien`, and a false refusal is
#                LOUD while a bypass is SILENT. If a later change makes these
#                stop matching WITHOUT re-introducing that loss, the floor fails
#                and that is the right moment to revisit the trade.
#                Round 5 added ids 166 / 174: restoring the quote-BLIND fallback
#                for later words (the fix for a token with MORE THAN ONE
#                apostrophe matching nothing) also lets the contraction idiom
#                and a spaced single-quoted body reach the merge gates. Third
#                time this PR took a LOUD refusal over a SILENT loss.
# --- review round 2: LATER-position quoted flag values (ids 190-196) ---------
#   LATERQ  the class round 1 lost and round 2 restored. Round 1 dropped the
#           single-quoted-span alternative for later words, which cost seven
#           balanced, runnable commands (a lost match is a BYPASS, so it was
#           strictly worse than the false refusal it fixed). These ids pin the
#           class in BOTH directions: six now match, and id 192 -- a dash-led
#           later token with a loose apostrophe -- is the one that still does
#           not, enumerated cell by cell in the superset section below rather
#           than described as a category.
# --- go-to-k/cdkd#2339: a backtick inside a DOUBLE-quoted span -------------
#   INQUOTE_BACKTICK  flush_line's in-quote branch handled `$(` and had no
#                     backtick arm, so the body of a backtick substitution
#                     inside a quoted span was never scanned as a command and
#                     reached the shell ungated. Cells are a segcount rise plus
#                     the verb that body carries.
# --- go-to-k/cdkd#2333: a QUOTED or ESCAPED structural token (ids 206-223) ---
#   DEQUOTE  the trigger matched the verb and the leading `-` as LITERAL text,
#            so QUOTING or ESCAPING either one walked past every gate while the
#            command still ran the gated verb. `gate_dequote_structural` now
#            dequotes the command word, the leading global-flag NAMES and the
#            SUBCOMMAND position -- and nothing else -- so every one of these is
#            0 -> 1, or a target that used to fall back to /BASE and now
#            resolves. Ids 210 / 211 / 216 / 217 carry `t:` cells because
#            dequoting the FLAG (or the `cd`) is what lets the resolver see the
#            worktree at all; id 216 changes every constant's target at once
#            because the quoted `"cd"` clause is read for all of them.
#
# THE CONTROLS ARE THE OTHER HALF, and they declare NO cell on purpose -- ids
# 218-222 (`git -C /abs/repo log --grep "commit"`, `show "commit"`,
# `grep -n "commit" -- src`, `grep -n '=>' x.ts && git commit`, and a `--body`
# carrying `pr merge`). They are the shapes the WITHDRAWN whole-segment
# implementation broke: it took 16 measured read-only commands from rc=0 to
# rc=2, and it rewrote a quoted argument that `split_paths` and
# `gated-command-preamble-gate` parse themselves. A row appearing for any of
# them means the rewrite has stopped being positional and has reached ARGUMENTS
# again, which is the exact regression that got the last attempt withdrawn.
#
# Id 217 is the CAP control. The withdrawn round bounded its character walk at
# 512 BYTES, and padding defeats that: 400 bytes of `-c user.name=xxx…` before
# a quoted verb was rc=0 while its literal-verb twin was rc=2. It is here so a
# future re-introduction of a byte cap fails as a lost DEQUOTE cell.
#
# Id 223 is NOT this change: `git -c alias.x="run commit later" status` lost its
# match back in go-to-k/cdkd#2156 (`_GATE_WORD_BLIND` excluding `"` so the blind
# reading can no longer parse half a quoted value), and it is enumerated under
# NOW_MISS -- the class that already carries "verb inside a spaced flag value is
# no longer the verb". It is in the corpus as a control for THIS change: a
# rewrite that reached into flag VALUES would turn it back into a match.
# Id 203 (SINGLE-quoted) and id 205 (a markdown code span in a single-quoted
# body) are the CONTROLS and declare NO cells: a backtick does not run inside
# single quotes, so the arm is scoped to double quotes and must leave both
# alone. Id 204 is the third control -- the ENCLOSING command survives a
# substitution in its body, so its segcount rises while its own match does not.
# --- go-to-k/cdkd#2650: a QUOTED `)` inside `$( )` (ids 224-230) -------------
#   QUOTED_PAREN  `close_paren` counted every `)` as a closer, so a `)` inside a
#                 quoted span ended the substitution early and the rest of the
#                 line was re-split around it. Measured before the fix,
#                 `x=$(echo 'a)b'; cd /tmp) ; echo hi > <tracked>` segmented to
#                 `"b"`, `cd /tmp`, `echo hi > <tracked>`, `echo 'a` -- four
#                 fragments in scrambled order, with the `cd` promoted to a
#                 top-level segment it never occupied. A consumer walking those
#                 in order then honours a `cd` the real shell runs in a
#                 subshell: `main-tree-edit-gate` went rc=0 where origin/main
#                 was 2, with the write landing on a tracked file in the main
#                 tree. The cells are segment-count corrections plus one verb
#                 that becomes reachable again (id 226, a quoted `)` in a `-C`
#                 value).
# Ids 227-229 are the CONTROLS and declare NO cell: two plain subshells and a
# `(` inside a quoted argument, all of which the fix must leave exactly as they
# were. A row appearing for one of them means the quote tracking has started
# eating structure it should not.
# --- go-to-k/cdkd#2650: ANSI-C quoting inside `$( )` (ids 231-236) -----------
#   ANSI_C        `close_paren` treated a `$'...'` span as a plain single-quoted
#                 one, which does not take escapes. An escaped quote inside such
#                 a span therefore closed it early, the scan resumed in the
#                 wrong state, and the substitution appeared to end before it
#                 did -- so the verb AFTER it was never reached. The single cell
#                 is id 236, `git -C $(echo $'a\'b') commit -m x`.
#                 READ THE DIRECTION CAREFULLY: origin/main gets this input
#                 RIGHT, because it tracks no quoting in `close_paren` at all
#                 and its blind scan happens to land on the correct `)`. The
#                 quote tracking is what breaks it, so this state guards a
#                 regression the quote-awareness introduces rather than closing
#                 a pre-existing bug. The cell appears at all only because the
#                 baseline pre-dates the whole line of work.
#
#                 OWNERSHIP MOVED, and the sentence above used to claim it.
#                 `close_paren` is now byte-identical to `origin/main` -- the
#                 quote and ANSI-C tracking landed there in go-to-k/cdkd#2639,
#                 derived from a 20,312-body differential fuzz against real
#                 bash, and this branch's own version was discarded in the
#                 rebase because main's is stricter where this branch's was
#                 wrong (a backslash is LITERAL inside single quotes). So the
#                 class fences upstream code, not this change's; it still goes
#                 red when the ANSI-C arm is removed, which is what keeps it a
#                 fence rather than a decoration.
#                 Without the state the segment splits at the wrong place and
#                 the `commit` is unreachable -- verified by mutation, and the
#                 shape came from the superset arm rather than from a
#                 hand-picked case.
# Ids 231-235 declare NO cell, and THAT IS NOT THE SAME AS "unchanged". An
# earlier revision of this legend said their `gate_segments` behaviour must be
# unchanged; a reviewer measured it false. For
# `diff <(git commit -m x) f ; echo hi > g` the baseline emits `diff` /
# `git commit -m x) f` / `echo hi > g` and this branch emits
# `diff "<(git commit -m x)" f` / `echo hi > g` / `git commit -m x` -- the
# segmentation changed materially. No cell appears because `segcount` and every
# `m:` and `t:` observable happen to come out the same, which is exactly the
# blind spot to name rather than to read as proof. These rows are here as the
# marking corpus (process substitution, a quoted `)` in a subshell, an
# `if (...)` compound, a `bash -c` body); what actually fences their behaviour
# is `main-tree-edit-gate.test.sh`, where reverting each one turns cases red.
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
96	m:GATE_RE_GIT_COMMIT	1	MLSUBST	git -C $(<nl> git rev-parse --show-toplevel <nl>) commit...
96	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	MLSUBST	git -C $(<nl> git rev-parse --show-toplevel <nl>) commit...
96	segcount	2	MLSUBST	git -C $(<nl> git rev-parse --show-toplevel <nl>) commit...
143	m:GATE_RE_GIT_COMMIT	1	WIDE_TRIGGER	git --exec-path /x /y commit -m x
143	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	WIDE_TRIGGER	git --exec-path /x /y commit -m x
144	m:GATE_RE_GIT_COMMIT	1	WIDE_TRIGGER	git -c a=b junkjunk commit -m x
144	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	WIDE_TRIGGER	git -c a=b junkjunk commit -m x
145	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	WIDE_TRIGGER	git -c a=b -X extra1 extra2 push origin HEAD
145	m:GATE_RE_GIT_PUSH	1	WIDE_TRIGGER	git -c a=b -X extra1 extra2 push origin HEAD
146	m:GATE_RE_GIT_MERGE	1	WIDE_TRIGGER	git -C /a/b -c x=y z w merge origin/main
146	t:GATE_RE_GIT_MERGE	/a/b	WIDE_TRIGGER	git -C /a/b -c x=y z w merge origin/main
147	m:GATE_RE_GIT_SWITCH	1	WIDE_TRIGGER	git -c a=b junk switch -c feat/x
148	m:GATE_RE_GIT_CHECKOUT_RESTORE	1	WIDE_TRIGGER	git -c a=b junk checkout -- f.txt
148	m:GATE_RE_GIT_SWITCH	1	WIDE_TRIGGER	git -c a=b junk checkout -- f.txt
149	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr merge 42 --squash
149	m:GATE_RE_GH_PR_MERGE	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr merge 42 --squash
149	m:GATE_RE_GH_PR_WRITE	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr merge 42 --squash
150	m:GATE_RE_GH_BODY_CARRIER	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr create --title x
150	m:GATE_RE_GH_LABEL_CARRIER	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr create --title x
150	m:GATE_RE_GH_PR_CREATE	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr create --title x
150	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr create --title x
150	m:GATE_RE_GH_PR_WRITE	1	WIDE_TRIGGER	gh -R o/r --jsonflag x y pr create --title x
151	m:GATE_RE_GIT_COMMIT	1	WIDE_TRIGGER	git -c user.name="Jane Doe" log --grep commit
151	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	WIDE_TRIGGER	git -c user.name="Jane Doe" log --grep commit
152	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	WIDE_TRIGGER	git --no-pager -c a=b log --grep push
152	m:GATE_RE_GIT_PUSH	1	WIDE_TRIGGER	git --no-pager -c a=b log --grep push
153	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	MLSUBST	gh -R $(<nl> echo o/r<nl>) pr merge 42 --squash
153	m:GATE_RE_GH_PR_MERGE	1	MLSUBST	gh -R $(<nl> echo o/r<nl>) pr merge 42 --squash
153	m:GATE_RE_GH_PR_WRITE	1	MLSUBST	gh -R $(<nl> echo o/r<nl>) pr merge 42 --squash
153	segcount	2	MLSUBST	gh -R $(<nl> echo o/r<nl>) pr merge 42 --squash
154	m:GATE_RE_GIT_COMMIT	1	MLSUBST	git -c a=$(<nl> echo b<nl>) commit -m x
154	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	MLSUBST	git -c a=$(<nl> echo b<nl>) commit -m x
154	segcount	2	MLSUBST	git -c a=$(<nl> echo b<nl>) commit -m x
155	segcount	2	MLSUBST	out=$(<nl> cd /x<nl> git commit -m y<nl>)
156	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	MLSUBST	git -C $(<nl> echo /a/b<nl>) push origin HEAD
156	m:GATE_RE_GIT_PUSH	1	MLSUBST	git -C $(<nl> echo /a/b<nl>) push origin HEAD
156	segcount	2	MLSUBST	git -C $(<nl> echo /a/b<nl>) push origin HEAD
157	segcount	2	MLSUBST	echo "$(<nl> git commit -m x<nl>)"
166	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R o/r pr create -b 'x pr merge y'
166	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh -R o/r pr create -b 'x pr merge y'
166	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh -R o/r pr create -b 'x pr merge y'
166	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R o/r pr create -b 'x pr merge y'
166	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R o/r pr create -b 'x pr merge y'
167	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R o/r pr create -b "x pr merge y"
167	m:GATE_RE_GH_LABEL_CARRIER	1	NOW_MATCH	gh -R o/r pr create -b "x pr merge y"
167	m:GATE_RE_GH_PR_CREATE	1	NOW_MATCH	gh -R o/r pr create -b "x pr merge y"
167	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R o/r pr create -b "x pr merge y"
167	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R o/r pr create -b "x pr merge y"
168	segcount	1	SEGCOUNT	MSG=$(echo git commit -m x)
172	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	gh issue comment 1 --body "we ran:<nl>git -C $W commit -...
172	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	gh issue comment 1 --body "we ran:<nl>git -C $W commit -...
172	segcount	1	SEGCOUNT	gh issue comment 1 --body "we ran:<nl>git -C $W commit -...
174	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R go-to-k/cdk-local issue comment 42 --body 'we can'...
175	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R o/r issue comment 1 --body='next: pr merge 5'
176	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R o/r issue comment 1 -b'next: pr merge 5'
177	m:GATE_RE_GH_BODY_CARRIER	1	NOW_MATCH	gh -R o/r issue comment 1 --body=$'next: pr merge 5'
179	t:GATE_RE_GIT_COMMIT	/w/t	TARGET	git -c user.name=O'Brien -C /w/t commit -m x
179	t:GATE_RE_GIT_COMMIT_OR_PUSH	/w/t	TARGET	git -c user.name=O'Brien -C /w/t commit -m x
180	t:GATE_RE_GIT_COMMIT	/tmp/o'neill/repo	TARGET	git -c a=b -C /tmp/o'neill/repo commit -m x
180	t:GATE_RE_GIT_COMMIT_OR_PUSH	/tmp/o'neill/repo	TARGET	git -c a=b -C /tmp/o'neill/repo commit -m x
182	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh --template 'a b' pr merge 42
182	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh --template 'a b' pr merge 42
182	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh --template 'a b' pr merge 42
183	m:GATE_RE_GIT_COMMIT	1	MLBACKTICK	git -C `<nl> echo /a/b<nl>` commit -m x
183	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	MLBACKTICK	git -C `<nl> echo /a/b<nl>` commit -m x
183	segcount	2	MLBACKTICK	git -C `<nl> echo /a/b<nl>` commit -m x
184	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	MLBACKTICK	gh -R `<nl> echo o/r<nl>` pr merge 42 --squash
184	m:GATE_RE_GH_PR_MERGE	1	MLBACKTICK	gh -R `<nl> echo o/r<nl>` pr merge 42 --squash
184	m:GATE_RE_GH_PR_WRITE	1	MLBACKTICK	gh -R `<nl> echo o/r<nl>` pr merge 42 --squash
184	segcount	2	MLBACKTICK	gh -R `<nl> echo o/r<nl>` pr merge 42 --squash
185	m:GATE_RE_GIT_COMMIT	1	NOW_MATCH	git -C `pwd` commit -m x
185	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	NOW_MATCH	git -C `pwd` commit -m x
185	segcount	2	SEGCOUNT	git -C `pwd` commit -m x
187	t:GATE_RE_GIT_CHECKOUT_RESTORE	/wt	TARGET	git -c a=b -C /wt checkout -- f.txt # see git checkout m...
187	t:GATE_RE_GIT_SWITCH	/wt	TARGET	git -c a=b -C /wt checkout -- f.txt # see git checkout m...
188	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	NOW_MATCH	gh -R o/r pr merge 2195 --squash --delete-branch # then ...
188	m:GATE_RE_GH_PR_MERGE	1	NOW_MATCH	gh -R o/r pr merge 2195 --squash --delete-branch # then ...
188	m:GATE_RE_GH_PR_WRITE	1	NOW_MATCH	gh -R o/r pr merge 2195 --squash --delete-branch # then ...
192	m:GATE_RE_GIT_COMMIT	0	LATERQ	git -C /repo --work-tree=/Users/o'brien/wt commit -m x
192	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	LATERQ	git -C /repo --work-tree=/Users/o'brien/wt commit -m x
192	t:GATE_RE_GIT_COMMIT	/BASE	LATERQ	git -C /repo --work-tree=/Users/o'brien/wt commit -m x
192	t:GATE_RE_GIT_COMMIT_OR_PUSH	/BASE	LATERQ	git -C /repo --work-tree=/Users/o'brien/wt commit -m x
193	m:GATE_RE_GH_BODY_CARRIER	1	LATERQ	gh -R o/r --template 'a b' pr create --title x
193	m:GATE_RE_GH_LABEL_CARRIER	1	LATERQ	gh -R o/r --template 'a b' pr create --title x
193	m:GATE_RE_GH_PR_CREATE	1	LATERQ	gh -R o/r --template 'a b' pr create --title x
193	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	LATERQ	gh -R o/r --template 'a b' pr create --title x
193	m:GATE_RE_GH_PR_WRITE	1	LATERQ	gh -R o/r --template 'a b' pr create --title x
194	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	LATERQ	gh -R o/r --template 'a b' pr merge 42
194	m:GATE_RE_GH_PR_MERGE	1	LATERQ	gh -R o/r --template 'a b' pr merge 42
194	m:GATE_RE_GH_PR_WRITE	1	LATERQ	gh -R o/r --template 'a b' pr merge 42
195	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	LATERQ	git -C /repo -c a='b c' push origin HEAD
195	m:GATE_RE_GIT_PUSH	1	LATERQ	git -C /repo -c a='b c' push origin HEAD
195	t:GATE_RE_GIT_COMMIT_OR_PUSH	/repo	LATERQ	git -C /repo -c a='b c' push origin HEAD
195	t:GATE_RE_GIT_PUSH	/repo	LATERQ	git -C /repo -c a='b c' push origin HEAD
175	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	ACCEPTED_FR	gh -R o/r issue comment 1 --body='next: pr merge 5'
175	m:GATE_RE_GH_PR_MERGE	1	ACCEPTED_FR	gh -R o/r issue comment 1 --body='next: pr merge 5'
175	m:GATE_RE_GH_PR_WRITE	1	ACCEPTED_FR	gh -R o/r issue comment 1 --body='next: pr merge 5'
176	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	ACCEPTED_FR	gh -R o/r issue comment 1 -b'next: pr merge 5'
176	m:GATE_RE_GH_PR_MERGE	1	ACCEPTED_FR	gh -R o/r issue comment 1 -b'next: pr merge 5'
176	m:GATE_RE_GH_PR_WRITE	1	ACCEPTED_FR	gh -R o/r issue comment 1 -b'next: pr merge 5'
177	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	ACCEPTED_FR	gh -R o/r issue comment 1 --body=$'next: pr merge 5'
177	m:GATE_RE_GH_PR_MERGE	1	ACCEPTED_FR	gh -R o/r issue comment 1 --body=$'next: pr merge 5'
177	m:GATE_RE_GH_PR_WRITE	1	ACCEPTED_FR	gh -R o/r issue comment 1 --body=$'next: pr merge 5'
199	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	LATERQ	gh -R o/r --template=/a/o'neill pr merge 2195 --squash
199	m:GATE_RE_GH_PR_MERGE	1	LATERQ	gh -R o/r --template=/a/o'neill pr merge 2195 --squash
199	m:GATE_RE_GH_PR_WRITE	1	LATERQ	gh -R o/r --template=/a/o'neill pr merge 2195 --squash
201	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	LATERQ	gh -R o/r --template=/a/oneill pr merge 2195 --squash
201	m:GATE_RE_GH_PR_MERGE	1	LATERQ	gh -R o/r --template=/a/oneill pr merge 2195 --squash
201	m:GATE_RE_GH_PR_WRITE	1	LATERQ	gh -R o/r --template=/a/oneill pr merge 2195 --squash
166	m:GATE_RE_GH_PR_MERGE	1	ACCEPTED_FR	gh -R o/r pr create -b 'x pr merge y'
174	m:GATE_RE_GH_PR_MERGE	1	ACCEPTED_FR	gh ... issue comment 42 --body 'we can'\''t pr merge 99 ...'
174	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	ACCEPTED_FR	gh ... issue comment 42 --body 'we can'\''t pr merge 99 ...'
174	m:GATE_RE_GH_PR_WRITE	1	ACCEPTED_FR	gh ... issue comment 42 --body 'we can'\''t pr merge 99 ...'
202	segcount	2	INQUOTE_BACKTICK	backtick in a DOUBLE-quoted span
202	m:GATE_RE_GIT_SWITCH	1	INQUOTE_BACKTICK	backtick in a DOUBLE-quoted span
202	t:GATE_RE_GIT_SWITCH	/abs/repo	INQUOTE_BACKTICK	backtick in a DOUBLE-quoted span
202	m:GATE_RE_GIT_CHECKOUT_RESTORE	1	INQUOTE_BACKTICK	backtick in a DOUBLE-quoted span
202	t:GATE_RE_GIT_CHECKOUT_RESTORE	/abs/repo	INQUOTE_BACKTICK	backtick in a DOUBLE-quoted span
204	segcount	2	INQUOTE_BACKTICK	enclosing command survives; its own match unchanged
206	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	git "commit" -- a DOUBLE-quoted verb
206	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	git "commit" -- a DOUBLE-quoted verb
207	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	git 'commit' -- a SINGLE-quoted verb
207	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	git 'commit' -- a SINGLE-quoted verb
208	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	git c"o"mmit -- a verb split by an interior quoted span
208	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	git c"o"mmit -- a verb split by an interior quoted span
209	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	git \commit -- an ESCAPED verb
209	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	git \commit -- an ESCAPED verb
210	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	git "-C" /abs/repo commit -- a quoted leading FLAG
210	t:GATE_RE_GIT_COMMIT	/abs/repo	DEQUOTE	git "-C" /abs/repo commit -- a quoted leading FLAG
210	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	git "-C" /abs/repo commit -- a quoted leading FLAG
210	t:GATE_RE_GIT_COMMIT_OR_PUSH	/abs/repo	DEQUOTE	git "-C" /abs/repo commit -- a quoted leading FLAG
211	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	git \-C /abs/repo commit -- an escaped leading FLAG
211	t:GATE_RE_GIT_COMMIT	/abs/repo	DEQUOTE	git \-C /abs/repo commit -- an escaped leading FLAG
211	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	git \-C /abs/repo commit -- an escaped leading FLAG
211	t:GATE_RE_GIT_COMMIT_OR_PUSH	/abs/repo	DEQUOTE	git \-C /abs/repo commit -- an escaped leading FLAG
212	m:GATE_RE_GH_PR_MERGE	1	DEQUOTE	gh "pr" merge -- a quoted FIRST verb token
212	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	DEQUOTE	gh "pr" merge -- a quoted FIRST verb token
212	m:GATE_RE_GH_PR_WRITE	1	DEQUOTE	gh "pr" merge -- a quoted FIRST verb token
213	m:GATE_RE_GH_PR_MERGE	1	DEQUOTE	gh pr "merge" -- a quoted SECOND verb token
213	m:GATE_RE_GH_PR_CREATE_OR_MERGE	1	DEQUOTE	gh pr "merge" -- a quoted SECOND verb token
213	m:GATE_RE_GH_PR_WRITE	1	DEQUOTE	gh pr "merge" -- a quoted SECOND verb token
214	m:GATE_RE_GIT_SWITCH	1	DEQUOTE	git "checkout" -- the go-to-k/cdkd#1700 data-loss gate's verb
214	m:GATE_RE_GIT_CHECKOUT_RESTORE	1	DEQUOTE	git "checkout" -- the go-to-k/cdkd#1700 data-loss gate's verb
215	m:GATE_RE_GIT_CHECKOUT_RESTORE	1	DEQUOTE	git -C /abs/repo "restore" -- same, behind a global flag
215	t:GATE_RE_GIT_CHECKOUT_RESTORE	/abs/repo	DEQUOTE	git -C /abs/repo "restore" -- same, behind a global flag
216	t:GATE_RE_GIT_COMMIT	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GIT_PUSH	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GIT_COMMIT_OR_PUSH	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GIT_MERGE	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GIT_SWITCH	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GIT_CHECKOUT_RESTORE	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_PR_CREATE	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_PR_EDIT	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_PR_MERGE	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_PR_CREATE_OR_MERGE	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_PR_WRITE	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_LABEL_CARRIER	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_API	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
216	t:GATE_RE_GH_BODY_CARRIER	/abs/repo	DEQUOTE	"cd" /abs/repo && git commit -- the quoted cd RESOLVER clause
217	m:GATE_RE_GIT_COMMIT	1	DEQUOTE	400-byte padded -c value then a quoted verb -- a BYTE cap cannot see this
217	t:GATE_RE_GIT_COMMIT	/abs/repo	DEQUOTE	400-byte padded -c value then a quoted verb -- a BYTE cap cannot see this
217	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	DEQUOTE	400-byte padded -c value then a quoted verb -- a BYTE cap cannot see this
217	t:GATE_RE_GIT_COMMIT_OR_PUSH	/abs/repo	DEQUOTE	400-byte padded -c value then a quoted verb -- a BYTE cap cannot see this
223	m:GATE_RE_GIT_COMMIT	0	NOW_MISS	verb inside a spaced flag value is no longer the verb
223	m:GATE_RE_GIT_COMMIT_OR_PUSH	0	NOW_MISS	verb inside a spaced flag value is no longer the verb
224	segcount	3	QUOTED_PAREN	a double-quoted ) inside $( ) no longer splits the substitution
225	segcount	3	QUOTED_PAREN	the same with a single-quoted )
226	m:GATE_RE_GIT_COMMIT	1	QUOTED_PAREN	a quoted ) in a -C value: the verb is reachable again
226	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	QUOTED_PAREN	a quoted ) in a -C value: the verb is reachable again
230	segcount	2	QUOTED_PAREN	a quoted ) in a substitution before the verb
236	m:GATE_RE_GIT_COMMIT	1	ANSI_C	an escaped quote in a $' ' span no longer ends the substitution early
236	m:GATE_RE_GIT_COMMIT_OR_PUSH	1	ANSI_C	an escaped quote in a $' ' span no longer ends the substitution early
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
# FLOORS ARE SET TO THE OBSERVED COUNT, not below it (go-to-k/cdkd#2156 review
# round 1). The pre-existing four sat far under: NOW_MATCH had drifted to 81
# against a floor of 55, and a reviewer probe neutralising five corpus inputs --
# 25 pinned go-to-k/cdkd#2027 bypass-fix cells -- still reported a clean pass.
# A floor with slack cannot see a quarter of its own population disappear.
#
# That matters more than it looks, because the baseline is pre-go-to-k/cdkd#2027
# `8e84e4e2` rather than `origin/main`: a change that returns main to
# pre-go-to-k/cdkd#2027 behaviour produces cells that are ALREADY in the table,
# so the "undeclared" arm is blind to it and these floors are the only thing
# that sees it. Raise them with the measurement whenever the corpus grows; do
# not leave slack "for headroom", which is precisely what defeated them.
for spec in "NOW_MATCH:93" "NOW_MISS:14" "TARGET:17" "SEGCOUNT:16" "WIDE_TRIGGER:23" "MLSUBST:15" "MLBACKTICK:7" "LATERQ:18" "ACCEPTED_FR:13" "INQUOTE_BACKTICK:6" "DEQUOTE:44" "QUOTED_PAREN:5" "ANSI_C:2"; do
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

# =============================================================================
# THE SUPERSET INVARIANT (go-to-k/cdkd#2156 review round 2)
# =============================================================================
#
# Everything above compares against the PRE-go-to-k/cdkd#2027 blob `8e84e4e2`,
# and against that baseline a lost match is a legitimate, enumerated outcome --
# go-to-k/cdkd#2027 deliberately removed matches. So "differs" there does NOT
# mean "regressed", and the table can and does contain NOW_MISS rows.
#
# That is exactly the hole three review rounds fell through. This work claims a
# STRICTLY STRONGER property -- the new trigger matches everything the PRE-2156
# trigger matched -- and that claim is mechanically checkable against a
# DIFFERENT baseline. Rounds 1 and 2 each found a class of lost matches that no
# hand-built corpus contained, one round at a time; had this assertion existed,
# both would have surfaced at once.
#
# Two properties make it an invariant rather than another case list:
#   * a lost cell is a FAILURE, not a class. Every exception is enumerated CELL
#     BY CELL with its exact input -- never as a category. Round 2 shipped the
#     category "unbalanced-quote input no shell runs", and SEVEN balanced,
#     runnable commands were hiding inside it.
#   * the baseline is PINNED to a SHA, not to `origin/main`. Once this merges,
#     origin/main contains this change and comparing to it would report a clean
#     zero forever. The sha was the lane's merge base when it was taken; the
#     lane has since been rebased, so do NOT "correct" it to today's merge base
#     -- what makes it the right baseline is that its matcher is the PRE-2156
#     trigger, which is a property of the CONTENT, not of the graph position.
#     Verified 2026-08-28: byte-identical to `origin/main`'s matcher, so the
#     comparison is still against the pre-2156 behaviour.
PRE="$HERE/testdata/command-match.pre2156.sh"
PRE_SHA="84480c414b3573ef70e3b01b8afd769bb65f7ddf"
PRE_SHA256="5ec28675c150f924f9a63df2fdbda87c652cd395e0a9c65007372f5ea306a220"
if [ ! -r "$PRE" ] || [ ! -s "$PRE" ]; then
  ng "superset: cannot read the pre-2156 baseline $PRE -- the invariant did NOT run"
else
  pre_mark=$(grep -n 'VENDORED CONTENT BEGINS' "$PRE" | head -1 | cut -d: -f1)
  pre_got=$(tail -n "+$((pre_mark + 1))" "$PRE" | sha256_of)
  if [ "$pre_got" = "NO-HASHER" ]; then
    ng "superset: no sha256 tool, so the pre-2156 baseline could NOT be verified"
  elif [ "$pre_got" = "$PRE_SHA256" ]; then
    ok "superset: pre-2156 baseline matches $PRE_SHA byte-for-byte"
  else
    ng "superset: pre-2156 baseline is $pre_got, expected $PRE_SHA256 -- it has DRIFTED, so the comparison below is against the wrong thing"
  fi

  HOME="$FENCE_HOME" LC_ALL=C bash "$TMPDIR/emit.sh" "$PRE" "$CORPUS" > "$TMPDIR/pre.tsv" 2>/dev/null
  # Cells the PRE-2156 trigger matched and this one does not. Each must be
  # enumerated below WITH ITS INPUT, or the fence fails.
  LOST_ALLOWED="$TMPDIR/lost-allowed.tsv"
  cat > "$LOST_ALLOWED" <<'LOST_EOF'
LOST_EOF
  # EMPTY, and that is the round-3 review's outcome rather than an oversight.
  # It briefly held two cells for a LATER, DASH-LED token with a LOOSE
  # apostrophe, priced as "two cells on `commit`". A security review measured
  # the same token shape with `checkout` / `restore` / `pr merge` and found
  # dirty-path-restore-gate (the go-to-k/cdkd#1700 data-loss gate) and BOTH
  # merge gates going rc=2 -> rc=0 -- so the price was three gates, not two
  # cells, and the shape was admitted instead (see _GATE_WORD_LOOSE_FLAG).
  #
  # The corpus is why the mispricing was possible: it carried that token shape
  # only with `commit`, so this table enumerated only the two `commit` cells
  # while the `checkout` / `restore` / `pr merge` instances went unseen. The
  # variants are in the corpus now. An enumerated exception is only ever as
  # honest as the corpus behind it -- so when adding one, add the SAME input
  # with every verb it can carry, not just the one that surfaced it.
  lost_unexplained=""
  lost_n=0
  while IFS=$'\t' read -r pid pobs pval && IFS=$'\t' read -r nid nobs nval <&3; do
    [ -n "$pid" ] || continue
    [ "$pval" = "1" ] || continue
    [ "$nval" = "0" ] || continue
    lost_n=$((lost_n + 1))
    if ! awk -F'\t' -v i="$pid" -v o="$pobs" '$1==i && $2==o {found=1} END{exit(found?0:1)}' "$LOST_ALLOWED"; then
      lost_unexplained="$lost_unexplained\n  id=$pid  $pobs"
    fi
  done < "$TMPDIR/pre.tsv" 3< "$TMPDIR/new.tsv"

  if [ -z "$lost_unexplained" ]; then
    ok "superset: $lost_n lost cell(s) vs $PRE_SHA, all enumerated with their input"
  else
    ng "superset: match(es) LOST vs the pre-2156 trigger and NOT enumerated -- each is a gate that stopped firing:$(printf '%b' "$lost_unexplained")"
  fi

  # The enumeration must stay HONEST in the other direction too: a row that no
  # longer corresponds to a real lost cell means the exception was fixed (good)
  # or the corpus stopped covering it (bad), and both should be noticed.
  stale_rows=""
  while IFS=$'\t' read -r aid aobs ainput; do
    [ -n "$aid" ] || continue
    if ! paste "$TMPDIR/pre.tsv" "$TMPDIR/new.tsv" \
         | awk -F'\t' -v i="$aid" -v o="$aobs" '$1==i && $2==o && $3=="1" && $6=="0" {found=1} END{exit(found?0:1)}'; then
      stale_rows="$stale_rows\n  id=$aid  $aobs"
    fi
  done < "$LOST_ALLOWED"
  if [ -z "$stale_rows" ]; then
    ok "superset: every enumerated exception still corresponds to a real lost cell"
  else
    ng "superset: enumerated exception(s) no longer observed -- either the loss was fixed (drop the row) or the corpus stopped covering it:$(printf '%b' "$stale_rows")"
  fi
fi

# =============================================================================
# THE GENERATED LATER-WORD CORPUS (go-to-k/cdkd#2156 review round 5)
# =============================================================================
#
# WHY THIS EXISTS, and it is the diagnosis of all five review rounds rather than
# a sixth patch. Every round found the defect in a token position the corpus
# enumerates BY HAND. The grammar is a hand-written approximation of shell word
# syntax and the corpus was a hand-written sample of it -- two hand-written
# things, and a fence only ever sees their INTERSECTION. Round 4's corpus
# carried the shape with one VERB; round 5's carried it with one APOSTROPHE.
# Each time the invariant above was honest and blind.
#
# So the LATER-word corpus is GENERATED: apostrophe count x dash-led x span
# position x verb, crossed exhaustively. It is not a sample of remembered
# shapes, so the next grammar gap does not have to be one anybody thought of.
#
# PROVEN NON-VACUOUS against the two trees that actually had the bugs, which is
# the only evidence worth having for a fence like this:
#
#   round-3 tree (span alternative dropped for later words)   102 lost cells
#   round-4 tree (one loose apostrophe only)                   68 lost cells
#   this tree                                                   0 lost cells
#
# i.e. it would have caught rounds 4 and 5 together, at round 3.
#
# The grid is the fence. When a new grammar case appears, add its AXIS here --
# never a single remembered string, which is how the hand-written corpus kept
# being one case behind.
GEN="$TMPDIR/gen.b64"
GQ=$(printf '\047')
gen_grid=(
  "apo0-bare|/opt/git/libexec"
  "apo0-dash|--exec-path=/opt/git/libexec"
  "apo1-bare|/opt/o${GQ}neill/wt"
  "apo1-dash|--work-tree=/x/o${GQ}brien"
  "apo2-bare|/opt/o${GQ}neill/d${GQ}arcy"
  "apo2-dash|--work-tree=/x/o${GQ}brien/d${GQ}arcy"
  "span-end-bare|${GQ}a b${GQ}"
  "span-end-dash|--exec-path=${GQ}/opt/git${GQ}"
  "span-tail-bare|${GQ}/opt/git${GQ}/libexec"
  "span-tail-dash|--exec-path=${GQ}/opt/git${GQ}/libexec"
  "span-mid-bare|a${GQ}b c${GQ}d"
  "span-mid-dash|--author=a${GQ}b c${GQ}d"
  "idiom-bare|${GQ}O${GQ}\\${GQ}${GQ}Brien${GQ}"
  "idiom-dash|--author=${GQ}O${GQ}\\${GQ}${GQ}Brien${GQ}"
  "apo5-dash|--author=${GQ}O${GQ}\\${GQ}${GQ}Brien-D${GQ}\\${GQ}${GQ}Arcy${GQ}"
  "dq-dash|--author=\"Jane Doe\""
  "dq-bare|\"Jane Doe\""
)
# Every shape with EVERY verb it can carry -- the round-4 lesson, mechanised.
gen_verbs=( "commit -m x" "push origin HEAD" "checkout -- f.txt" "restore f.txt" "merge origin/main" "switch -c feat/x" )
gen_gh_verbs=( "pr merge 42 --squash" "pr create --title x" )
: > "$GEN"
for g in "${gen_grid[@]}"; do
  gtok="${g#*|}"
  for v in "${gen_verbs[@]}"; do
    { printf 'git -C /wt %s %s' "$gtok" "$v" | base64 | tr -d '\n'; echo; } >> "$GEN"
  done
  for v in "${gen_gh_verbs[@]}"; do
    { printf 'gh -R o/r %s %s' "$gtok" "$v" | base64 | tr -d '\n'; echo; } >> "$GEN"
  done
done
gen_n=$(grep -c . "$GEN" | tr -d ' ')
if [ "$gen_n" -ge 100 ]; then
  ok "generated corpus: $gen_n inputs (${#gen_grid[@]} token shapes x $(( ${#gen_verbs[@]} + ${#gen_gh_verbs[@]} )) verbs)"
else
  ng "generated corpus: only $gen_n inputs -- the grid collapsed, so the assertions below are vacuous"
fi

if [ -r "$PRE" ] && [ -s "$PRE" ] && [ "$gen_n" -ge 100 ]; then
  HOME="$FENCE_HOME" LC_ALL=C bash "$TMPDIR/emit.sh" "$PRE" "$GEN" > "$TMPDIR/gen-pre.tsv" 2>/dev/null
  HOME="$FENCE_HOME" LC_ALL=C bash "$TMPDIR/emit.sh" "$NEW_LIB" "$GEN" > "$TMPDIR/gen-new.tsv" 2>/dev/null
  gen_rows=$(wc -l < "$TMPDIR/gen-new.tsv" | tr -d ' ')
  # Only the MATCH observables: a target string legitimately differs here (the
  # generated inputs carry no resolvable `-C` beyond /wt), and a lost MATCH is
  # the property this section exists for.
  gen_lost=$(paste "$TMPDIR/gen-pre.tsv" "$TMPDIR/gen-new.tsv" \
    | awk -F'\t' '$2 ~ /^m:/ && $3=="1" && $6=="0" {print $1"\t"$2}' | tee "$TMPDIR/gen-lost.tsv" | awk 'END{print NR}')
  gen_gained=$(paste "$TMPDIR/gen-pre.tsv" "$TMPDIR/gen-new.tsv" \
    | awk -F'\t' '$2 ~ /^m:/ && $3=="0" && $6=="1"' | awk 'END{print NR}')

  if [ "$gen_rows" -gt 2000 ]; then
    ok "generated corpus: $gen_rows observable rows per side, $gen_gained gained (a wider trigger; loud)"
  else
    ng "generated corpus: only $gen_rows rows per side -- too small to be evidence"
  fi

  if [ "$gen_lost" -eq 0 ]; then
    ok "generated corpus: 0 lost cells vs the pre-2156 trigger across the whole grid"
  else
    ng "generated corpus: $gen_lost LOST cell(s) -- a gate stopped firing on a command the pre-2156 trigger caught:
$(while IFS=$'\t' read -r gi go; do printf '      %s  %s\n' "$go" "$(sed -n "${gi}p" "$GEN" | base64 -d 2>/dev/null | cut -c1-70)"; done < "$TMPDIR/gen-lost.tsv" | head -12)"
  fi
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
