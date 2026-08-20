/**
 * Retry-stable idempotency tokens for provider CREATE calls (issue
 * [#2039](https://github.com/go-to-k/cdkd/issues/2039)).
 *
 * ## The failure this exists to prevent
 *
 * The deploy engine wraps every `provider.create()` in an outer transient-error
 * retry (`src/deployment/retry.ts`), and issue #2026 made HTTP 500 / 502 / 504
 * retryable for the default classifier. A 500 whose request actually SUCCEEDED
 * server-side therefore re-invokes `create()` from the top. For a CREATE that
 * carries no name and no idempotency token, the replay mints a SECOND resource:
 * the first has no state entry, so `cdkd destroy` never reaches it and it bills
 * indefinitely. `RunInstances` is the worst instance of the class.
 *
 * ## What "stable" has to mean, precisely
 *
 * A token regenerated per attempt is not a fix — it is worse than none, because
 * the call site now LOOKS idempotent while behaving exactly as before. So the
 * value must be:
 *
 *  - **Identical across every attempt of one logical create.** Guaranteed here
 *    by memoising on `(scope, region, stackName, logicalId)` — a tuple the retry
 *    loop reproduces byte-for-byte, because it re-invokes the same closure with
 *    the same arguments. Deliberately NOT keyed on the resolved properties.
 *    (The earlier version of this note justified that by saying the properties
 *    are re-derived per attempt. They are NOT: `deploy-engine.ts` computes them
 *    once OUTSIDE the retry closure. The reason to keep them out of the key is
 *    that it makes the guarantee STRUCTURAL rather than contingent — an
 *    identity built from a logical id cannot be perturbed by a future change to
 *    how properties are resolved, whereas one built from their contents can.)
 *  - **Different for a genuinely NEW create of the same logical resource.**
 *    Reusing a token after a create SUCCEEDED is its own hazard: EC2 keeps a
 *    `RunInstances` token for ~24h and answers a repeat with the ORIGINAL
 *    instance, so a `--replace` re-create (delete old, then create with
 *    unchanged properties, all in one process) would be handed back the
 *    instance it had just terminated. {@link IdempotencyToken.release} is what
 *    prevents that: it is called only on the success path, and it bumps a
 *    per-key generation counter so the next acquire derives a fresh value.
 *  - **Never reused by a LATER cdkd run.** A per-process nonce is mixed into
 *    the digest, so two `cdkd deploy` invocations of the same template never
 *    collide even though every other input is identical.
 *
 * ## Why not a purely deterministic hash of the create inputs
 *
 * That is what `EFSProvider`'s `CreationToken` and `FSxFileSystemProvider`'s
 * `ClientRequestToken` do, and it is right FOR THEM: those APIs enforce token
 * uniqueness only among LIVE file systems, so a re-deploy after a destroy is
 * unaffected, and hashing the immutable inputs is what lets the new file system
 * coexist with the old one during a replacement. EC2 is the opposite shape —
 * the token survives the resource's own termination — so a value that is stable
 * across RUNS is a liability there rather than an asset. Both providers keep
 * their existing derivation; this module is for the APIs where the token must
 * be scoped to one process and one create.
 */

import { createHash, randomUUID } from 'node:crypto';
import { getCurrentStackName } from '../resource-name.js';

/**
 * Mixed into every digest so no two `cdkd` processes can derive the same token
 * from the same template. Evaluated once at module load; ESM guarantees a
 * single module instance per process, which is exactly the scope wanted.
 */
const PROCESS_NONCE = randomUUID();

/** Tokens currently in flight, keyed by {@link tokenKey}. */
const inFlight = new Map<string, string>();

/**
 * How many times each key has been RELEASED. Folded into the digest so a
 * post-success re-acquire (the `--replace` delete-then-create path) yields a
 * different token than the create that already succeeded.
 */
const generations = new Map<string, number>();

/**
 * Ceiling on {@link generations}. Chosen far above any realistic stack size so
 * eviction is unreachable in a normal `cdkd` run, and present only so a
 * long-lived process cannot grow the map without bound.
 */
