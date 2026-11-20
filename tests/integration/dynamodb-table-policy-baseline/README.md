# DynamoDB Table ResourcePolicy baseline

Exercises `AWS::DynamoDB::Table` on the SDK route (Refs #6604). One
on-demand table with a resource policy; no items or traffic.

`verify.sh` creates the table with a resource policy, then redeploys with the
policy removed (`CDKD_TEST_REMOVAL=true`), then declares it again.
`GetResourcePolicy` lags each write by seconds, and before the fix the deploy
recorded the lagging answer: after the removal the observed baseline still
held the deleted policy, so `cdkd drift` reported it and `cdkd drift --revert`
would have re-granted it. After each phase the run requires the baseline to
hold a policy exactly when the template declares one, the live table to
settle to the same answer, and `cdkd drift --json` to report the table fully
compared and clean.

The table also carries a `Lag6609e` tag (Refs #6609). A fourth deploy changes
its value (`CDKD_TEST_TAG=v2`): `ListTagsOfResource` answers the previous tags
for seconds after `TagResource`, and before the fix the deploy recorded that
answer, so the run requires the observed baseline `Tags` to equal the new
value. It then tags the table out of band, requires `cdkd drift --json` to
report `Tags`, runs `cdkd drift --revert --yes`, and requires the declared tag
live again on the same table (`revert-identity.sh`'s identity proof, plus
`CreationDateTime` and the state physical id unchanged since before the tag
change) and a clean follow-up drift. It then destroys the stack and checks that the table and
state are gone.

Build the repository first. The maintainer runs this fixture via `/run-integ
dynamodb-table-policy-baseline`, with `STATE_BUCKET` and `AWS_REGION` set. It
deploys real AWS resources and is not run as part of the local unit checks.
