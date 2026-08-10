# servicediscovery-namespaces integration test

Exercises the issue #1044 SDK providers for the two
`ProvisioningType: NON_PROVISIONABLE` Cloud Map namespace kinds that Cloud
Control cannot handle:

- `AWS::ServiceDiscovery::HttpNamespace`
- `AWS::ServiceDiscovery::PublicDnsNamespace`

Stack: one `CfnHttpNamespace` and one `CfnPublicDnsNamespace` (with a
`Properties.DnsProperties.SOA.TTL` passthrough and tags). The public DNS
namespace creates a public Route 53 hosted zone alongside the namespace
(cost is cents when destroyed promptly); its `HostedZoneId` attribute is
surfaced as a stack output to exercise the `Fn::GetAtt` path.

`verify.sh` deploys, asserts both namespaces exist (and the HTTP one has
`Type: HTTP`), asserts the hosted zone exists and the SOA TTL reached AWS,
asserts the `HostedZoneId` output resolved, then re-deploys with
`CDKD_TEST_REMOVAL=true` (issue #1160 servicediscovery batch) — dropping
both `Description`s and the public namespace's SOA TTL — and asserts the
provider mirrors CloudFormation's removal resets (Descriptions cleared via
the `''` sentinel, TTL back to the Cloud Map default 60; live CFn A/B
2026-08-11), in place (no replacement). Finally destroys and confirms both
namespaces AND the hosted zone are gone (zero orphans) plus a clean state
file removal.

Run via the repo skill: `/run-integ servicediscovery-namespaces`.