const MAX_TRACKED_GENERATIONS = 100_000;

/** A token that is stable while its create keeps failing, and retired on success. */
export interface IdempotencyToken {
  /** The value to hand to the AWS request field. */
  readonly value: string;
  /**
   * Retire the token. Call this ONLY after the create has succeeded — a
   * released token is never handed out again, so releasing on the failure path
   * would defeat the whole mechanism.
   */
  release(): void;
}

export interface AcquireIdempotencyTokenOptions {
  /**
   * Distinguishes call sites within one provider, so a provider that issues two
   * tokenised creates for one logical id does not hand both the same value.
   * Use the AWS action name (`'RunInstances'`, `'CreateNatGateway'`, ...).
   */
  scope: string;
  /** The template logical id of the resource being created. */
  logicalId: string;
  /**
   * Max token length the target API accepts. Defaults to 64, EC2's documented
   * `Maximum 64 ASCII characters` limit. The value is always `[-a-z0-9]`, so
   * truncation stays within every API's accepted character set.
   */
  maxLength?: number;
}

const tokenKey = (scope: string, logicalId: string): string =>
  // Stack name AND region: what identifies a resource in cdkd's state layout is
  // `{stackName}/{region}/{logicalId}`, and this map is process-global, so one
  // process deploying the same stack to two regions (`cdkd deploy --all`) would
  // otherwise hand both creates the same token and have the second answered
  // with the first region's resource. Both are absent outside a `withStackName`
  // scope / an unset AWS_REGION, which only unit tests hit.
  `${scope}\u0000${process.env['AWS_REGION'] ?? ''}\u0000${getCurrentStackName() ?? ''}\u0000${logicalId}`;

const derive = (key: string, generation: number, maxLength: number): string => {
  const digest = createHash('sha256')
    .update(`${PROCESS_NONCE}\u0000${key}\u0000${generation}`)
    .digest('hex');
  return `cdkd-${digest}`.slice(0, maxLength);
};

/**
 * Get the idempotency token for one logical create, minting it on first use and
 * returning the SAME value for every retry of that create.
 *
 * @example
 * ```ts
 * const token = acquireIdempotencyToken({ scope: 'RunInstances', logicalId });
 * const response = await client.send(new RunInstancesCommand({ ...input, ClientToken: token.value }));
 * token.release(); // success path only
 * ```
 */
export function acquireIdempotencyToken(options: AcquireIdempotencyTokenOptions): IdempotencyToken {
  const { scope, logicalId, maxLength = 64 } = options;
  const key = tokenKey(scope, logicalId);
  const existing = inFlight.get(key);
  const value = existing ?? derive(key, generations.get(key) ?? 0, maxLength);
  if (existing === undefined) {
    inFlight.set(key, value);
  }
  return {
    value,
    release: (): void => {
      // Guard against a double release (a provider that releases in both a
      // success path and a `finally`) re-bumping the generation for a token
      // that is no longer in flight.
      if (!inFlight.has(key)) {
        return;
      }
      inFlight.delete(key);
      const generation = (generations.get(key) ?? 0) + 1;
      // Bounded: one entry per (scope, region, stack, logical id) that has ever
      // been released, which for a long-lived process (the local dev server
      // redeploying in a loop) would otherwise only ever grow. Pruning at a
      // generation ceiling is not an option — the counter is exactly what makes
      // a re-acquire differ from the token that already succeeded — so the cap
      // is on entries, evicting the oldest, which at worst hands a very old key
      // a repeat of a token whose resource is long gone.
      if (!generations.has(key) && generations.size >= MAX_TRACKED_GENERATIONS) {
        const oldest = generations.keys().next();
        if (!oldest.done) {
          generations.delete(oldest.value);
        }
      }
      generations.set(key, generation);
    },
  };
}

/**
 * Drop all remembered tokens. TEST-ONLY: production code has no reason to
 * forget a token that is still in flight, and doing so would reinstate the
 * duplicate-create window mid-retry.
 */
export function resetIdempotencyTokensForTests(): void {
  inFlight.clear();
  generations.clear();
}
