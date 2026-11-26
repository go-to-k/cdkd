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
   * Whether a pending CA certificate holds the change: only when the template
   * declares `CertificateRotationRestart: true`, as CloudFormation's
   * `isCaCertificateChangesApplied` counts it (`instanceHasPendingChanges`).
   * Without a restart, an engine that cannot rotate in place keeps the
   * certificate pending until the next reboot.
   */
  readonly caRotationRestarts?: boolean;
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
  if (instanceValueChanged(properties, previousProperties, 'Port', context)) {
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
    (instance?.Endpoint?.Port !== changes.port || pending?.Port !== undefined)
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

/** A CA certificate identifier as RDS compares it (it stores the name lower-cased). */
function sameCertificate(live: string | undefined, sent: string): boolean {
  return live !== undefined && live.toLowerCase() === sent.toLowerCase();
}

/**
 * `attributes` without the keys an unapplied change moves: a value read
 * before RDS applied the change is the old one, so it is left ABSENT rather
 * than recorded stale. A reference to it in this deploy then waits for the
 * change (the deferred readiness `updateDBInstance` reports) and reads the
 * instance again; a later deploy re-reads it.
 */
export function withoutUnappliedMovedAttributes(
  attributes: Record<string, unknown>,
  unapplied: readonly MovedChange[]
): Record<string, unknown> {
  if (unapplied.length === 0) return attributes;
  const dropped = new Set<string>(unapplied.flatMap((change) => MOVED_KEYS[change]));
  return Object.fromEntries(Object.entries(attributes).filter(([key]) => !dropped.has(key)));
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
