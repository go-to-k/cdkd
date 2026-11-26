import type { DBInstance, ModifyDBInstanceCommandInput } from '@aws-sdk/client-rds';
import type { UpdateContext } from '../../../types/resource.js';
import { instanceValueChanged } from './instance-members.js';

/**
 * go-to-k/cdkd#7006: the changes of an in-place DB instance update that move
 * a recorded `Fn::GetAtt` attribute only once RDS has applied them. RDS
 * accepts the ModifyDBInstance and applies these afterwards (a port change
 * reboots the instance), so a read taken right after the call still reports
 * the old value, with the new one under `PendingModifiedValues`. Measured on
 * a MySQL db.t4g.micro (us-east-1): the port moved and left the pending
 * values after ~68 s, a CA certificate after ~65 s (with or without
 * `CertificateRotationRestart`), and a conversion to Multi-AZ named its
 * standby zone ~7 min after the call, a minute after it left the pending
 * values.
 */
export interface MovedAttributeChanges {
  /** The port sent, when the template changed it. */
  readonly port?: number;
  /** The CA certificate sent, when the template changed it. */
  readonly caIdentifier?: string;
  /**
   * Whether the CA certificate change holds the update: only when the template
   * declares `CertificateRotationRestart: true`, as CloudFormation's
   * `isCaCertificateChangesApplied` counts it (`instanceHasPendingChanges`).
   * Without a restart, an engine that cannot rotate in place keeps the OLD
   * certificate in use until the next reboot, so nothing waits for it, and
   * the certificate the instance reports (the one in use) is recorded as
   * read, as CloudFormation's GetAtt returns its live model.
   */
  readonly caRotationRestarts?: boolean;
  /**
   * Whether the instance's engine version rotates a certificate without a
   * restart (`DescribeDBEngineVersions.SupportsCertificateRotationWithoutRestart`),
   * read only for a CA change without `CertificateRotationRestart: true`
   * (`withCertificateRotationInPlace`). Such an engine switches the
   * identifier within seconds (measured: MySQL, ~7 s), so the update waits
   * for the switch, though not for the pending value.
   */
  readonly caRotatesInPlace?: boolean;
  /** The Multi-AZ setting sent, when the template changed it. */
  readonly multiAZ?: boolean;
}

/** A change that moves a recorded attribute late. */
export type MovedChange = 'port' | 'caIdentifier' | 'multiAZ';

/**
 * The attribute keys each change moves, as `dbInstanceAttributes` records
 * them (`IN_PLACE_UPDATE_ATTRS_MOVED_BY` lists the same pairs for the
 * readers).
 */
const MOVED_KEYS = {
  port: ['Endpoint.Port', 'ListenerEndpoint.Port'],
  caIdentifier: ['CertificateDetails.CAIdentifier', 'CertificateDetails.ValidTill'],
  multiAZ: ['SecondaryAvailabilityZone'],
} as const satisfies Record<MovedChange, readonly string[]>;

/**
 * What this update changes among the members that move a recorded attribute
 * late, or `undefined` when it changes none of them (the common update, which
 * then waits for nothing more). `Port` is sent on every update, so only a
 * changed one counts; the certificate and Multi-AZ members are sent only when
 * changed (`instanceModifyBackfillMembers`).
 */
export function movedAttributeChanges(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  backfillMembers: Partial<ModifyDBInstanceCommandInput>,
  context: UpdateContext | undefined
): MovedAttributeChanges | undefined {
  const changes: {
    port?: number;
    caIdentifier?: string;
    caRotationRestarts?: boolean;
    multiAZ?: boolean;
  } = {};
  // A cluster member's port is the cluster's (an Aurora instance takes its
  // port from `AWS::RDS::DBCluster`), so its own Port never moves it.
  const clusterMember =
    typeof properties['DBClusterIdentifier'] === 'string' &&
    properties['DBClusterIdentifier'] !== '';
  if (!clusterMember && instanceValueChanged(properties, previousProperties, 'Port', context)) {
    const port = Number(properties['Port']);
    if (Number.isInteger(port)) changes.port = port;
  }
  if (backfillMembers.CACertificateIdentifier !== undefined) {
    changes.caIdentifier = backfillMembers.CACertificateIdentifier;
    changes.caRotationRestarts = String(properties['CertificateRotationRestart']) === 'true';
  }
  if (backfillMembers.MultiAZ !== undefined) {
    changes.multiAZ = String(backfillMembers.MultiAZ) === 'true';
  }
  return Object.keys(changes).length > 0 ? changes : undefined;
}

/**
 * The changes `instance` does not report as applied yet: the live value is
 * not the one sent, or RDS still lists it as pending. Compared with the value
 * SENT, so a read taken before RDS has even registered the modification
 * counts as unapplied too.
 */
