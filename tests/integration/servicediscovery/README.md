# servicediscovery integration test

Exercises the issue #609 backfill of
`AWS::ServiceDiscovery::Service.ServiceAttributes` — a key->value map applied
via the post-create `UpdateServiceAttributes` control-plane call (not accepted
by `CreateService`).

Stack: a bare VPC, an `AWS::ServiceDiscovery::PrivateDnsNamespace`, and an
`AWS::ServiceDiscovery::Service` (L1 `CfnService`) carrying
`serviceAttributes: { team: 'cdkd', tier: 'backend' }`.

`verify.sh` deploys, asserts the attributes reached AWS via
`get-service-attributes`, then destroys and confirms a clean teardown.

Run via the repo skill: `/run-integ servicediscovery`.
