import { displayIdent, safeMsg } from '../../../utils/display-safe.js';
import { getLogger } from '../../../utils/logger.js';
import { isSsmParameterType, rootParameterValues, type SsmParameterReader } from './parameters.js';
import { quotedOrNotShown, quotedRegion, recordValueOrNotShown } from './render.js';

/**
 * An SSM-typed root template Parameter whose SSM parameter does not exist
 * (go-to-k/cdkd#6410).
 */
export interface MissingSsmParameter {
  parameterKey: string;
  ssmName: string;
}

/** The SSM path CDK's default synthesizer gives `BootstrapVersion`; group 1 is the qualifier. */
const CDK_BOOTSTRAP_VERSION_PATH = /^\/cdk-bootstrap\/([A-Za-z0-9_-]+)\/version$/;
const DEFAULT_CDK_QUALIFIER = 'hnb659fds';

/**
 * The root template's SSM-typed Parameters (`AWS::SSM::Parameter::Value<...>`)
 * whose SSM parameter does not exist (go-to-k/cdkd#6410). CloudFormation
 * resolves each one when it CREATES the IMPORT changeset, so a missing one
 * fails the export after the plan printed clean; `cdkd deploy` never resolves
 * `BootstrapVersion`, so a stack deployed without `cdk bootstrap` gets that
 * far. Each Parameter is checked at the name the changeset submits:
 * `--parameter` first, then the `Default`.
 *
 * Only `ParameterNotFound` counts as missing. Any other failure (a denied
 * read, throttling) is logged at debug and left to CloudFormation, which
 * reads the parameter with the same credentials: the check never refuses an
 * export it cannot prove would fail.
 */
export async function findMissingSsmParameters(
  template: Record<string, unknown>,
  parameterFlags: string[] | undefined,
  read: SsmParameterReader
): Promise<MissingSsmParameter[]> {
  const declared = template['Parameters'];
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) return [];
  const values = rootParameterValues(template, parameterFlags);
  const candidates: MissingSsmParameter[] = [];
  for (const [parameterKey, def] of Object.entries(declared as Record<string, unknown>)) {
    if (!def || typeof def !== 'object') continue;
    if (!isSsmParameterType((def as { Type?: unknown }).Type)) continue;
    const ssmName = values[parameterKey];
    if (typeof ssmName !== 'string' || ssmName === '') continue;
    candidates.push({ parameterKey, ssmName });
  }
  const logger = getLogger();
  const missing = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        await read(candidate.ssmName);
        return undefined;
      } catch (err) {
        const errName = err instanceof Error ? err.name : undefined;
        if (errName === 'ParameterNotFound') return candidate;
        // The error's NAME only: its message can quote the parameter name back.
        const key = quotedOrNotShown(candidate.parameterKey);
        const reason = errName === undefined ? 'an unknown error' : displayIdent(errName);
        logger.debug(
          safeMsg`SSM parameter of template parameter ${key} could not be read (${reason}); CloudFormation decides when it creates the changeset.`
        );
        return undefined;
      }
    })
  );
  return missing.filter((m): m is MissingSsmParameter => m !== undefined);
}

/** The refusal for {@link findMissingSsmParameters}' result; nothing has been changed yet. */
export function missingSsmParametersMessage(
  missing: readonly MissingSsmParameter[],
  region: string
): string {
  const lines = missing.map(({ parameterKey, ssmName }) => {
    const head = `  ${quotedOrNotShown(parameterKey)}: SSM parameter ${recordValueOrNotShown(ssmName)}`;
    const qualifier = CDK_BOOTSTRAP_VERSION_PATH.exec(ssmName)?.[1];
    if (qualifier !== undefined) {
      const withQualifier =
        qualifier === DEFAULT_CDK_QUALIFIER
          ? ''
          : ` with --qualifier ${quotedOrNotShown(qualifier)}`;
      return (
        `${head} is created by 'cdk bootstrap', which the exported stack's next ` +
        `'cdk deploy' needs too. Run it${withQualifier} for this account and region.`
      );
    }
    // The key goes into a flag only when it is a plain identifier.
    const key = quotedOrNotShown(parameterKey).startsWith("'") ? parameterKey : '<Key>';
    return `${head}: create it, or pass --parameter ${key}=<an existing SSM parameter name>.`;
  });
  return (
    `Refusing to export: CloudFormation reads the SSM parameter each template parameter below ` +
    `names when it creates the IMPORT changeset, and ${missing.length === 1 ? 'it does' : 'they do'} ` +
    `not exist in ${quotedRegion(region)}. Nothing was changed; re-run after:\n` +
    lines.join('\n')
  );
}
