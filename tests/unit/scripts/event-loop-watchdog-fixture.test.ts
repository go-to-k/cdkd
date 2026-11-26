/**
 * The child run of `event-loop-watchdog.test.ts` (go-to-k/cdkd#7042). It runs
 * only when that test spawns vitest on this file with
 * `CDKD_EVENT_LOOP_WATCHDOG_FIXTURE=1`; in the ordinary suite every case is
 * skipped.
 *
 * Each case drives the real shared RDS wait (`waitForInstanceState`) with the
 * sleep double the unit suite uses, so the starved timer is the one a provider
 * test meets. The cases run in order and the last one kills the worker.
 */
import type { DBInstance } from '@aws-sdk/client-rds';
import { describe, expect, it } from 'vite-plus/test';

import { RDSProvider } from '../../../src/provisioning/providers/rds-provider.js';

const SHORT_TIMEOUT_MS = 1_000;

function providerReading(sleep: () => Promise<void>): {
  provider: RDSProvider;
  reads: () => number;
} {
  const provider = new RDSProvider();
  let count = 0;
  const seams = provider as unknown as {
    describeDBInstance: (id: string) => Promise<DBInstance | undefined>;
    sleep: (ms: number) => Promise<void>;
  };
  seams.describeDBInstance = async () => {
    count += 1;
    return { DBInstanceIdentifier: 'db-1', DBInstanceStatus: 'modifying' };
  };
  seams.sleep = sleep;
  return { provider, reads: () => count };
}

describe.runIf(process.env.CDKD_EVENT_LOOP_WATCHDOG_FIXTURE === '1')(
  'event-loop watchdog fixture',
  () => {
    it('control: a wait the third read satisfies passes', async () => {
      const { provider, reads } = providerReading(async () => {});
      await provider.waitForInstanceState('Db', 'db-1', () => reads() >= 3, 'port change');
      expect(reads()).toBe(3);
    });

    it(
      'control: a never-satisfied wait whose sleep yields fails at the test timeout',
      async () => {
        const { provider } = providerReading(() => new Promise((resolve) => setImmediate(resolve)));
        await provider.waitForInstanceState('Db', 'db-1', () => false, 'port change');
      },
      SHORT_TIMEOUT_MS
    );

    it(
      'hang: a never-satisfied wait whose sleep resolves at once',
      async () => {
        const { provider } = providerReading(async () => {});
        await provider.waitForInstanceState('Db', 'db-1', () => false, 'port change');
      },
      SHORT_TIMEOUT_MS
    );
  }
);
