import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as healthimaging from 'aws-cdk-lib/aws-healthimaging';

/**
 * One HealthImaging data store, the subject of the stateful guard on the deploy
 * engine's UPDATE-FAILURE fallback (issue #2515).
 *
 *   covers: AWS::HealthImaging::Datastore
 *
 * The type is `ProvisioningType: IMMUTABLE`: Cloud Control has create / read /
 * delete handlers and no update handler, and every writable property —
 * `Tags` included — is create-only in its registry schema. It is in
 * `STATEFUL_TYPES`, has no SDK provider, no `ReplacementRulesRegistry` rule and
 * no entry in cdkd's committed create-only snapshot.
 *
 * Phase 2 (CDKD_TEST_UPDATE=true) changes ONE tag value. With
 * `cloudformation:DescribeType` available that is a create-only change and
 * takes the property-driven replacement guard; with it denied, the lookup
 * falls back to `[]`, the change goes to Cloud Control as an in-place UPDATE,
 * Cloud Control answers `UnsupportedActionException`, and the update-failure
 * guard is the one that must refuse. verify.sh drives both identities.
 *
 * `DatastoreName` is fixed so verify.sh can find and sweep the data store; a
 * CFn L1 carries no DeletionPolicy, so destroy deletes it.
 */
export class HealthImagingStatefulUpdateFallbackStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env.CDKD_TEST_UPDATE === 'true' ? 'updated' : 'baseline';
    new healthimaging.CfnDatastore(this, 'Datastore', {
      datastoreName: 'cdkd-integ-healthimaging-stateful-fallback',
      tags: { phase },
    });
  }
}
