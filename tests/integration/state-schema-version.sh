# state-schema-version.sh - derive the state.json schema version a fixture
# should expect, from the SHAPE of the records (go-to-k/cdkd#7178).
#
# Source it from a verify.sh, after the `cd "$(dirname "$0")"`:
#
#     . ../state-schema-version.sh
#
# A flat file, not a directory, so the coverage-matrix generators do not treat
# it as a fixture (same reason as `revert-identity.sh`).
#
# cdkd writes the LOWEST schema version a record needs (stateSchemaVersionFor in
# src/types/state.ts), not the newest, so a fixture must never assert the
# binary's newest version. Mirror the rule instead:
#   18  any record (resources, orphans[].state, supersededResources[].state) has a
#       referenceProvenance entry carrying `versionsSent`
#   17  else, any record has `noEchoValueMacs`
#   16  else
# When stateSchemaVersionFor changes, change it HERE only (#7147, #7148, #7163).
#
# expected_state_schema_version <state.json path | ->
#   Prints the expected version on stdout. `-` reads the document from stdin.
expected_state_schema_version() {
  local src="${1:--}"
  if [ "${src}" = "-" ]; then
    jq -r "$(_state_schema_version_filter)"
  else
    jq -r "$(_state_schema_version_filter)" "${src}"
  fi
}

_state_schema_version_filter() {
  cat <<'JQ'
[(.resources // {} | to_entries[].value), ((.orphans // [])[] | .state), ((.supersededResources // [])[] | .state)]
| map(select(. != null and type == "object")) as $r
| if any($r[]; (.referenceProvenance // {}) | type == "object" and any(.[]; type == "object" and .versionsSent != null)) then 18
  elif any($r[]; .noEchoValueMacs != null) then 17
  else 16 end
JQ
}
