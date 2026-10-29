import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The engine-owned record of a resource a provider's create call made
 * (go-to-k/cdkd#5511).
 *
 * `markCreatedBeforeFailure` carries that proof on the error `create()`
 * throws. Under the per-resource deadline the error can arrive too late: the
 * deadline does not cancel the operation, and a provider error that settles
 * after it is dropped, so the failed-CREATE journal sees only the unmarked
 * `ResourceTimeoutError` and the resource is recorded nowhere. A provider
 * whose create call has returned therefore also REPORTS the id here, the
 * moment it has it and before any wait. The sink lives outside the call's
 * promise (the deploy engine holds it), so a report survives the deadline
 * race, the way `UpdateContext.markUnsettled` does for #5380.
 *
 * Physical ids and identity tokens only: never a property value.
 */
export interface CreatedResourceReport {
  readonly physicalId: string;
  readonly createdResourceIdentity?: string;
}

/**
 * One resource operation's sink. Anchored on the logical id AND the type the
 * operation provisions, like the error mark's reader: a report naming either
 * differently (a nested child's create running under its parent row's scope)
 * is ignored.
 */
export class CreatedResourceSink {
  readonly logicalId: string;
  readonly resourceType: string;
  private latest: CreatedResourceReport | undefined;

  constructor(logicalId: string, resourceType: string) {
    this.logicalId = logicalId;
    this.resourceType = resourceType;
  }

  /**
   * The last report, or `undefined`. Last wins: a retried attempt that made
   * its own resource names that one, as the error mark `withRetry` carries
   * does; an earlier attempt's report stands while no later one replaces it.
   */
  get report(): CreatedResourceReport | undefined {
    return this.latest;
  }

  /** @internal */
  record(report: CreatedResourceReport): void {
    this.latest = report;
  }

  /** @internal */
  clear(): void {
    this.latest = undefined;
  }

  /** @internal */
  retract(physicalId: string): void {
    if (this.latest?.physicalId === physicalId) this.latest = undefined;
  }
}

const storage = new AsyncLocalStorage<CreatedResourceSink>();

/**
 * Run one resource operation with `sink` receiving every create its provider
 * reports. The caller reads `sink` whether `fn` resolved or threw, and after
 * a deadline abandoned `fn`. Nested scopes shadow outer ones, so a
 * nested-stack child engine's own rows report into their own sinks.
 */
export function collectCreatedResources<T>(
  sink: CreatedResourceSink,
  fn: () => Promise<T>
): Promise<T> {
  return storage.run(sink, fn);
}

/**
 * Run one provider `create()` / `update()` attempt for the operation in scope,
 * clearing its sink when the call RESOLVES. A report stands in for the mark
 * on an error that `create()` threw; once the call returned, its result names
 * the resource and the engine records it, so a later engine step's failure
 * (a replacement's old-resource delete) must not journal it as an orphan,
 * which no mark would have done either.
 */
export async function clearCreatedReportOnReturn<T>(fn: () => Promise<T>): Promise<T> {
  const result = await fn();
  storage.getStore()?.clear();
  return result;
}

function anchoredSink(
  ownerLogicalId: string,
  resourceType: string
): CreatedResourceSink | undefined {
  const sink = storage.getStore();
  return sink !== undefined &&
    sink.logicalId === ownerLogicalId &&
    sink.resourceType === resourceType
    ? sink
    : undefined;
}

/**
 * Report that `ownerLogicalId`'s create call has RETURNED and the resource
 * `physicalId` exists because this attempt made it. Call it right after the
 * create call returns and BEFORE any wait, under the same conditions a
 * `markCreatedBeforeFailure` of that id would be made (never for a resource
 * the create adopted or found held). `createdResourceIdentity` is the same
 * optional token the mark takes. A no-op outside a deploy operation's scope,
 * for another logical id or type, and for an empty id. Never throws.
 */
export function reportCreatedResource(
  ownerLogicalId: string,
  resourceType: string,
  physicalId: string,
  createdResourceIdentity?: string
): void {
  try {
    if (typeof physicalId !== 'string' || physicalId === '') return;
    anchoredSink(ownerLogicalId, resourceType)?.record({
      physicalId,
      ...(typeof createdResourceIdentity === 'string' &&
        createdResourceIdentity !== '' && { createdResourceIdentity }),
    });
  } catch {
    // Unreportable: only the recovery is lost.
  }
}

/**
 * Withdraw a {@link reportCreatedResource} of `physicalId`: the provider's own
 * catch deleted the resource it made, so nothing is left to journal. Only a
 * report naming that id is withdrawn. Never throws.
 */
export function retractCreatedResource(
  ownerLogicalId: string,
  resourceType: string,
  physicalId: string
): void {
  try {
    anchoredSink(ownerLogicalId, resourceType)?.retract(physicalId);
  } catch {
    // Nothing to withdraw.
  }
}
