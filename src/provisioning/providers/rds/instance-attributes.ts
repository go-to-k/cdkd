import type { DBInstance } from '@aws-sdk/client-rds';
import { definedAttributes, stringifyIfAssigned } from '../../attribute-map.js';

/**
 * The `Fn::GetAtt` attributes an RDS DB instance records, from a
 * `DescribeDBInstances` / `CreateDBInstance` instance: every writer of the
 * record (create, update, `import()`) builds it here, so the key sets cannot
 * drift apart — `attributes` REPLACES the record on update.
 *
 * go-to-k/cdkd#6242: `DbiResourceId` (CDK's `instanceResourceId`, which
 * `grantConnect` builds its `rds-db:connect` ARN from), `Endpoint.HostedZoneId`,
 * `ListenerEndpoint.*` and `CertificateDetails.*` were never recorded, so a
 * reference resolved to the instance identifier. A value the response does not
 * carry (a listener endpoint on an instance with none, an endpoint while
 * `creating`) stays ABSENT, never `''`.
 */
export function dbInstanceAttributes(instance: DBInstance | undefined): Record<string, unknown> {
  return definedAttributes({
    'Endpoint.Address': instance?.Endpoint?.Address,
    'Endpoint.Port': stringifyIfAssigned(instance?.Endpoint?.Port),
    'Endpoint.HostedZoneId': instance?.Endpoint?.HostedZoneId,
    Arn: instance?.DBInstanceArn,
    DbiResourceId: instance?.DbiResourceId,
    'ListenerEndpoint.Address': instance?.ListenerEndpoint?.Address,
    'ListenerEndpoint.Port': stringifyIfAssigned(instance?.ListenerEndpoint?.Port),
    'ListenerEndpoint.HostedZoneId': instance?.ListenerEndpoint?.HostedZoneId,
    'CertificateDetails.CAIdentifier': instance?.CertificateDetails?.CAIdentifier,
    'CertificateDetails.ValidTill': javaInstantText(instance?.CertificateDetails?.ValidTill),
  });
}

/**
 * A timestamp as CloudFormation's Java handler renders an `Instant`
 * (`Instant.toString()`): ISO 8601 in UTC, the fraction only when non-zero.
 */
function javaInstantText(value: Date | undefined): string | undefined {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) return undefined;
  return value.toISOString().replace('.000Z', 'Z');
}
