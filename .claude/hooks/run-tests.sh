#!/usr/bin/env bash
# Runs every hook smoke test under EVERY bash on this machine.
#
# Why more than one shell: the hooks are `#!/usr/bin/env bash`, so which
# bash they get depends on PATH. On a machine without Homebrew bash first
# on PATH they run under macOS's system bash 3.2, where bash 4+ syntax
# (`mapfile`, `declare -A`, `${var^}`, `${var,,}`) is a runtime error.
# Issue #1458 shipped a `mapfile` in the shared helper that would have
# silently left quoted `cd` paths unresolved under 3.2, and issue #1477
# found `provider-integ-gate.test.sh` itself failing there — both found
# only by running the suites under `/bin/bash` explicitly.
#
# Usage (from the repo root):
#   bash .claude/hooks/run-tests.sh
#   vp run test:hooks
#
# Exits 0 only when every suite passes under every shell.

set -u

cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" || exit 1

# Every bash worth testing against, de-duplicated by resolved version.
# `bash` is whatever PATH gives (Homebrew 5.x on a dev Mac, the distro
# bash in CI); `/bin/bash` is macOS's system 3.2. On Linux both usually
# resolve to the same binary, in which case the second is skipped.
shells=()
seen=""
for candidate in bash /bin/bash; do
  command -v "$candidate" >/dev/null 2>&1 || continue
  resolved="$(command -v "$candidate")"
  case " $seen " in
    *" $resolved "*) continue ;;
  esac
  seen="$seen $resolved"
  shells+=("$candidate")
done

if [ ${#shells[@]} -eq 0 ]; then
  echo "no bash found on PATH" >&2
  exit 1
fi

failures=0
for shell in "${shells[@]}"; do
  version="$("$shell" -c 'echo "${BASH_VERSION}"')"
  echo "===== $shell (bash $version) ====="
  for suite in .claude/hooks/*.test.sh .claude/hooks/lib/*.test.sh; do
    [ -f "$suite" ] || continue
    if output="$("$shell" "$suite" 2>&1)"; then
      # A suite can exit 0 while individual cases failed (the runners
      # print a `fail: N` tally rather than propagating the count), so
      # the tally is checked too — this is exactly how the bash 3.2
      # breakage in issue #1477 stayed invisible.
      if printf '%s\n' "$output" | grep -qE '^[[:space:]]*total:.*fail: [1-9]'; then
        echo "FAIL $suite"
        printf '%s\n' "$output"
        failures=$((failures + 1))
      else
        echo "  ok  $suite"
      fi
    else
      echo "FAIL $suite (exit $?)"
      printf '%s\n' "$output"
      failures=$((failures + 1))
    fi
  done
done

if [ "$failures" -ne 0 ]; then
  echo ""
  echo "$failures hook suite run(s) failed" >&2
  exit 1
fi

echo ""
echo "all hook suites pass under: ${shells[*]}"
