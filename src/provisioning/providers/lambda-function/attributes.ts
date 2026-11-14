import type { FunctionConfiguration } from '@aws-sdk/client-lambda';
import { definedAttributes } from '../../attribute-map.js';

/**
 * The `Fn::GetAtt` attributes a Lambda function records, from a
 * `CreateFunction` response or a `GetFunction` `Configuration`: create,
 * update and `import()` all build it here, so the key sets cannot drift
 * apart — `attributes` REPLACES the record on update.
 *
 * go-to-k/cdkd#6242: `SnapStartResponse` is recorded as ONE nested object,
 * which serves the whole attribute and, through the resolver's dotted walk,
 * `SnapStartResponse.ApplyOn` / `.OptimizationStatus` from the same value.
 * CloudFormation answers `{"ApplyOn": "None", "OptimizationStatus": "Off"}`
 * for a function without SnapStart (measured us-east-1, 2026-11-14), which is
 * what Lambda reports; a response without `SnapStart` leaves it ABSENT.
 */
export function functionAttributes(
  configuration: FunctionConfiguration | undefined
): Record<string, unknown> {
  const snapStart = configuration?.SnapStart;
  const snapStartResponse =
    snapStart === undefined
      ? undefined
      : definedAttributes({
          ApplyOn: snapStart.ApplyOn,
          OptimizationStatus: snapStart.OptimizationStatus,
        });
  return definedAttributes({
    Arn: configuration?.FunctionArn,
    FunctionName: configuration?.FunctionName,
    SnapStartResponse:
      snapStartResponse && Object.keys(snapStartResponse).length > 0
        ? snapStartResponse
        : undefined,
  });
}
