import {
  DescribeParametersCommand,
  GetParameterCommand,
  ListTagsForResourceCommand,
  ParameterNotFound,
} from '@aws-sdk/client-ssm';
import { normalizeAwsTagsToCfn } from '../../import-helpers.js';
import type { ResourceNotFound } from '../../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../../types/resource.js';
import type { SSMParameterProvider } from '../ssm-parameter-provider.js';

/**
 * Read the AWS-current SSM parameter configuration in CFn-property shape.
 *
 * Issues `GetParameter` (with `WithDecryption: false` so SecureString
 * values stay encrypted on the wire) for `Type` / `Value` / `DataType`,
 * then `DescribeParameters` filtered on the parameter name to fetch
 * metadata (`Description`, `AllowedPattern`, `Tier`) that `GetParameter`
 * does not return.
 *
 * `Name` is set to the physical id. `Tags` is surfaced via a follow-up
 * `ListTagsForResource(ResourceType=Parameter)` call, with CDK's `aws:*`
 * auto-tags filtered out.
 *
 * `Policies` is surfaced from the same `DescribeParameters` response.
 * AWS returns `Parameters[0].Policies` as
 * `[{PolicyText, PolicyType, PolicyStatus}]`; cdkd state holds a JSON
 * string of the user-templated policy array (CFn's documented shape).
 * To compare cleanly we parse each `PolicyText` (itself JSON) into
 * objects, drop the AWS-managed `PolicyStatus` (Pending / InSync /
 * Expired), and emit the parsed object array. On the v3
 * `observedProperties` baseline this matches `observedProperties` (which
 * stored our parsed output at deploy time) exactly. On the v2 fallback
 * baseline (state.properties = JSON string) the comparator reports a
 * one-time drift on first run; users resolve via
 * `cdkd state refresh-observed`. Always-emit `[]` placeholder for
 * console-side ADD detection.
 *
 * **Note**: For `SecureString` parameters, AWS returns the encrypted
 * blob in `Value` (we pass `WithDecryption: false`). cdkd state usually
 * holds the plaintext value the user typed in their CDK app, so a
 * SecureString parameter will surface as `Value` drift on every run.
 * That's the correct conservative behavior — surfacing the discrepancy
 * is more useful than silently masking it.
 *
 * Returns `RESOURCE_NOT_FOUND` when the parameter is gone (`ParameterNotFound`).
 */
export async function readCurrentState(
  this: SSMParameterProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let getResp: {
    Parameter?: { Type?: string; Value?: string; DataType?: string };
  };
  try {
    getResp = (await this.ssmClient.send(
      new GetParameterCommand({ Name: physicalId, WithDecryption: false })
    )) as unknown as typeof getResp;
  } catch (err) {
    if (err instanceof ParameterNotFound) return RESOURCE_NOT_FOUND;
    throw err;
  }
  const param = getResp.Parameter;
  if (!param) return undefined;

  const result: Record<string, unknown> = { Name: physicalId };
  if (param.Type !== undefined) result['Type'] = param.Type;
  if (param.Value !== undefined) result['Value'] = param.Value;
  if (param.DataType !== undefined) result['DataType'] = param.DataType;

  // Fetch metadata via DescribeParameters filtered on the name. Best-effort:
  // a missing-permission error here should not fail the snapshot — we just
  // omit the metadata keys.
  let policiesEmitted = false;
  try {
    const desc = await this.ssmClient.send(
      new DescribeParametersCommand({
        ParameterFilters: [{ Key: 'Name', Values: [physicalId] }],
      })
    );
    const meta = desc.Parameters?.[0];
    result['Description'] = meta?.Description ?? '';
    result['AllowedPattern'] = meta?.AllowedPattern ?? '';
    if (meta?.Tier !== undefined) {
      result['Tier'] = meta.Tier;
    }

    // Policies — AWS returns [{PolicyText, PolicyType, PolicyStatus}];
    // we parse PolicyText (JSON) and emit the parsed objects. PolicyStatus
    // is AWS-managed (Pending / InSync / Expired) and intentionally
    // dropped — it's not part of the user's templated input.
    const parsedPolicies: unknown[] = [];
    for (const p of meta?.Policies ?? []) {
      if (!p.PolicyText) continue;
      try {
        parsedPolicies.push(JSON.parse(p.PolicyText));
      } catch {
        parsedPolicies.push(p.PolicyText);
      }
    }
    result['Policies'] = parsedPolicies;
    policiesEmitted = true;
  } catch {
    // Ignore — Type / Value / DataType already captured above.
  }
  // Always-emit guard: if DescribeParameters failed entirely, surface
  // an empty Policies placeholder so a console-side ADD on a previously-
  // un-policy'd parameter still surfaces as drift on the v3
  // observedProperties baseline. The placeholder cannot be told from a read
  // of no policies, so `update` clears live policies on a revert only when
  // the template declares none too (go-to-k/cdkd#4884).
  if (!policiesEmitted) result['Policies'] = [];

  // Tags via ListTagsForResource (best-effort; missing tag permission is
  // tolerated by simply omitting the key).
  try {
    const tagsResp = await this.ssmClient.send(
      new ListTagsForResourceCommand({
        ResourceType: 'Parameter',
        ResourceId: physicalId,
      })
    );
    // AWS::SSM::Parameter.Tags is a key->value MAP in CFn (cdkd stores the
    // template's map shape in state), so emit the readback as a map too — an
    // array shape here would false-positive drift on every clean run for a
    // tagged parameter (state map vs observed list never compare equal).
    const tagArr = normalizeAwsTagsToCfn(tagsResp.TagList);
    result['Tags'] = Object.fromEntries(tagArr.map((t) => [t.Key, t.Value]));
  } catch {
    // Ignore — tag drift is best-effort.
  }

  return result;
}
