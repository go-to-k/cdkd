import { randomUUID } from 'node:crypto';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { displaySafe, safeMsg, truncateCodePoints } from '../../utils/display-safe.js';
import { markNonRetryable } from '../../deployment/retryable-errors/marks.js';
import { startInterruptWatch } from '../interrupt-watch.js';
import {
  classifyHandleUrl,
  evaluateSignals,
  WaitConditionSignalStore,
  type WaitConditionSignal,
} from '../wait-condition-signal-store.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

const TYPE = 'AWS::CloudFormation::WaitCondition';

/** CloudFormation's ceiling for `Timeout`: 12 hours. */
export const MAX_WAIT_CONDITION_TIMEOUT_SECONDS = 43200;

const INITIAL_POLL_INTERVAL_MS = 2000;
const MAX_POLL_INTERVAL_MS = 10000;

/** How long a displayed signal `Reason` may run. */
const REASON_DISPLAY_CAP = 512;

interface WaitSpec {
  handle: string;
  count: number;
  timeoutSeconds: number;
}

/**
 * AWS::CloudFormation::WaitCondition Provider (go-to-k/cdkd#6694).
 *
 * Waits for `Count` `SUCCESS` signals at the `Handle`'s URL — a
 * `WaitConditionHandle` cdkd issued against its state bucket — failing on the
 * first `FAILURE` signal or once `Timeout` seconds pass, as CloudFormation
 * does. `Fn::GetAtt Data` is the JSON object of each signal's `UniqueId` to its
 * `Data`, CloudFormation's shape.
 *
 * Not supported, refused at create: a wait condition with no `Handle` (the
 * `CreationPolicy` form, signalled through `cfn-signal --resource`, which is
 * CloudFormation's `SignalResource` API), and a handle cdkd did not issue.
 */
