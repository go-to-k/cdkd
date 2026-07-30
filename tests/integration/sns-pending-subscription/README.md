# sns-pending-subscription

Integration test for issue [#1301](https://github.com/go-to-k/cdkd/issues/1301):
`cdkd destroy` must not get stuck on an `AWS::SNS::Subscription` that is still
in `PendingConfirmation` state.

## Scenario

An email subscription to `cdkd-integ-nobody@example.com` is never confirmed
(example.com is an RFC 2606 reserved domain), so it stays in
`PendingConfirmation` forever. SNS rejects `Unsubscribe` on any pending
subscription ("Cannot unsubscribe a subscription that is pending
confirmation"), and no API can remove it — the record auto-expires after
~3 days. CloudFormation handles stack deletion by skipping the pending
subscription and reporting success; cdkd must do the same.

## Phases

1. **Deploy**: topic + email subscription; assert the subscription is listed
   as `PendingConfirmation`.
2. **Destroy**: `cdkd destroy --force` must exit 0 (before the fix it failed
   with `PartialFailureError` and every retry failed the same way — the only
   escape was `cdkd state orphan`).
3. **Leak check**: topic gone, state.json gone. The pending subscription
   record itself may remain visible in `list-subscriptions` for up to 3 days —
   that is an AWS-side zombie nobody can delete (CloudFormation leaves it
   too), NOT an orphan resource; the leak assertions deliberately ignore it.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
