import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-route-53', async () => {
  const actual = await vi.importActual('@aws-sdk/client-route-53');
  return {
    ...actual,
    Route53Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };
  return {
    getLogger: () => ({
      child: () => childLogger,
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { Route53Provider } from '../../../src/provisioning/providers/route53-provider.js';
import { isDeleteStarted } from '../../../src/provisioning/delete-started.js';
import { replacedDeleteFailureVerdict } from '../../../src/deployment/rollback-executor/replaced-survivor.js';

const TYPE = 'AWS::Route53::HostedZone';
const ZONE = 'Z1234567890';

function accessDenied(action: string): Error {
  const e = new Error(`User is not authorized to perform: route53:${action}`);
  e.name = 'AccessDenied';
  return e;
}

interface Script {
  /** Query logging config ids the zone carries. */
  queryLogging?: string[];
  /** Whether DeleteQueryLoggingConfig is refused (the delete swallows it). */
  queryLoggingDeleteDenied?: boolean;
  /** Config ids whose DeleteQueryLoggingConfig is refused by name (the rest succeed). */
  queryLoggingDeniedIds?: string[];
  /** Whether DeleteQueryLoggingConfig fails without an AWS refusal name. */
  queryLoggingDeleteFails?: boolean;
  /** AcceleratedRecoveryStatus answers, in turn (the last repeats). */
  accel: string[];
  /** Whether UpdateHostedZoneFeatures is refused. */
  featuresDenied?: boolean;
}

/** Answer a hosted zone delete per `s`; DeleteHostedZone is always refused. */
function script(s: Script): void {
  let reads = 0;
  mockSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    const name = cmd.constructor.name;
    if (name === 'ListQueryLoggingConfigsCommand') {
      return Promise.resolve({
        QueryLoggingConfigs: (s.queryLogging ?? []).map((Id) => ({ Id, HostedZoneId: ZONE })),
      });
    }
    if (name === 'DeleteQueryLoggingConfigCommand') {
      const id = (cmd as unknown as { input: { Id?: string } }).input.Id ?? '';
      if (s.queryLoggingDeniedIds?.includes(id) === true) {
        return Promise.reject(accessDenied('DeleteQueryLoggingConfig'));
      }
      if (s.queryLoggingDeleteFails === true) {
        return Promise.reject(Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }));
      }
      return s.queryLoggingDeleteDenied === true
        ? Promise.reject(accessDenied('DeleteQueryLoggingConfig'))
        : Promise.resolve({});
    }
    if (name === 'GetHostedZoneCommand') {
      const status = s.accel[Math.min(reads++, s.accel.length - 1)];
      return Promise.resolve({
        HostedZone: { Id: `/hostedzone/${ZONE}`, Features: { AcceleratedRecoveryStatus: status } },
      });
    }
    if (name === 'UpdateHostedZoneFeaturesCommand') {
      return s.featuresDenied === true
        ? Promise.reject(accessDenied('UpdateHostedZoneFeatures'))
        : Promise.resolve({});
    }
    if (name === 'DeleteHostedZoneCommand') {
      return Promise.reject(accessDenied('DeleteHostedZone'));
    }
    return Promise.reject(new Error(`unexpected command ${name}`));
  });
}

function sent(name: string): number {
  return mockSend.mock.calls.filter((c) => String(c[0].constructor.name) === name).length;
}

async function deleteError(): Promise<unknown> {
  return new Route53Provider().delete('Zone', ZONE, TYPE).then(
    () => {
      throw new Error('delete resolved');
    },
    (error: unknown) => error
  );
}

describe('Route53Provider hosted zone delete marks a refusal after a strip (go-to-k/cdkd#4946)', () => {
  beforeEach(() => {
    mockSend.mockReset();
    process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'] = '1';
    process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'] = '5000';
  });

  afterEach(() => {
    delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_INTERVAL_MS'];
    delete process.env['CDKD_R53_ACCEL_RECOVERY_POLL_TIMEOUT_MS'];
  });

  it('marks a refused DeleteHostedZone once a query logging config was deleted', async () => {
    script({ queryLogging: ['qlc-1'], accel: ['DISABLED'] });

    const err = await deleteError();

    expect(sent('DeleteQueryLoggingConfigCommand')).toBe(1);
    expect(sent('UpdateHostedZoneFeaturesCommand')).toBe(0);
    expect(sent('DeleteHostedZoneCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves it unmarked when AWS refused the query logging delete by name: nothing changed (kept)', async () => {
    script({ queryLogging: ['qlc-1'], queryLoggingDeleteDenied: true, accel: ['DISABLED'] });

    const err = await deleteError();

    expect(sent('DeleteQueryLoggingConfigCommand')).toBe(1);
    expect(sent('DeleteHostedZoneCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('keeps the mark of an earlier deleted config when a later one is refused by name', async () => {
    script({ queryLogging: ['qlc-1', 'qlc-2'], queryLoggingDeniedIds: ['qlc-2'], accel: ['DISABLED'] });

    const err = await deleteError();

    expect(sent('DeleteQueryLoggingConfigCommand')).toBe(2);
    expect(sent('DeleteHostedZoneCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('marks it when the swallowed query logging delete failed in a way that may have landed', async () => {
    script({ queryLogging: ['qlc-1'], queryLoggingDeleteFails: true, accel: ['DISABLED'] });

    const err = await deleteError();

    expect(sent('DeleteHostedZoneCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('marks a refused DeleteHostedZone once accelerated recovery was disabled', async () => {
    script({ accel: ['ENABLED', 'DISABLING', 'DISABLED'] });

    const err = await deleteError();

    expect(sent('DeleteQueryLoggingConfigCommand')).toBe(0);
    expect(sent('UpdateHostedZoneFeaturesCommand')).toBe(1);
    expect(sent('DeleteHostedZoneCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(true);
    expect(replacedDeleteFailureVerdict(err)).toBe('unconfirmed');
  });

  it('leaves a refused DeleteHostedZone unmarked when nothing was stripped (kept)', async () => {
    script({ accel: ['DISABLED'] });

    const err = await deleteError();

    expect(sent('DeleteQueryLoggingConfigCommand')).toBe(0);
    expect(sent('UpdateHostedZoneFeaturesCommand')).toBe(0);
    expect(sent('DeleteHostedZoneCommand')).toBe(1);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });

  it('leaves a refused accelerated-recovery disable (the first change) unmarked (kept)', async () => {
    script({ accel: ['ENABLED'], featuresDenied: true });

    const err = await deleteError();

    expect(sent('UpdateHostedZoneFeaturesCommand')).toBe(1);
    expect(sent('DeleteHostedZoneCommand')).toBe(0);
    expect(isDeleteStarted(err)).toBe(false);
    expect(replacedDeleteFailureVerdict(err)).toBe('kept');
  });
});
