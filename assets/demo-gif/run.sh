#!/usr/bin/env bash
# Side-by-side real recording: cdk deploy (left) vs cdkd deploy (right).
# Both deploy a 5-resource SDK-Provider stack (S3 / DDB / SQS / SNS / SSM).

set -e

CONF="$(dirname "$0")/tmux-clean.conf"

LEFT_CMD='echo "$ cdk deploy CdkdDemoCdk --require-approval never"; echo; time cdk deploy CdkdDemoCdk --require-approval never'
RIGHT_CMD='echo "$ cdkd deploy CdkdDemoCdkd"; echo; time cdkd deploy CdkdDemoCdkd --yes'

tmux -f "$CONF" new-session  -d -s demo -x 200 -y 40 "bash -c '$LEFT_CMD; sleep 9999'"
tmux select-pane -t demo:0.0 -T " cdk deploy "
tmux split-window -h -t demo:0.0 "bash -c '$RIGHT_CMD; sleep 9999'"
tmux select-pane -t demo:0.1 -T " cdkd deploy "
tmux attach -t demo
