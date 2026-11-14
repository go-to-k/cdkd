import { SSMClient } from '@aws-sdk/client-ssm';
import {
  collectSsmParameterRefs,
  resolveSsmParameters,
  type ResolvedSsmParameters,
} from 'cdk-local';
import type { AwsEmulatorWorkload } from 'cdk-local/internal';
import { TemplateParser } from '../analyzer/template-parser.js';
import { awsClientDefaults } from '../utils/aws-client-defaults.js';
import { canonicalizeRegion } from '../utils/aws-partition.js';
import { realAwsException } from './local-aws-wiring.js';
import type { LocalStateProvider } from './local-state-provider.js';
import type { SubstitutionContext } from './state-resolver.js';

/**
 * SSM-typed CloudFormation parameters for `--from-state` (go-to-k/cdkd#6307).
 *
 * `ssm.StringParameter.valueForStringParameter(this, '/name')` synthesizes a
 * template parameter of type `AWS::SSM::Parameter::Value<String>` whose
 * `Default` is the SSM name, and an env value `{ Ref: <that parameter> }`.
 * `cdkd deploy` resolves it at deploy time, but state.json records no
 * parameter values, so a local run has to read SSM itself — the same
 * `GetParameters` cdk-local's `--from-cfn-stack` provider issues, through the
 * same cdk-local helpers.
 *
 * The client is built the way `createCallerDynamicReferenceResolver` builds
 * its SSM client, because the value lands in the container just as a
 * `{{resolve:ssm:...}}` one does:
 *
 * - IDENTITY: the caller's (`ignoreAssumedRole`), never a `--role-arn` role —
 *   `.claude/rules/local-caller-identity.md`.
 * - ROUTE: `awsClientDefaults` sends it to AWS Emulator under `--aws-emulator`
 *   (the process-wide override); in mixed mode it goes to real AWS ONLY when a
 *   `"real-aws"` exception names `SSM` for `workload` (its own section, or
 *   `Parameters` when no workload is named). Never `runWithRealAws`: that
 *   would send it to real AWS for an exception naming any OTHER service.
 *
 * An unreadable parameter keeps its existing warn-and-drop: cdk-local's
 * `resolveSsmParameters` warns and leaves the logical id unresolved, and the
 * substitution then warns per env key.
 */
export async function resolveStateTemplateSsmParameters(
  template: Parameters<typeof collectSsmParameterRefs>[0],
  opts: {
    /** The stack's region (the state record's): where `cdkd deploy` read the parameter. */
    region: string | undefined;
    profile: string | undefined;
    workload: AwsEmulatorWorkload | undefined;
    /** What the warnings start with (`--from-state`). */
    label: string;
  }
): Promise<ResolvedSsmParameters> {
  // Only the parameters something consumes, as `cdkd deploy` resolves them:
  // every CDK stack declares `BootstrapVersion` (`/cdk-bootstrap/<q>/version`),
  // referenced by `Rules` alone and absent where cdkd bootstrapped, so reading
  // it warned on every run.
  const referenced = referencedParameterNames(template);
  const refs = collectSsmParameterRefs(template).filter((r) => referenced.has(r.logicalId));
  if (refs.length === 0) return { values: {}, secureStringLogicalIds: [] };
  const region = canonicalizeRegion(opts.region) || undefined;
  const realAws = realAwsException('SSM', opts.workload);
  const client = new SSMClient({
    ...awsClientDefaults({ profile: opts.profile, ignoreAssumedRole: true, realAws }),
    ...(region && { region }),
    ...(opts.profile && { profile: opts.profile }),
  });
  try {
    return await resolveSsmParameters(client, refs, opts.label);
  } finally {
    client.destroy();
  }
}

/**
 * The names a template's `Resources` / `Outputs` / `Conditions` reference —
 * the sections `cdkd deploy` evaluates (`collectReferencedParameterNames`),
 * so `Rules` and `Metadata` count for nothing.
 */
function referencedParameterNames(template: Record<string, unknown> | undefined): Set<string> {
  const parser = new TemplateParser();
  const out = new Set<string>();
  for (const section of [
    template?.['Resources'],
    template?.['Outputs'],
    template?.['Conditions'],
  ]) {
    if (!section || typeof section !== 'object') continue;
    for (const name of parser.extractReferences(section)) out.add(name);
  }
  return out;
}

/**
 * A provider's SSM-typed parameter values, in the two `SubstitutionContext`
 * keys that make a `Ref` to one resolve. Empty for a provider that resolves
 * none, so `Object.assign(subContext, ...)` is a no-op then.
 */
export async function templateSsmParameters(
  provider: Pick<LocalStateProvider, 'resolveTemplateSsmParameters'>,
  template: Parameters<typeof collectSsmParameterRefs>[0]
): Promise<Pick<SubstitutionContext, 'parameters' | 'sensitiveParameters'>> {
  if (!provider.resolveTemplateSsmParameters) return {};
  const ssm = await provider.resolveTemplateSsmParameters(template ?? {});
  return {
    ...(Object.keys(ssm.values).length > 0 && { parameters: ssm.values }),
    ...(ssm.secureStringLogicalIds.length > 0 && {
      sensitiveParameters: new Set(ssm.secureStringLogicalIds),
    }),
  };
}
