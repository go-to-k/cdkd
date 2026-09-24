- **`cdkd import --migrate-from-cloudformation` now adopts a CDK VPC completely (issue [#3661](https://github.com/go-to-k/cdkd/issues/3661))** -- `src/provisioning/providers/ec2-provider.ts` (`import()` / `verifyExplicit`), `tests/unit/provisioning/ec2-migrate-import-ids.test.ts`, and the new `tests/integration/import-migrate-vpc/` fixture. `EC2Provider.import()` returned nothing for these types:

  - route tables and routes;
  - internet gateways and their VPC attachments;
  - network ACLs and their entries;
  - subnet route-table / network-ACL associations;
  - instances.

  So a migration reported them as `no matching AWS resource` and retired the CloudFormation stack with them still running. The next `cdkd deploy` created the route tables a second time and failed on the conflicting associations, and `cdkd destroy` could not delete the VPC they held. Each type now accepts CloudFormation's physical id, verifies it against AWS, and records cdkd's own form with the attributes `create()` records. CloudFormation's ids for these types were measured live and are recorded on the issue. A VPC gateway attachment (`IGW|<vpcId>` in CloudFormation) and a network ACL entry (a generated name) are rebuilt from the template's properties. Malformed ids are declined without an AWS call instead of aborting the import. Measured live: a CDK `ec2.Vpc` with a NAT gateway, a custom network ACL and an instance imports as `30 imported, 0 not found`, and the following deploy changes nothing. Before this fix the same stack imported as `10 imported, 20 not found`.
