/**
 * Masks one log text.
 */
export type LogLineMasker = (text: string) => string;

/**
 * Answers "which masker applies to a line emitted in the CURRENT async
 * context?" (issue [#2177](https://github.com/go-to-k/cdkd/issues/2177)).
 *
 * A provider's own `this.logger.*` line reaches no engine sink, so a resolved
 * secret it interpolated printed verbatim unless that call site threaded the
 * masker. `ConsoleLogger` masks HERE, once, for every line. The source is
 * INSTALLED rather than imported because `src/utils` must not import
 * `src/deployment`: `src/deployment/resource-secrets-scope.ts`, which owns the
 * per-resource secret bag's `AsyncLocalStorage`, registers it at module load,
 * so it is in place whenever a bag can be bound.
 *
 * Its own import-free module rather than a `logger.ts` export so a test that
 * replaces `logger.ts` with a `vi.mock` factory can still load the registrar.
 *
 * The source must return `undefined` cheaply when no bag is bound or the bag
 * holds nothing to mask: that is every non-deploy command and every line
 * outside a provider call.
 */
let source: (() => LogLineMasker | undefined) | undefined;

/**
 * Install (or, with `undefined`, remove) the masker source.
 */
export function setLogLineMaskerSource(next: (() => LogLineMasker | undefined) | undefined): void {
  source = next;
}

/**
 * The masker for the current async context, or `undefined` when the line
 * needs none.
 */
export function currentLogLineMasker(): LogLineMasker | undefined {
  return source?.();
}
