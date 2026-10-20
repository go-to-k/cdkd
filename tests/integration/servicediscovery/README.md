# servicediscovery integration test

Exercises the issue #609 backfill of
`AWS::ServiceDiscovery::Service.ServiceAttributes` — a key->value map applied
via the post-create `UpdateServiceAttributes` control-plane call (not accepted
by `CreateService`).

Stack: a bare VPC, an `AWS::ServiceDiscovery::PrivateDnsNamespace`, and an
`AWS::ServiceDiscovery::Service` (L1 `CfnService`) carrying
`serviceAttributes: { team: 'cdkd', tier: 'backend' }` and a `description`,
plus three more services for issue #1160: `cdkd-svcdisc-ttl` and
`cdkd-svcdisc-refused` in the private namespace, and `cdkd-svcdisc-hc` (with a
`healthCheckConfig`) in an `AWS::ServiceDiscovery::PublicDnsNamespace`, since a
Route 53 health check is only accepted there.

`verify.sh` deploys, asserts the attributes reached AWS via
`get-service-attributes`, then runs three cumulative issue #1160 removal
phases (`CDKD_TEST_REMOVAL=kept`, `combined`, `refused`) that follow the
CloudFormation A/Bs on the issue:

- `kept`: a `description` removed on its own, and one removed beside a
  DnsRecords TTL change, are both still on the service; the TTL change is
  applied (CloudFormation drops a DnsRecords-only change; cdkd applies it on
  purpose).
- `combined`: a `description` removed beside a `healthCheckConfig` change is
  cleared, and a `dnsConfig` removed on its own is kept.
- `refused`: a `dnsConfig` removed beside a `description` change is refused by
  AWS (`Service dns config cannot be null`), as it is for CloudFormation, and
  the service is unchanged.

Then it destroys and confirms a clean teardown.

Run via the repo skill: `/run-integ servicediscovery`.
