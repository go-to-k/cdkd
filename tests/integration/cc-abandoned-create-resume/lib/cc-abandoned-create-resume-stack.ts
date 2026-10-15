import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

/**
 * go-to-k/cdkd#3252: a Cloud Control CREATE whose status polling cdkd
 * abandoned is re-polled by the next deploy or destroy. A deploy whose CREATE
 * would send the same properties takes the resource over; a destroy records
 * it as a resource the failed deploy created.
 *
 * covers: AWS::EC2::PrefixList
 *
 * `PrefixList` is on the Cloud Control route: no SDK provider is registered
 * for `AWS::EC2::PrefixList`, so it is created through `CreateResource` and
 * recorded `provisionedBy: 'cc-api'`. Its physical id is the `pl-...` id EC2
 * mints. It is free and created in seconds, and nothing else in the account
 * refers to it. Its properties do not change between deploys, so the
 * re-deploy after the abandoned CREATE would send exactly the bag that CREATE
 * sent: the condition for the takeover.
 *
 * `CCACR_SECOND=true` (verify.sh's step C) adds `PrefixList2` under its own
 * name, the second abandoned CREATE, which `cdkd destroy` settles. Once added
 * it stays in every later command of the run.
 *
 * No entries and no tags: the role verify.sh runs the abandoned deploys as is
 * granted only what the handler's create and read need.
 */
export class CcAbandonedCreateResumeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ec2.CfnPrefixList(this, 'PrefixList', {
      prefixListName: 'cdkd-ccacr',
      addressFamily: 'IPv4',
      maxEntries: 1,
    });

    if (process.env.CCACR_SECOND === 'true') {
      new ec2.CfnPrefixList(this, 'PrefixList2', {
        prefixListName: 'cdkd-ccacr-2',
        addressFamily: 'IPv4',
        maxEntries: 1,
      });
    }
  }
}
