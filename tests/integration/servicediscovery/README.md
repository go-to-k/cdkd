# servicediscovery integration test

Exercises the issue #609 backfill of
`AWS::ServiceDiscovery::Service.ServiceAttributes` — a key->value map applied
via the post-create `UpdateServiceAttributes` control-plane call (not accepted
by `CreateService`).

Stack: a bare VPC, an `AWS::ServiceDiscovery::PrivateDnsNamespace`, and an
`AWS::ServiceDiscovery::Service` (L1 `CfnService`) carrying
`serviceAttributes: { team: 'cdkd', tier: 'backend' }` and a `description`,
plus five more services for issue #1160: `cdkd-svcdisc-ttl`,
`cdkd-svcdisc-dns-kept` and `cdkd-svcdisc-refused` in the private namespace,
and `cdkd-svcdisc-hc` and `cdkd-svcdisc-hc-kept` (with a `healthCheckConfig`)
in an `AWS::ServiceDiscovery::PublicDnsNamespace`, since a Route 53 health
check is only accepted there.

A `NamelessService` declares no `name` (go-to-k/cdkd#5348): the deploy must
create it under the generated `ServiceDiscoveryStack-NamelessService-<12 hex>`,
and every later phase must keep that name and service.

`verify.sh` deploys, asserts the attributes reached AWS via
`get-service-attributes`, then runs three cumulative issue #1160 removal
phases (`CDKD_TEST_REMOVAL=kept`, `combined`, `refused`) that follow the
CloudFormation A/Bs on the issue:

- `kept`: a `description` removed on its own, a `dnsConfig` and a
  `healthCheckConfig` each removed beside an unchanged declared `description`,
  and a `description` removed beside a DnsRecords TTL change are all still on
  the service; the TTL change is applied (CloudFormation drops a
  DnsRecords-only change; cdkd applies it on purpose). Also in this phase,
  `cdkd-svcdisc-pinned-dns` moves its `dnsConfig.namespaceId` to the public
  namespace and switches `dnsConfig.routingPolicy` from `MULTIVALUE` to
  `WEIGHTED` (go-to-k/cdkd#5373). `UpdateService` cannot change either, and
  CloudFormation finishes the update without applying them, so the service
  keeps its id, namespace and policy. The deploy must warn that both changes
  were not applied.
- `combined`: a `description` removed beside a `healthCheckConfig` change is
  cleared.
- `refused`: a `dnsConfig` removed beside a `description` change is refused by
  AWS (`Service dns config cannot be null`), as it is for CloudFormation, and
  the service is unchanged.

Then it destroys and confirms a clean teardown.

Run via the repo skill: `/run-integ servicediscovery`.
