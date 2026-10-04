/**
 * go-to-k/cdkd#3338: a failed-op skip's durable reason goes through THAT
 * iteration's op masker, as `replaySingle`'s skips do. The failed-op loop has
 * no deploy bag (`logOnlyNeedlesFor` is the in-process rollback's alone), so
 * the masker is observed through a wrapped `createOpMasker` rather than a
 * recorded needle.
 */

import { describe, it, expect, vi } from 'vite-plus/test';
import {
  replayFailedOperations,
  type FailedOperation,
  type RollbackExecutorContext,
} from '../../../src/deployment/rollback-executor.js';
import type { DeploymentEvent } from '../../../src/types/deployment-events.js';

const MARK = '<masked-by-op-masker>';
vi.mock('../../../src/deployment/rollback-executor/names.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/deployment/rollback-executor/names.js')>();
  return {
    ...actual,
    createOpMasker: (...args: Parameters<typeof actual.createOpMasker>) => {
      const masker = actual.createOpMasker(...args);
      return { ...masker, mask: (text: string) => masker.mask(text).replace('physical id', MARK) };
    },
  };
});

describe("a failed-op skip's reason is masked by its op masker (go-to-k/cdkd#3338)", () => {
  it('skip-failed-unknown', async () => {
    const events: Array<Omit<DeploymentEvent, 'timestamp'>> = [];
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      setLevel: vi.fn(),
      child: () => logger,
    } as unknown as RollbackExecutorContext['logger'];
    const ctx: RollbackExecutorContext = {
      region: 'us-east-1',
      logger,
      providerRegistry: {} as RollbackExecutorContext['providerRegistry'],
      recordEvent: (e) => events.push(e),
    };
    const op: FailedOperation = {
      logicalId: 'F',
      changeType: 'CREATE',
      resourceType: 'AWS::SQS::Queue',
    };
    const result = await replayFailedOperations([op], {}, 'S', ctx);
    expect(result).toMatchObject({ warnings: 1, skipped: 1 });
    const reason = events.find((e) => e.eventType === 'ROLLBACK_RESOURCE_SKIPPED')!.reason!;
    expect(reason).toContain(`recorded no ${MARK}`);
  });
});
