import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  ModifyInstanceAttributeCommand,
  MonitorInstancesCommand,
  UnmonitorInstancesCommand,
} from '@aws-sdk/client-ec2';

// Issue #1160: removing a property from an AWS::EC2::Instance template.
// A real CloudFormation A/B (us-east-1) showed: a removed `Monitoring` is
// reset to off; a removed `MetadataOptions` / `CreditSpecification` is kept;
// a removed `DisableApiTermination` fails the CloudFormation update (from
// true or false) while an explicit flip is applied. cdkd resets Monitoring,
// keeps MetadataOptions / CreditSpecification, and refuses a forward removal
// of DisableApiTermination (a rollback revert arm keeps + warns instead).

const { mockSend, warn } = vi.hoisted(() => ({ mockSend: vi.fn(), warn: vi.fn() }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    ec2: { send: mockSend, config: { region: () => Promise.resolve('us-east-1') } },
  }),
}));

vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn,
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

import { EC2Provider } from '../../../src/provisioning/providers/ec2-provider.js';
import { prepareRemovalForUpdate } from '../../../src/provisioning/update-removal.js';

const TYPE = 'AWS::EC2::Instance';

describe('EC2Provider AWS::EC2::Instance property removal (#1160)', () => {
  let provider: EC2Provider;

  beforeEach(() => {
    mockSend.mockReset();
    warn.mockReset();
    provider = new EC2Provider();
    mockSend.mockImplementation((cmd) => {
      if (cmd?.constructor?.name === 'DescribeInstancesCommand') {
        return Promise.resolve({ Reservations: [{ Instances: [{ InstanceId: 'i-1' }] }] });
      }
      return Promise.resolve({});
    });
  });

  function mutatingCommands() {
    return mockSend.mock.calls
      .map((c) => c[0])
      .filter((cmd) => cmd?.constructor?.name !== 'DescribeInstancesCommand');
  }

  function terminationWarnings() {
    return warn.mock.calls.filter((c) => String(c[0]).includes('DisableApiTermination'));
  }

  it('declares Monitoring -> false as the Instance removal default', () => {
    expect(provider.removalDefaults.get(TYPE)).toEqual(new Map([['Monitoring', false]]));
  });

  it('a removed Monitoring that was on calls UnmonitorInstances (direct call)', async () => {
    await provider.update('Web', 'i-1', TYPE, { ImageId: 'ami-1' }, { ImageId: 'ami-1', Monitoring: true });
    const cmds = mutatingCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(UnmonitorInstancesCommand);
    expect(cmds[0].input).toEqual({ InstanceIds: ['i-1'] });
  });

  it('a removed Monitoring that was on calls UnmonitorInstances (caller-injected bag)', async () => {
    const previous = { ImageId: 'ami-1', Monitoring: 'true' };
    const prep = prepareRemovalForUpdate(provider, TYPE, { ImageId: 'ami-1' }, previous);
    expect(prep.injected).toEqual(['Monitoring']);
    await provider.update('Web', 'i-1', TYPE, prep.properties, previous, prep.context);
    const cmds = mutatingCommands();
    expect(cmds).toHaveLength(1);
    expect(cmds[0]).toBeInstanceOf(UnmonitorInstancesCommand);
  });

  it('a removed Monitoring that was already off sends nothing', async () => {
    await provider.update('Web', 'i-1', TYPE, { ImageId: 'ami-1' }, { ImageId: 'ami-1', Monitoring: false });
    expect(mutatingCommands()).toHaveLength(0);
  });

  it('a Monitoring never declared stays absent (no Monitor/Unmonitor call)', async () => {
    await provider.update(
      'Web',
      'i-1',
      TYPE,
      { ImageId: 'ami-1', Tags: [] },
      { ImageId: 'ami-1', Tags: [] }
    );
    expect(
      mutatingCommands().filter(
        (c) => c instanceof MonitorInstancesCommand || c instanceof UnmonitorInstancesCommand
      )
    ).toHaveLength(0);
  });

  it('drift --revert (empty removedProperties) does not reset Monitoring', async () => {
    await provider.update(
      'Web',
      'i-1',
      TYPE,
      { ImageId: 'ami-1' },
      { ImageId: 'ami-1', Monitoring: true },
      { removedProperties: new Set() }
    );
    expect(mutatingCommands()).toHaveLength(0);
  });

  it('a removed MetadataOptions / CreditSpecification is kept (CloudFormation keeps them)', async () => {
    await provider.update(
      'Web',
      'i-1',
      TYPE,
      { ImageId: 'ami-1' },
      {
        ImageId: 'ami-1',
        MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 3 },
        CreditSpecification: { CPUCredits: 'standard' },
      }
    );
    expect(mutatingCommands()).toHaveLength(0);
  });

  describe('DisableApiTermination removal (CloudFormation fails it; issuecomment-6281778130)', () => {
    const REFUSAL = 'DisableApiTermination was removed from the template';

    it('a forward deploy removing a true is refused before ANY call, tag change included', async () => {
      const previous = { ImageId: 'ami-1', DisableApiTermination: true, Tags: [{ Key: 'a', Value: '1' }] };
      const desired = { ImageId: 'ami-1', Tags: [{ Key: 'a', Value: '2' }] };
      const prep = prepareRemovalForUpdate(provider, TYPE, desired, previous);
      const err = await provider
        .update('Web', 'i-1', TYPE, prep.properties, previous, prep.context)
        .then(
          () => undefined,
          (e: unknown) => e as Error
        );
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain(`Web (${TYPE}): ${REFUSAL}`);
      expect(err?.message).toContain('set it to false to turn termination protection off');
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('a forward deploy removing a false is refused too (CloudFormation fails it as well)', async () => {
      await expect(
        provider.update('Web', 'i-1', TYPE, { ImageId: 'ami-1' }, { ImageId: 'ami-1', DisableApiTermination: false })
      ).rejects.toThrow(REFUSAL);
      expect(mockSend).not.toHaveBeenCalled();
    });

    it('explicit flips are applied: true -> false and false -> true', async () => {
      await provider.update(
        'Web',
        'i-1',
        TYPE,
        { ImageId: 'ami-1', DisableApiTermination: false },
        { ImageId: 'ami-1', DisableApiTermination: true }
      );
      expect(mutatingCommands()).toHaveLength(1);
      expect(mutatingCommands()[0].input).toEqual({
        InstanceId: 'i-1',
        DisableApiTermination: { Value: false },
      });

      mockSend.mockClear();
      await provider.update(
        'Web',
        'i-1',
        TYPE,
        { ImageId: 'ami-1', DisableApiTermination: 'true' },
        { ImageId: 'ami-1', DisableApiTermination: 'false' }
      );
      expect(mutatingCommands()[0].input).toEqual({
        InstanceId: 'i-1',
        DisableApiTermination: { Value: true },
      });
      expect(terminationWarnings()).toHaveLength(0);
    });

    it('an absent -> true addition is applied, not refused', async () => {
      await provider.update('Web', 'i-1', TYPE, { ImageId: 'ami-1', DisableApiTermination: true }, { ImageId: 'ami-1' });
      expect(mutatingCommands()[0]).toBeInstanceOf(ModifyInstanceAttributeCommand);
    });

    it('a rollback revert arm (replayingState) keeps the live value and warns, never refuses', async () => {
      // The failed deploy ADDED DisableApiTermination: true; the record being
      // restored (desired) does not declare it.
      const attempted = { ImageId: 'ami-1', DisableApiTermination: true };
      const restored = { ImageId: 'ami-1' };
      const prep = prepareRemovalForUpdate(provider, TYPE, restored, attempted);
      await provider.update('Web', 'i-1', TYPE, prep.properties, attempted, {
        ...prep.context,
        replayingState: true,
      });
      expect(
        mutatingCommands().filter((c) => c instanceof ModifyInstanceAttributeCommand)
      ).toHaveLength(0);
      const warnings = terminationWarnings();
      expect(warnings).toHaveLength(1);
      expect(warnings[0][0]).toContain('Web (AWS::EC2::Instance)');
      expect(warnings[0][0]).toContain('the rollback leaves termination protection');
    });

    it('a rollback revert arm restoring over an added false neither refuses nor warns', async () => {
      await provider.update(
        'Web',
        'i-1',
        TYPE,
        { ImageId: 'ami-1' },
        { ImageId: 'ami-1', DisableApiTermination: false },
        { removedProperties: new Set(['DisableApiTermination']), replayingState: true }
      );
      expect(terminationWarnings()).toHaveLength(0);
      expect(mutatingCommands()).toHaveLength(0);
    });

    it('drift --revert (readback previous, empty removedProperties) neither refuses nor warns', async () => {
      await provider.update(
        'Web',
        'i-1',
        TYPE,
        { ImageId: 'ami-1' },
        { ImageId: 'ami-1', DisableApiTermination: true },
        { desiredFromAwsReadback: true, removedProperties: new Set() }
      );
      expect(terminationWarnings()).toHaveLength(0);
      expect(mutatingCommands()).toHaveLength(0);
    });
  });
});
