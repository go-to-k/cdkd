import type { DBCluster, DBInstance } from '@aws-sdk/client-rds';
import type { RDSProvider } from '../rds-provider.js';
import {
  waitForMemberAfterClusterChange,
  requireClusterWhileWaiting,
  waitForClusterPortApplied,
  waitForSecurityGroupsApplied,
  waitForClusterState,
  waitForClusterAvailable,
  waitForClusterDeleted,
  rebootForPendingParameterGroup,
  waitForInstanceState,
  waitForInstanceAvailable,
  waitForInstanceDeleted,
} from './waits.js';

/**
 * `RDSProvider`'s wait delegators, each a `return fn.call(this, ...)` into
 * `./waits.ts`. Split out so `../rds-provider.ts` stays under the src
 * file-size cap while keeping its `handledProperties` / `unhandledByDesign`
 * literals, which `scripts/gen-property-coverage.ts` reads from top-level
 * provider files only. The clients and `sleep` stay on `RDSProvider`:
 * `scripts/gen-update-wrap-coverage.ts` resolves `this.x()` among the class's
 * own members and companion functions, not inherited ones.
 */
export class RDSProviderBase {
  waitForMemberAfterClusterChange(
    this: RDSProvider,
    dbInstanceIdentifier: string,
    clusterLogicalId: string,
    transitional: ReadonlySet<string>,
    change: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForMemberAfterClusterChange.call(
      this,
      dbInstanceIdentifier,
      clusterLogicalId,
      transitional,
      change,
      maxWaitMs
    );
  }
  requireClusterWhileWaiting(
    this: RDSProvider,
    cluster: DBCluster | undefined,
    logicalId: string,
    change: string
  ): DBCluster {
    return requireClusterWhileWaiting.call(this, cluster, logicalId, change);
  }
  waitForClusterPortApplied(
    this: RDSProvider,
    dbClusterIdentifier: string,
    logicalId: string,
    port: number,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForClusterPortApplied.call(this, dbClusterIdentifier, logicalId, port, maxWaitMs);
  }
  waitForSecurityGroupsApplied(
    this: RDSProvider,
    dbClusterIdentifier: string,
    logicalId: string,
    expected: readonly string[],
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForSecurityGroupsApplied.call(
      this,
      dbClusterIdentifier,
      logicalId,
      expected,
      maxWaitMs
    );
  }
  waitForClusterState(
    this: RDSProvider,
    logicalId: string,
    dbClusterIdentifier: string,
    done: (cluster: DBCluster) => boolean,
    change: string,
    unboundedMaxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForClusterState.call(
      this,
      logicalId,
      dbClusterIdentifier,
      done,
      change,
      unboundedMaxWaitMs
    );
  }
  waitForClusterAvailable(
    this: RDSProvider,
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000,
    doing = 'being created'
  ): Promise<void> {
    return waitForClusterAvailable.call(this, logicalId, dbClusterIdentifier, maxWaitMs, doing);
  }
  waitForClusterDeleted(
    this: RDSProvider,
    logicalId: string,
    dbClusterIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForClusterDeleted.call(this, logicalId, dbClusterIdentifier, maxWaitMs);
  }
  rebootForPendingParameterGroup(
    this: RDSProvider,
    logicalId: string,
    physicalId: string,
    sentGroup: string | undefined,
    caRotationRestarts: boolean
  ): Promise<DBInstance> {
    return rebootForPendingParameterGroup.call(
      this,
      logicalId,
      physicalId,
      sentGroup,
      caRotationRestarts
    );
  }
  waitForInstanceState(
    this: RDSProvider,
    logicalId: string,
    dbInstanceIdentifier: string,
    done: (instance: DBInstance) => boolean,
    change: string
  ): Promise<DBInstance> {
    return waitForInstanceState.call(this, logicalId, dbInstanceIdentifier, done, change);
  }
  waitForInstanceAvailable(
    this: RDSProvider,
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000,
    doing = 'being created'
  ): Promise<void> {
    return waitForInstanceAvailable.call(this, logicalId, dbInstanceIdentifier, maxWaitMs, doing);
  }
  waitForInstanceDeleted(
    this: RDSProvider,
    logicalId: string,
    dbInstanceIdentifier: string,
    maxWaitMs = 1_800_000
  ): Promise<void> {
    return waitForInstanceDeleted.call(this, logicalId, dbInstanceIdentifier, maxWaitMs);
  }
}