export function unappliedMovedChanges(
  changes: MovedAttributeChanges,
  instance: DBInstance | undefined
): MovedChange[] {
  const pending = instance?.PendingModifiedValues;
  const unapplied: MovedChange[] = [];
  if (
    changes.port !== undefined &&
    (instance?.Endpoint?.Port !== changes.port ||
      // An instance with a listener endpoint (SQL Server Multi-AZ) records
      // its port too.
      (instance?.ListenerEndpoint !== undefined &&
        instance.ListenerEndpoint.Port !== changes.port) ||
      pending?.Port !== undefined)
  ) {
    unapplied.push('port');
  }
  if (
    changes.caIdentifier !== undefined &&
    (!sameCertificate(instance?.CACertificateIdentifier, changes.caIdentifier) ||
      !sameCertificate(instance?.CertificateDetails?.CAIdentifier, changes.caIdentifier) ||
      (changes.caRotationRestarts === true && pending?.CACertificateIdentifier !== undefined))
  ) {
    unapplied.push('caIdentifier');
  }
  if (
    changes.multiAZ !== undefined &&
    (instance?.MultiAZ !== changes.multiAZ ||
      pending?.MultiAZ !== undefined ||
      // A conversion to Multi-AZ is done once RDS names the standby's zone
      // (measured: about a minute after it leaves the pending values, while
      // still `modifying`), or once the instance is `available` again, for a
      // configuration that names none.
      (changes.multiAZ &&
        instance?.SecondaryAvailabilityZone === undefined &&
        instance?.DBInstanceStatus !== 'available'))
  ) {
    unapplied.push('multiAZ');
  }
  return unapplied;
}

/**
 * The unapplied changes the update waits for: every one but a CA certificate
 * rotated without a restart by an engine that cannot rotate in place
 * (`MovedAttributeChanges.caRotationRestarts` / `caRotatesInPlace`).
 */
export function blockingMovedChanges(
  changes: MovedAttributeChanges,
  unapplied: readonly MovedChange[]
): MovedChange[] {
  return unapplied.filter(
    (change) =>
      change !== 'caIdentifier' ||
      changes.caRotationRestarts === true ||
      changes.caRotatesInPlace === true
  );
}

/** Whether any change the update makes is one it waits for (`blockingMovedChanges`). */
export function waitsForMovedChanges(changes: MovedAttributeChanges): boolean {
  return (
    changes.port !== undefined ||
    changes.multiAZ !== undefined ||
    (changes.caIdentifier !== undefined &&
      (changes.caRotationRestarts === true || changes.caRotatesInPlace === true))
  );
}

/** A CA certificate identifier as RDS compares it (it stores the name lower-cased). */
function sameCertificate(live: string | undefined, sent: string): boolean {
  return live !== undefined && live.toLowerCase() === sent.toLowerCase();
}

/**
 * `attributes` without the keys an unapplied change moves: a value read
 * before RDS applied the change is the old one, so it is left ABSENT rather
 * than recorded stale. A reference to it in this deploy then waits for the
 * change (the deferred readiness `updateDBInstance` reports, under
 * `--no-wait`); a later deploy re-reads it.
 */
export function withoutUnappliedMovedAttributes(
  attributes: Record<string, unknown>,
  unapplied: readonly MovedChange[]
): Record<string, unknown> {
  if (unapplied.length === 0) return attributes;
  const dropped = new Set<string>(unapplied.flatMap((change) => MOVED_KEYS[change]));
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !dropped.has(key)));
}

/**
 * go-to-k/cdkd#7015: the recorded attribute keys a modification RDS still
 * lists under `PendingModifiedValues` will move. A re-read of the instance
 * reports their CURRENT value, which the stale-attribute heal serves but must
 * not record as settled (`ResourceImportResult.pendingAttributeKeys`).
 */
export function pendingMovedAttributeKeys(instance: DBInstance | undefined): string[] {
  const pending = instance?.PendingModifiedValues;
  if (pending === undefined) return [];
  const changes: MovedChange[] = [];
  if (pending.Port !== undefined) changes.push('port');
  if (pending.CACertificateIdentifier !== undefined) changes.push('caIdentifier');
  if (pending.MultiAZ !== undefined) changes.push('multiAZ');
  return changes.flatMap((change) => MOVED_KEYS[change]);
}

/** The words a wait line names the changes by. */
export function movedChangesText(changes: MovedAttributeChanges): string {
  return [
    changes.port !== undefined ? 'port' : undefined,
    changes.caIdentifier !== undefined ? 'CA certificate' : undefined,
    changes.multiAZ !== undefined ? 'Multi-AZ' : undefined,
  ]
    .filter((word): word is string => word !== undefined)
    .join(', ')
    .concat(' change');
}

/**
 * `changes` with `caRotatesInPlace` read from the engine version, for a CA
 * change the template rotates without `CertificateRotationRestart: true`; any
 * other update makes no call. An unreadable answer (a failed read, a version
 * AWS does not list, no flag) leaves the change unwaited, recording the
 * certificate the instance reports, as CloudFormation does.
 */
export async function withCertificateRotationInPlace(
  changes: MovedAttributeChanges | undefined,
  engine: string | undefined,
  engineVersion: string | undefined,
  readSupport: (engine: string, engineVersion: string) => Promise<boolean | undefined>,
  onUnreadable: (error: unknown) => void
): Promise<MovedAttributeChanges | undefined> {
  if (
    changes?.caIdentifier === undefined ||
    changes.caRotationRestarts === true ||
    engine === undefined ||
    engine === '' ||
    engineVersion === undefined ||
    engineVersion === ''
  ) {
    return changes;
  }
  const supports = await readSupport(engine, engineVersion).catch((error: unknown) => {
    onUnreadable(error);
    return undefined;
  });
  return supports === true ? { ...changes, caRotatesInPlace: true } : changes;
}
