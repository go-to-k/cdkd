# servicediscovery integration test

Exercises the issue #609 backfill of
`AWS::ServiceDiscovery::Service.ServiceAttributes` — a key->value map applied
via the post-create `UpdateServiceAttributes` control-plane call (not accepted
by `CreateService`).

Stack: a bare VPC, an `AWS::ServiceDiscovery::PrivateDnsNamespace`, and an
`AWS::ServiceDiscovery::Service` (L1 `CfnService`) carrying
`serviceAttributes: { team: 'cdkd', tier: 'backend' }` and a `description`,
plus a second service (`cdkd-svcdisc-dns-kept`) with a `description` and a
`dnsConfig` (A record, TTL 90).

`verify.sh` deploys, asserts the attributes reached AWS via
`get-service-attributes`, then runs two issue #1160 removal phases
(`CDKD_TEST_REMOVAL=description`, then `=dns`): the first service drops its
`description`, then the second drops its `dnsConfig`. CloudFormation keeps a
removed value on the service, so each phase asserts it is still there
(`get-service`) and that the service was updated in place. Then it destroys
and confirms a clean teardown.

Run via the repo skill: `/run-integ servicediscovery`.
