import { SECRET_MASK } from '../../deployment/secret-redaction.js';
import { defineOwnKey } from '../../utils/own-keys.js';
import {
  producerSecretArgvReason,
  producerSecretCheckOf,
  producerSecretValueFromReason,
  strongerVerdict,
  type JudgedValue,
  type ProducerSecretCheck,
  type ProducerSecretVerdict,
} from '../cross-stack-secrets.js';
import {
  substituteAgainstStateAsync,
  type CrossStackResolver,
  type SubstitutionContext,
} from '../state-resolver.js';
import {
  argvValue,
  computedAttributeRead,
  secretAttributeRead,
  secretValueFromReason,
} from './container.js';
import { isCrossStackIntrinsic } from './needs.js';
import { pickString } from './pick.js';
import type { ResolvedEcsContainer, ResolvedEcsTask, UnresolvedCommandElement } from './types.js';

/** The resolved argv array an unresolved element's placeholder lives in. */
function argvTarget(
  container: ResolvedEcsContainer,
  field: UnresolvedCommandElement['field']
): string[] | undefined {
  if (field === 'Command') return container.command;
  if (field === 'EntryPoint') return container.entryPoint;
  return container.healthCheck?.command;
}

/** The template's raw argv array for `field`. */
function rawArgv(
  c: Record<string, unknown>,
  field: UnresolvedCommandElement['field']
): unknown[] | undefined {
  let raw: unknown;
  if (field === 'Command') raw = c['Command'];
  else if (field === 'EntryPoint') raw = c['EntryPoint'];
  else {
    const h = c['HealthCheck'];
    raw = h && typeof h === 'object' ? (h as Record<string, unknown>)['Command'] : undefined;
  }
  return Array.isArray(raw) ? (raw as unknown[]) : undefined;
}

/**
 * Async post-pass that walks the resolved task's container Environment +
 * Secrets entries from the raw template (preserved in `task.resource`)
 * and re-attempts substitution via {@link substituteAgainstStateAsync}
 * against the supplied context. The sync `parseContainerDefinition`
 * pass already substituted everything the legacy resolver handles; this
 * pass picks up the additional shapes the async resolver supports —
 * specifically `Fn::ImportValue` / `Fn::GetStackOutput` (issue #454).
 *
 * Resolved entries are patched onto the container's `environment` /
 * `secrets` map AND the corresponding `warnings` entries are filtered
 * out so the CLI doesn't print a stale per-container warn for an entry
 * the post-pass successfully resolved. Entries that STILL can't resolve
 * (e.g. producer stack not deployed) keep their original warning so the
 * CLI's UX matches the sync path.
 *
 * Pure-functional on the task structure outside of in-place mutation of
 * the container's `environment` / `secrets` / `warnings` arrays. The
 * task is expected to be the same `ResolvedEcsTask` instance returned
 * by `resolveEcsTaskTarget` — the runner downstream reads from these
 * fields directly.
 */
