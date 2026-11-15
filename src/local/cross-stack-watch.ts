/**
 * What a `--from-state` cross-stack resolver returned for ONE value, read
 * through the judged variants {@link producerSecretCheckOf} finds on it
 * (go-to-k/cdkd#6337, go-to-k/cdkd#6341). `cdkd local run-task`'s post-pass
 * and the env builders of `cdkd local invoke` / `invoke-agentcore` share it,
 * so each watches the same thing: a value that is the secret mask, and the
 * producer-secret verdict on the values read.
 */
import { SECRET_MASK } from '../deployment/secret-redaction.js';
import { defineOwnKey } from '../utils/own-keys.js';
import {
  producerSecretCheckOf,
  strongerJudgement,
  type Judgement,
  type JudgedValue,
  type ProducerSecretCheck,
} from './cross-stack-secrets.js';
import {
  substituteEnvVarsFromStateAsync,
  type CrossStackResolver,
  type StateEnvSubstitutionAudit,
  type SubstitutionContext,
} from './state-resolver.js';

/** What {@link watchResolved} saw the cross-stack resolver return. */
export interface ResolvedSeen {
  /** A value that is the secret mask. */
  masked: boolean;
  /** The producer-secret verdict on the values read, `secret` over the fail-closed ones. */
  producerSecret: Judgement | undefined;
}

/**
 * `context` with its cross-stack resolver noting each value it returns that is
 * the secret mask or that `producerSecrets` says holds a producer's secret.
 */
export function watchResolved(
  context: SubstitutionContext,
  producerSecrets: ProducerSecretCheck | undefined
): { context: SubstitutionContext; seen: ResolvedSeen } {
  const seen: ResolvedSeen = { masked: false, producerSecret: undefined };
  const inner = context.crossStackResolver;
  if (!inner) return { context, seen };
  const watch = ({ value, verdict, source, detail }: JudgedValue): string | undefined => {
    if (value === undefined) return value;
    if (value === SECRET_MASK) seen.masked = true;
    // `secret` outranks the fail-closed verdicts when one element reads several values.
    seen.producerSecret = strongerJudgement(
      seen.producerSecret,
      verdict === undefined ? undefined : { verdict, source, detail }
    );
    return value;
  };
  // The judged variants when the resolver carries them: each call's verdict is
  // its own producer's, never another call's for an equal value.
  const resolver: CrossStackResolver = producerSecrets
    ? {
        resolveImport: async (exportName) =>
          watch(await producerSecrets.resolveImportJudged(exportName)),
        resolveGetStackOutput: async (stack, region, output) =>
          watch(await producerSecrets.resolveGetStackOutputJudged(stack, region, output)),
      }
    : {
        resolveImport: async (exportName) =>
          watch({ value: await inner.resolveImport(exportName) }),
        resolveGetStackOutput: async (stack, region, output) =>
          watch({ value: await inner.resolveGetStackOutput(stack, region, output) }),
      };
  return { context: { ...context, crossStackResolver: resolver }, seen };
}

/**
 * cdk-local's `substituteEnvVarsFromStateAsync`, with a producer stack's
 * secret kept off the `docker run` argv (go-to-k/cdkd#6341): when the context's
 * resolver carries the judged variants, each key is substituted on its own
 * behind {@link watchResolved}, and a key whose values drew a verdict
 * (`secret`, or the fail-closed `unreadable` / `stale`) joins
 * `audit.sensitiveKeys`. The value still resolves; the caller passes those
 * keys value-less (`-e KEY`), as it does a decrypted SecureString.
 *
 * A cdk-local carrying go-to-k/cdk-local#982 does the same check inside
 * `substituteEnvVarsFromStateAsync`. It never runs twice here: the resolver
 * cdk-local is handed is the watcher's, which carries no judged variants, so
 * cdk-local sees an unjudged resolver and each value is judged once, by cdkd.
 * Its `--from-cfn-stack` resolver carries the same two method names, so that
 * resolver is judged here too, the same way.
 */
export async function substituteEnvVarsJudgedAsync(
  templateEnv: Record<string, unknown> | undefined,
  context: SubstitutionContext
): Promise<{ env: Record<string, unknown>; audit: StateEnvSubstitutionAudit }> {
  const producerSecrets = producerSecretCheckOf(context.crossStackResolver);
  if (!producerSecrets || !templateEnv) {
    return substituteEnvVarsFromStateAsync(templateEnv, context);
  }
  const env: Record<string, unknown> = {};
  const audit: StateEnvSubstitutionAudit = { resolvedKeys: [], unresolved: [], sensitiveKeys: [] };
  for (const [key, value] of Object.entries(templateEnv)) {
    const watched = watchResolved(context, producerSecrets);
    const one: Record<string, unknown> = {};
    defineOwnKey(one, key, value);
    const sub = await substituteEnvVarsFromStateAsync(one, watched.context);
    for (const [k, v] of Object.entries(sub.env)) defineOwnKey(env, k, v);
    audit.resolvedKeys.push(...sub.audit.resolvedKeys);
    audit.unresolved.push(...sub.audit.unresolved);
    audit.sensitiveKeys.push(...sub.audit.sensitiveKeys);
    // Only a key that resolved: an unresolved one is dropped, never passed.
    if (
      watched.seen.producerSecret !== undefined &&
      sub.audit.resolvedKeys.includes(key) &&
      !audit.sensitiveKeys.includes(key)
    ) {
      audit.sensitiveKeys.push(key);
    }
  }
  return { env, audit };
}
