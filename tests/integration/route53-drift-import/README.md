# Route 53 drift and import

A public hosted zone with simple, wildcard and weighted records and a record
set group, exercising what CloudFormation does not support for record sets:

- `cdkd drift` reports a record deleted out of band, a group missing a member,
  and a record switched to an alias (#6660).
- `cdkd drift --revert` restores the simple record and the group (#6661).
- `cdkd import` with no `--resource` adopts every record and the group against
  the zone it imports in the same run (#6662).

Note: creates a real hosted zone ($0.50/month if left running). `verify.sh`
destroys it and sweeps a leftover zone of the same name.

```bash
STATE_BUCKET=cdkd-state-<account> ./verify.sh
```
