import { isDeepStrictEqual } from 'node:util';
import type { JsonPatchOp } from './json-patch-generator.js';

const API_TYPE = 'AWS::ApiGatewayV2::Api';

/** The properties that import an OpenAPI definition. */
const DEFINITION_KEYS = ['Body', 'BodyS3Location'] as const;

/** Every property only the import reads: the definition and its options. */
const IMPORT_KEYS = [...DEFINITION_KEYS, 'BasePath', 'FailOnWarnings'] as const;

/** What an update of an imported API sends to `ReimportApi`. */
export interface ApiGatewayV2Reimport {
  /** The desired `Body`, as `ReimportApi` takes it: the definition's text. */
  body: string | undefined;
  /** True when the desired properties import from `BodyS3Location`. */
  fromS3: boolean;
  basePath: string | undefined;
  failOnWarnings: boolean | undefined;
}

/**
 * Whether `desired` describes an `AWS::ApiGatewayV2::Api` that imports an
 * OpenAPI definition (`Body` or `BodyS3Location`).
 */
export function isApiGatewayV2Import(
  resourceType: string,
  desired: Record<string, unknown>
): boolean {
  return (
    resourceType === API_TYPE &&
    DEFINITION_KEYS.some((key) => Object.prototype.hasOwnProperty.call(desired, key))
  );
}

/**
 * Split a Cloud Control update patch for an `AWS::ApiGatewayV2::Api` that
 * imports an OpenAPI definition (go-to-k/cdkd#5260).
 *
 * No Cloud Control patch can change such an API's definition. Cloud Control
 * applies the patch to the model its read handler returns, which carries
 * `Name`, `ProtocolType` and four more keys, and API Gateway refuses them
 * beside `Body` ("Redundant fields [...] provided when either Body or
 * BodyS3Location is not empty"). Removing them in the patch does not help:
 * Cloud Control refuses a `remove /ProtocolType` ("createOnlyProperties
 * [/properties/ProtocolType] cannot be updated"), and the handler puts
 * `ProtocolType` back from its own read when the remove is left out. Both
 * were measured live. CloudFormation hands the handler the template's own
 * model, so the same template change succeeds there.
 *
 * So the import's own properties ({@link IMPORT_KEYS}) leave the patch, and
 * the caller sends a change to any of them through `ReimportApi`, the call
 * the import path is built on. `rest` is what Cloud Control may still apply:
 * the read model holds no `Body`, so its handler takes the ordinary update
 * path for a `Description` or `Tags` change. Every `add` the write-only
 * re-add put on an import key leaves too, unchanged or not, since it alone
 * would draw the same refusal.
 *
 * `reimport` is set when an import key's value differs between `previous`
 * and `desired`. A reimport of a definition holding `info.description`
 * OVERWRITES the API's `Description` (one without it keeps the description;
 * measured live), so when the template declares `Description` and the patch
 * has no op on it, `rest` re-sends it with an `add` (RFC 6902 `add` replaces
 * an existing member), keeping the declared value as CloudFormation does.
 */
export function splitApiGatewayV2ImportPatch(
  patch: JsonPatchOp[],
  previous: Record<string, unknown>,
  desired: Record<string, unknown>
): { rest: JsonPatchOp[]; reimport: ApiGatewayV2Reimport | undefined } {
  const importPaths = new Set<string>(IMPORT_KEYS.map((key) => `/${key}`));
  // The generator emits top-level ops only (`json-patch-generator.ts`).
  const rest = patch.filter((op) => !importPaths.has(op.path));
  const changed = IMPORT_KEYS.some((key) => !isDeepStrictEqual(previous[key], desired[key]));
  if (!changed) return { rest, reimport: undefined };
  if (
    Object.prototype.hasOwnProperty.call(desired, 'Description') &&
    !rest.some((op) => op.path === '/Description')
  ) {
    rest.push({ op: 'add', path: '/Description', value: desired['Description'] });
  }
  const body = desired['Body'];
  const basePath = desired['BasePath'];
  const failOnWarnings = desired['FailOnWarnings'];
  return {
    rest,
    reimport: {
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      fromS3: Object.prototype.hasOwnProperty.call(desired, 'BodyS3Location'),
      basePath: typeof basePath === 'string' ? basePath : undefined,
      // A template may spell a Boolean as a string, as CloudFormation accepts.
      failOnWarnings:
        failOnWarnings === true || failOnWarnings === 'true'
          ? true
          : failOnWarnings === false || failOnWarnings === 'false'
            ? false
            : undefined,
    },
  };
}