export async function applyCrossStackResolverToTask(
  task: ResolvedEcsTask,
  context: SubstitutionContext
): Promise<void> {
  if (!context.crossStackResolver) return;
  // A ValueFrom is an ARN, never a value: the Secrets pass gets no
  // dynamic-reference hook, so no plaintext can land where an ARN is echoed.
  const { resolveDynamicReferences: _envOnly, ...secretContext } = context;
  // go-to-k/cdkd#6337: what the producer's state says is a secret, from a
  // cdkd-built resolver; read before any wrapper below hides it.
  const producerSecrets = producerSecretCheckOf(context.crossStackResolver);
  const props = task.resource.Properties ?? {};
  const rawContainers = props['ContainerDefinitions'];
  if (!Array.isArray(rawContainers)) return;

  for (let idx = 0; idx < task.containers.length; idx += 1) {
    const container = task.containers[idx]!;
    const raw = rawContainers[idx];
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const containerName = pickString(c['Name']) ?? container.name;

    // Track keys the post-pass resolved so we can filter the matching
    // entries out of `container.warnings` (which the sync pass populated
    // with "dropped: <reason>" lines).
    const resolvedEnvKeys = new Set<string>();
    const resolvedSecretNames = new Set<string>();

    // Environment[].Value
    if (Array.isArray(c['Environment'])) {
      for (const entry of c['Environment'] as unknown[]) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const key = pickString(e['Name']);
        const value = e['Value'];
        if (!key) continue;
        // Skip literal values + entries already resolved by the sync
        // pass (present in `container.environment`).
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          continue;
        }
        // `Object.hasOwn`, not `in` (issue #3515): an env var legally named
        // `constructor` / `toString` answered `in` through the prototype
        // chain, so an unresolved one was skipped and never resolved here.
        if (Object.hasOwn(container.environment, key)) continue;
        if (!isCrossStackIntrinsic(value)) {
          // The sync pass already tried this — re-trying here can't
          // produce a different outcome.
          continue;
        }
        // Issue #2056: a producer output persisted as its `{{resolve:...}}`
        // token is resolved by the context's hook against the producer's
        // region; note it so the runner keeps the plaintext off the argv.
        let resolvedToken = false;
        const hook = context.resolveDynamicReferences;
        const keyContext: SubstitutionContext = hook
          ? {
              ...context,
              resolveDynamicReferences: async (v, producerRegion) => {
                const plain = await hook(v, producerRegion);
                resolvedToken = true;
                return plain;
              },
            }
          : context;
        // A producer's secret is served value-less too, as CloudFormation
        // accepts it in Environment (go-to-k/cdkd#6337).
        const watched = watchResolved(keyContext, producerSecrets);
        const sub = await substituteAgainstStateAsync(value, watched.context);
        if (sub.kind === 'literal') {
          // Own-key define, as in the sync pass above (issue #3515): a plain
          // assignment of `__proto__` created no key, yet the key was still
          // marked resolved and its "dropped" warning cleared.
          defineOwnKey(container.environment, key, String(sub.value));
          resolvedEnvKeys.add(key);
          // A same-stack secret read beside the import is kept off the argv,
          // as the sync pass does (go-to-k/cdkd#6330).
          if (
            resolvedToken ||
            watched.seen.producerSecret !== undefined ||
            secretAttributeRead(value, context.resources) !== undefined
          ) {
            container.resolvedDynamicReferenceKeys = [
              ...(container.resolvedDynamicReferenceKeys ?? []),
              key,
            ];
          }
        }
      }
    }

    // Secrets[].ValueFrom
    if (Array.isArray(c['Secrets'])) {
      for (const entry of c['Secrets'] as unknown[]) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const sName = pickString(e['Name']);
        const valueFromRaw = e['ValueFrom'];
        if (!sName) continue;
        if (typeof valueFromRaw === 'string' && valueFromRaw.length > 0) continue;
        if (container.secrets.some((s) => s.name === sName)) continue;
        if (!isCrossStackIntrinsic(valueFromRaw)) continue;
        // The sync pass dropped it with its reason (go-to-k/cdkd#6330).
        if (secretValueFromReason(valueFromRaw, secretContext.resources) !== undefined) continue;
        const watched = watchResolved(secretContext, producerSecrets);
        const sub = await substituteAgainstStateAsync(valueFromRaw, watched.context);
        // A producer's secret is no ARN, and the secrets resolver would name it
        // in its lookup line: it stays dropped, with this reason (go-to-k/cdkd#6337).
        if (watched.seen.producerSecret !== undefined) {
          redropSecret(
            task,
            container,
            containerName,
            sName,
            producerSecretValueFromReason(watched.seen.producerSecret)
          );
          continue;
        }
        if (sub.kind === 'literal' && typeof sub.value === 'string' && sub.value.length > 0) {
          container.secrets.push({ name: sName, valueFrom: sub.value });
          resolvedSecretNames.add(sName);
          if (container.droppedSecretNames) {
            container.droppedSecretNames = container.droppedSecretNames.filter((n) => n !== sName);
          }
        }
      }
    }

    // Command / EntryPoint / HealthCheck.Command elements the sync pass left
    // unresolved (go-to-k/cdkd#6271). No dynamic-reference hook, as for
    // Secrets: a plaintext must not land on the `docker run` argv, so an
    // element resolving to a `{{resolve:...}}` token stays unresolved.
    if (container.unresolvedCommandElements?.length) {
      const remaining: typeof container.unresolvedCommandElements = [];
      for (const u of container.unresolvedCommandElements) {
        const target = argvTarget(container, u.field);
        const rawElement = rawArgv(c, u.field)?.[u.index];
        if (!target || !isCrossStackIntrinsic(rawElement)) {
          remaining.push(u);
          continue;
        }
        // The sync pass deferred this element before its secret check, and a
        // nested cross-stack element can read a same-stack secret beside the
        // import (`Fn::Join` of an `Fn::ImportValue` and a `Fn::GetAtt`).
        const refusal =
          secretAttributeRead(rawElement, secretContext.resources) ??
          computedAttributeRead(rawElement);
        if (refusal !== undefined) {
          remaining.push({ ...u, reason: refusal });
          continue;
        }
        // A producer value recorded as the mask can be joined into a longer
        // string (`--token=***`), which `argvValue` cannot see: note it at the
        // resolver instead.
        // A producer's secret is refused the same way (go-to-k/cdkd#6337).
        const watched = watchResolved(secretContext, producerSecrets);
        const sub = await substituteAgainstStateAsync(rawElement, watched.context);
        const arg = watched.seen.masked
          ? {
              reason: `resolved a cross-stack value recorded as the secret mask (${SECRET_MASK}), not the deployed value`,
            }
          : watched.seen.producerSecret !== undefined
            ? { reason: producerSecretArgvReason(watched.seen.producerSecret) }
            : sub.kind === 'literal'
              ? argvValue(sub.value)
              : { reason: sub.reason };
        if ('value' in arg) {
          target[u.index] = arg.value;
          continue;
        }
        remaining.push({ ...u, reason: arg.reason });
      }
      if (remaining.length > 0) container.unresolvedCommandElements = remaining;
      else delete container.unresolvedCommandElements;
    }

    if (resolvedEnvKeys.size > 0 || resolvedSecretNames.size > 0) {
      container.warnings = container.warnings.filter((w) => {
        for (const k of resolvedEnvKeys) {
          if (w.startsWith(`Environment '${k}' dropped:`)) return false;
        }
        for (const k of resolvedSecretNames) {
          if (w.startsWith(`Secret '${k}' dropped:`)) return false;
        }
        return true;
      });
      // Same filter at the task-level (the per-container warnings are
      // re-emitted onto `task.warnings` by `parseEcsTaskFromCdkResource`,
      // prefixed with `Container '<name>': `).
      task.warnings = task.warnings.filter((w) => {
        for (const k of resolvedEnvKeys) {
          if (w.startsWith(`Container '${containerName}': Environment '${k}' dropped:`)) {
            return false;
          }
        }
        for (const k of resolvedSecretNames) {
          if (w.startsWith(`Container '${containerName}': Secret '${k}' dropped:`)) {
            return false;
          }
        }
        return true;
      });
    }
  }
}

