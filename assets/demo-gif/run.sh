#!/usr/bin/env bash
# Side-by-side real recording: cdk deploy (left) vs cdkd deploy (right).
# Both deploy a 5-resource SDK-Provider stack (S3 / DDB / SQS / SNS / SSM).

set -e

CONF="$(dirname "$0")/tmux-clean.conf"

# FORCE_COLOR=1 makes cdkd's chalk emit ANSI colors even though tmux's
# pseudo-TTY would otherwise be detected as non-color. cdk already colors
# unconditionally. COLORTERM=truecolor lets both emit 24-bit colors.
ENV='FORCE_COLOR=1 COLORTERM=truecolor'

# The echoed line MUST mention `time` so the trailing real/user/sys block
# at the end of each pane matches what the viewer saw being typed.
LEFT_CMD="echo '\$ time cdk deploy CdkdDemoCdk --require-approval never'; echo; $ENV time cdk deploy CdkdDemoCdk --require-approval never"
RIGHT_CMD="echo '\$ time cdkd deploy CdkdDemoCdkd'; echo; $ENV time cdkd deploy CdkdDemoCdkd --yes"

tmux -f "$CONF" new-session  -d -s demo -x 220 -y 40 "bash -c \"$LEFT_CMD; sleep 9999\""
tmux select-pane -t demo:0.0 -T '#[fg=#f38ba8,bold]  CFn  ─  cdk deploy '
tmux split-window -h -t demo:0.0 "bash -c \"$RIGHT_CMD; sleep 9999\""
tmux select-pane -t demo:0.1 -T '#[fg=#a6e3a1,bold]  cdkd ─  cdkd deploy '
tmux attach -t demo