export class WaitConditionProvider implements ResourceProvider {
  private logger = getLogger().child('WaitConditionProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFormation::WaitCondition', new Set<string>(['Handle', 'Count', 'Timeout'])],
  ]);

  /** Test seam: the poll loop's clock and sleep. */
  protected now = (): number => Date.now();
  protected sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  private readonly signals: WaitConditionSignalStore;

  constructor(signals: WaitConditionSignalStore = new WaitConditionSignalStore()) {
    this.signals = signals;
  }

  /**
   * Lift the per-resource deadline over the longest wait CloudFormation
   * allows; the provider enforces the declared `Timeout` itself.
   */
  getMinResourceTimeoutMs(): number {
    return (MAX_WAIT_CONDITION_TIMEOUT_SECONDS + 300) * 1000;
  }

  async create(
    logicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    const spec = this.readSpec(logicalId, properties);
    const data = await this.waitForSignals(logicalId, spec);
    return {
      physicalId: `cdkd-wait-condition-${logicalId}-${randomUUID()}`,
      attributes: { Data: JSON.stringify(data) },
    };
  }

  /**
   * A changed `Handle`, `Count` or `Timeout` waits again (against what the
   * handle has received so far); anything else keeps the recorded `Data`.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    _context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);
    const changed =
      differs(properties['Handle'], previousProperties['Handle']) ||
      differs(properties['Count'], previousProperties['Count']) ||
      differs(properties['Timeout'], previousProperties['Timeout']);
    if (!changed) return { physicalId, wasReplaced: false };
    const spec = this.readSpec(logicalId, properties);
    const data = await this.waitForSignals(logicalId, spec);
    return { physicalId, wasReplaced: false, attributes: { Data: JSON.stringify(data) } };
  }

  /** Nothing exists in AWS for a wait condition; its handle owns the signals. */
  async delete(logicalId: string, _physicalId: string, _resourceType: string): Promise<void> {
    this.logger.debug(safeMsg`No-op delete for WaitCondition ${logicalId}`);
  }

  /** `Data` is recorded at create; nothing can be read back live. */
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string,
    logicalId: string
  ): Promise<unknown> {
    throw new ProvisioningError(
      `AWS::CloudFormation::WaitCondition attribute ${attributeName} can only be read from the value recorded when the wait completed`,
      resourceType,
      logicalId,
      physicalId
    );
  }

  /** The properties describe a wait, not live configuration: nothing can drift. */
  async readCurrentState(): Promise<Record<string, unknown>> {
    return {};
  }

  /** There is nothing in AWS to find; accept a known id (a CloudFormation migration). */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (input.knownPhysicalId === undefined) return null;
    return { physicalId: input.knownPhysicalId, attributes: {} };
  }

  private refuse(logicalId: string, message: string): never {
    throw markNonRetryable(new ProvisioningError(message, TYPE, logicalId));
  }

  private readSpec(logicalId: string, properties: Record<string, unknown>): WaitSpec {
    const handle = properties['Handle'];
    if (handle === undefined || handle === null) {
      this.refuse(
        logicalId,
        `WaitCondition ${logicalId} has no Handle. cdkd supports only the handle form ` +
          `(a WaitConditionHandle whose URL is signalled); a CreationPolicy-signalled wait ` +
          `condition is not supported.`
      );
    }
    if (typeof handle !== 'string') {
      this.refuse(logicalId, `WaitCondition ${logicalId}: Handle must resolve to a string.`);
    }

    const timeoutSeconds = integerOf(properties['Timeout']);
    if (
      timeoutSeconds === undefined ||
      timeoutSeconds < 1 ||
      timeoutSeconds > MAX_WAIT_CONDITION_TIMEOUT_SECONDS
    ) {
      this.refuse(
        logicalId,
        `WaitCondition ${logicalId}: Timeout must be a whole number of seconds from 1 to ` +
          `${MAX_WAIT_CONDITION_TIMEOUT_SECONDS}.`
      );
    }

    const rawCount = properties['Count'];
    const count = rawCount === undefined || rawCount === null ? 1 : integerOf(rawCount);
    if (count === undefined || count < 1) {
      this.refuse(
        logicalId,
        `WaitCondition ${logicalId}: Count must be a whole number of at least 1.`
      );
    }
    return { handle, count, timeoutSeconds };
  }

  private async waitForSignals(logicalId: string, spec: WaitSpec): Promise<Record<string, string>> {
    const verdict = classifyHandleUrl(spec.handle, this.signals.requireBucket());
    if (verdict.kind === 'legacy') {
      this.refuse(
        logicalId,
        `WaitCondition ${logicalId}: its Handle was created by a cdkd version that issued no ` +
          `signal URL. Give the WaitConditionHandle a new logical id (or remove it, deploy, and ` +
          `add it back) so cdkd issues one, then deploy again.`
      );
    }
    if (verdict.kind === 'foreign') {
      this.refuse(
        logicalId,
        `WaitCondition ${logicalId}: its Handle is not a signal URL cdkd issued for this state ` +
          `bucket (for example a CloudFormation-issued handle), so cdkd cannot read its signals. ` +
          `Give the WaitConditionHandle a new logical id so cdkd issues one.`
      );
    }

    const deadline = this.now() + spec.timeoutSeconds * 1000;
    const seen = new Map<string, WaitConditionSignal | null>();
    const watch = startInterruptWatch(`WaitCondition ${logicalId}`);
    let interval = INITIAL_POLL_INTERVAL_MS;
    let received = 0;
    this.logger.info(
      safeMsg`Waiting for ${spec.count} signal(s) on WaitCondition ${logicalId} (timeout ${spec.timeoutSeconds}s)`
    );
    try {
      for (;;) {
        if (watch.isInterrupted()) throw watch.onInterrupted();
        let signals: WaitConditionSignal[] | undefined;
        try {
          signals = await this.signals.readSignals(verdict.key, seen);
        } catch (error) {
          // A throttle or a blip: the next poll retries until the deadline.
          this.logger.debug(
            safeMsg`WaitCondition ${logicalId} signal read failed: ${
              error instanceof Error ? error.name : 'unknown error'
            }`
          );
        }
        if (signals !== undefined) {
          const result = evaluateSignals(signals, spec.count);
          if (result.state === 'succeeded') return result.data;
          if (result.state === 'failed') {
            const reason = bounded(result.signal.reason, REASON_DISPLAY_CAP);
            const from = bounded(result.signal.uniqueId, 128);
            this.refuse(
              logicalId,
              `WaitCondition ${logicalId} received a FAILURE signal` +
                (from !== '' ? ` from ${from}` : '') +
                (reason !== '' ? `: ${reason}` : '')
            );
          }
          received = result.successes;
        }
        const remaining = deadline - this.now();
        if (remaining <= 0) {
          this.refuse(
            logicalId,
            `WaitCondition ${logicalId} timed out after ${spec.timeoutSeconds}s with ` +
              `${received} of ${spec.count} SUCCESS signal(s) received.`
          );
        }
        await this.sleep(Math.min(interval, remaining));
        interval = Math.min(Math.ceil(interval * 1.5), MAX_POLL_INTERVAL_MS);
      }
    } finally {
      watch.dispose();
    }
  }
}

/** A signal field, written by whoever holds the URL, made displayable and capped. */
function bounded(value: string, cap: number): string {
  const { text, truncated } = truncateCodePoints(displaySafe(value), cap);
  return truncated ? `${text}...` : text;
}

/** A positive or zero integer from a number or a numeric string; `undefined` otherwise. */
function integerOf(value: unknown): number | undefined {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /^\s*\d+\s*$/.test(value)
        ? Number(value)
        : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : undefined;
}