/** What {@link watchResolved} saw the cross-stack resolver return. */
interface ResolvedSeen {
  /** A value that is the secret mask. */
  masked: boolean;
  /** The producer-secret verdict on the values read, `secret` over the fail-closed ones. */
  producerSecret: ProducerSecretVerdict | undefined;
}

/**
 * `context` with its cross-stack resolver noting each value it returns that is
 * the secret mask or that `producerSecrets` says holds a producer's secret.
 */
function watchResolved(
  context: SubstitutionContext,
  producerSecrets: ProducerSecretCheck | undefined
): { context: SubstitutionContext; seen: ResolvedSeen } {
  const seen: ResolvedSeen = { masked: false, producerSecret: undefined };
  const inner = context.crossStackResolver;
  if (!inner) return { context, seen };
  const watch = ({ value, verdict }: JudgedValue): string | undefined => {
    if (value === undefined) return value;
    if (value === SECRET_MASK) seen.masked = true;
    // `secret` outranks the fail-closed verdicts when one element reads several values.
    seen.producerSecret = strongerVerdict(seen.producerSecret, verdict);
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
 * Re-word the sync pass's "dropped" warning for `Secrets` entry `name` (both
 * the container's line and the task's copy) with `reason`: its ValueFrom
 * resolved to a producer stack's secret, or to a value whose producer state
 * could not be read (go-to-k/cdkd#6337).
 */
function redropSecret(
  task: ResolvedEcsTask,
  container: ResolvedEcsContainer,
  containerName: string,
  name: string,
  reason: string
): void {
  const line = `Secret '${name}' dropped: ${reason}`;
  const own = `Secret '${name}' dropped:`;
  container.warnings = [...container.warnings.filter((w) => !w.startsWith(own)), line];
  const taskOwn = `Container '${containerName}': ${own}`;
  task.warnings = [
    ...task.warnings.filter((w) => !w.startsWith(taskOwn)),
    `Container '${containerName}': ${line}`,
  ];
  if (!container.droppedSecretNames?.includes(name)) {
    container.droppedSecretNames = [...(container.droppedSecretNames ?? []), name];
  }
}
