import type { JwtConfiguration, JwtConfigurationInput } from '@aws-sdk/client-api-gateway';

/**
 * `AWS::ApiGateway::Authorizer` `JwtConfiguration` (a `JWT` authorizer,
 * go-to-k/cdkd#6690) between the CFn and SDK spellings.
 *
 * Measured us-east-1, 2026-11-21: `UpdateAuthorizer` takes the block only as a
 * whole-object `replace /jwtConfiguration` whose value is the SDK-shaped JSON
 * (a child path is refused), refuses `remove /jwtConfiguration`, and drops it
 * by itself when `/type` leaves `JWT`. `GetAuthorizer` adds a read-only
 * `jwksUri` per issuer, which CloudFormation does not model.
 */
export function toSdkJwtConfiguration(value: unknown): JwtConfigurationInput | undefined {
  if (value === undefined || value === null) return undefined;
  // Anything but an object is CloudFormation's to refuse; send it as given.
  if (!isRecord(value)) return value as JwtConfigurationInput;
  return {
    issuers: mapList(value['Issuers'], (issuer) => ({
      issuer: issuer['Issuer'],
      audiences: issuer['Audiences'],
      ...(issuer['AdditionalClaims'] !== undefined && {
        additionalClaims: mapList(issuer['AdditionalClaims'], (claim) => ({
          claimName: claim['ClaimName'],
          format: claim['Format'],
          ...(claim['Required'] !== undefined && { required: claim['Required'] }),
          ...(claim['ExpectedValues'] !== undefined && { expectedValues: claim['ExpectedValues'] }),
        })),
      }),
    })),
    defaultAlgorithms: value['DefaultAlgorithms'],
  } as JwtConfigurationInput;
}

/** The CFn spelling of what `GetAuthorizer` reports, `jwksUri` left out. */
export function fromSdkJwtConfiguration(config: JwtConfiguration): Record<string, unknown> {
  return {
    Issuers: (config.issuers ?? []).map((issuer) => ({
      Issuer: issuer.issuer,
      Audiences: issuer.audiences ?? [],
      ...(issuer.additionalClaims !== undefined && {
        AdditionalClaims: issuer.additionalClaims.map((claim) => ({
          ClaimName: claim.claimName,
          Format: claim.format,
          ...(claim.required !== undefined && { Required: claim.required }),
          ...(claim.expectedValues !== undefined && { ExpectedValues: claim.expectedValues }),
        })),
      }),
    })),
    DefaultAlgorithms: config.defaultAlgorithms ?? [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mapList(
  value: unknown,
  map: (item: Record<string, unknown>) => Record<string, unknown>
): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => (isRecord(item) ? map(item) : item));
}
