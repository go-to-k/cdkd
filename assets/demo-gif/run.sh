#!/usr/bin/env bash
# Side-by-side real recording: cdkd deploy (left) vs cdk deploy (right).
# Both deploy a 5-resource SDK-Provider stack (S3 / DDB / SQS / SNS / SSM).
# cdkd on the left so left-to-right readers see the featured tool first
# and immediately hit the "finished" punchline.

set -e

# Force a UTF-8 locale so tmux renders multibyte glyphs (cdkd's em-dashes,
# spinner / status markers, and any emoji) instead of substituting `_`.
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8

DEMO_DIR="$(cd "$(dirname "$0")" && pwd)"
CONF="$DEMO_DIR/tmux-clean.conf"

# Use the freshly-built cdkd from the repo's dist/, not the globally-installed
# one (which may be a different release). Shadow `cdkd` on PATH with a symlink
# to the local build so the visible command in the GIF stays plain `cdkd`.
CDKD_BIN="$(cd "$DEMO_DIR/../.." && pwd)/dist/cli.js"
SHADOW_BIN="$(mktemp -d)"
ln -sf "$CDKD_BIN" "$SHADOW_BIN/cdkd"
export PATH="$SHADOW_BIN:$PATH"
trap 'rm -rf "$SHADOW_BIN"' EXIT

# The `cdk` binary used for the RIGHT pane. Defaults to whatever `cdk` is on
# PATH; override at record time to pin a version, e.g.
#   CDK_BIN="npx -y aws-cdk@2.1116.0" vhs cdk-vs-cdkd.tape
# A pinned older CLI is used for the published GIF because newer `cdk deploy`
# output prints the change-set ARN (which embeds the AWS account id) — see
# README.md "Reproducing".
CDK_BIN="${CDK_BIN:-cdk}"

# Pre-synth the CDK app ONCE (cdk synth writes cdk.out/, used by both
# `cdkd deploy -a cdk.out` and `cdk deploy -a cdk.out`). The recorded
# `time real` blocks then reflect deploy phase only — matching the
# README's deploy-only benchmark numbers (the synth cost is identical
# for both tools and would just add noise to the comparison).
(cd "$DEMO_DIR" && $CDK_BIN synth --all >/dev/null 2>&1)

# FORCE_COLOR=1 makes cdkd's chalk emit ANSI colors even though tmux's
# pseudo-TTY would otherwise be detected as non-color. cdk already colors
# unconditionally. COLORTERM=truecolor lets both emit 24-bit colors.
ENV='FORCE_COLOR=1 COLORTERM=truecolor'

# The echoed line MUST mention `time` so the trailing real/user/sys block
# at the end of each pane matches what the viewer saw being typed.
# `-a cdk.out` skips synth on both tools, so `time real` reflects deploy
# phase only.
LEFT_CMD="echo '\$ time cdkd deploy CdkdDemoCdkd -a cdk.out'; echo; $ENV time cdkd deploy CdkdDemoCdkd -a cdk.out"
RIGHT_CMD="echo '\$ time cdk deploy CdkdDemoCdk -a cdk.out'; echo; $ENV time $CDK_BIN deploy CdkdDemoCdk -a cdk.out"

tmux -f "$CONF" new-session  -d -s demo -x 220 -y 40 "bash -c \"$LEFT_CMD; sleep 9999\""
tmux select-pane -t demo:0.0 -T '#[fg=#a6e3a1,bold]  cdkd ─  cdkd deploy '
tmux split-window -h -t demo:0.0 "bash -c \"$RIGHT_CMD; sleep 9999\""
tmux select-pane -t demo:0.1 -T '#[fg=#f38ba8,bold]  CFn  ─  cdk deploy '
tmux attach -t demo
