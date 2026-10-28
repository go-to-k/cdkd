# EC2 SecurityGroup inline SourceSecurityGroupName

Integ probe for issue #5478: an inline `AWS::EC2::SecurityGroup` ingress rule
that names its peer with `SourceSecurityGroupName`. The member reaches only a
default-VPC group, so the three groups here set no `VpcId`, and `verify.sh`
prints a SKIP line when the region has no default VPC.

- Phase 1: `Main`'s tcp/443 ingress names `cdkd-integ-sgname-peer-a`; the live
  rule must peer with that group's id.
- Phase 2 (`CDKD_TEST_UPDATE=true`): the rule names `cdkd-integ-sgname-peer-b`;
  `Main` keeps its id and the rule peers with peer B only.
- Phase 3: destroy; the groups and the state file are gone.

```bash
STATE_BUCKET=cdkd-state-<account> ./verify.sh
```
