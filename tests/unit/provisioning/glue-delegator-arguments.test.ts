/**
 * The Glue provider classes keep a delegating method for each method moved to
 * `src/provisioning/providers/glue/` (`return fn.call(this, ...)`), and each
 * argument a delegator hands on is a hand-off the split introduced. A mutation
 * probe that replaced one argument with `undefined` left the suites green for
 * the arguments below, so each is pinned here by what it reaches: the error's
 * `resourceType` / `physicalId`, or the request the provider sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import {
  GetConnectionCommand,
  GetCrawlerCommand,
  GetJobCommand,
  GetSecurityConfigurationCommand,
  GetTriggerCommand,
  GetWorkflowCommand,
} from '@aws-sdk/client-glue';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-glue', async () => {
  const actual =
    await vi.importActual<typeof import('@aws-sdk/client-glue')>('@aws-sdk/client-glue');
  return {
    ...actual,
    GlueClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: () => Promise.resolve('us-east-1') },
    })),
  };
});

import {
  GlueConnectionProvider,
  GlueCrawlerProvider,
  GlueJobProvider,
  GlueSecurityConfigurationProvider,
  GlueTriggerProvider,
  GlueWorkflowProvider,
} from '../../../src/provisioning/providers/glue-provider.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../../src/utils/error-handler.js';

const WRONG_REGION = { expectedRegion: 'eu-west-1' };

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
}

describe('Glue delegators hand every argument on', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('GlueWorkflowProvider.import() hands on its input', async () => {
    mockSend.mockResolvedValueOnce({ Workflow: { Name: 'wf-1' } });
    const result = await new GlueWorkflowProvider().import({
      logicalId: 'Wf',
      resourceType: 'AWS::Glue::Workflow',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'wf-1',
    });
    expect(result).toEqual({ physicalId: 'wf-1', attributes: {} });
    const command = mockSend.mock.calls[0]![0] as GetWorkflowCommand;
    expect(command).toBeInstanceOf(GetWorkflowCommand);
    expect(command.input).toEqual({ Name: 'wf-1' });
  });

  it('GlueWorkflowProvider.delete() hands on its resourceType', async () => {
    const error = await rejection(
      new GlueWorkflowProvider().delete('Wf', 'wf-1', 'AWS::Glue::Workflow', {}, WRONG_REGION)
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe('AWS::Glue::Workflow');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('GlueSecurityConfigurationProvider.create() hands on its resourceType', async () => {
    const error = await rejection(
      new GlueSecurityConfigurationProvider().create('Sc', 'AWS::Glue::SecurityConfiguration', {})
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe('AWS::Glue::SecurityConfiguration');
  });

  it('GlueSecurityConfigurationProvider.update() hands on its physicalId and resourceType', async () => {
    const provider = new GlueSecurityConfigurationProvider();
    const refused = await rejection(
      provider.update('Sc', 'sc-1', 'AWS::Glue::SecurityConfiguration', {}, {}, WRONG_REGION)
    );
    expect(refused).toBeInstanceOf(ProvisioningError);
    expect((refused as ProvisioningError).physicalId).toBe('sc-1');
    expect((refused as ProvisioningError).resourceType).toBe('AWS::Glue::SecurityConfiguration');
    const notSupported = await rejection(
      provider.update('Sc', 'sc-1', 'AWS::Glue::SecurityConfiguration', {}, {})
    );
    expect(notSupported).toBeInstanceOf(ResourceUpdateNotSupportedError);
  });

  it('GlueSecurityConfigurationProvider.delete() hands on its resourceType', async () => {
    const error = await rejection(
      new GlueSecurityConfigurationProvider().delete(
        'Sc',
        'sc-1',
        'AWS::Glue::SecurityConfiguration',
        {},
        WRONG_REGION
      )
    );
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe('AWS::Glue::SecurityConfiguration');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('GlueSecurityConfigurationProvider.readCurrentState() hands on its physicalId', async () => {
    mockSend.mockResolvedValueOnce({ SecurityConfiguration: {} });
    const state = await new GlueSecurityConfigurationProvider().readCurrentState(
      'sc-1',
      'Sc',
      'AWS::Glue::SecurityConfiguration'
    );
    const command = mockSend.mock.calls[0]![0] as GetSecurityConfigurationCommand;
    expect(command.input).toEqual({ Name: 'sc-1' });
    // `Name` falls back to the physical id when AWS reports none.
    expect(state).toMatchObject({ Name: 'sc-1' });
  });
});

type AnyProvider = {
  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: { expectedRegion?: string }
  ): Promise<unknown>;
  readCurrentState(physicalId: string, logicalId: string, resourceType: string): Promise<unknown>;
  import(input: Record<string, unknown>): Promise<unknown>;
};

/** Each class's delete refusal, read-back request and import probe, per argument. */
const FAMILY: ReadonlyArray<{
  type: string;
  make: () => AnyProvider;
  /** The request key the physical id travels in. */
  nameKey: string;
  readsState: boolean;
  /** The class's own `Get*` command: a delegator wired to a sibling class's body sends another. */
  command: abstract new (...args: never[]) => unknown;
}> = [
  {
    type: 'AWS::Glue::SecurityConfiguration',
    make: () => new GlueSecurityConfigurationProvider() as unknown as AnyProvider,
    nameKey: 'Name',
    readsState: false, // pinned above
    command: GetSecurityConfigurationCommand,
  },
  {
    type: 'AWS::Glue::Job',
    make: () => new GlueJobProvider() as unknown as AnyProvider,
    nameKey: 'JobName',
    readsState: true,
    command: GetJobCommand,
  },
  {
    type: 'AWS::Glue::Crawler',
    make: () => new GlueCrawlerProvider() as unknown as AnyProvider,
    nameKey: 'Name',
    readsState: true,
    command: GetCrawlerCommand,
  },
  {
    type: 'AWS::Glue::Connection',
    make: () => new GlueConnectionProvider() as unknown as AnyProvider,
    nameKey: 'Name',
    readsState: false,
    command: GetConnectionCommand,
  },
  {
    type: 'AWS::Glue::Trigger',
    make: () => new GlueTriggerProvider() as unknown as AnyProvider,
    nameKey: 'Name',
    readsState: true,
    command: GetTriggerCommand,
  },
];

describe.each(FAMILY)('$type delegators hand every argument on', ({ type, make, nameKey, readsState, command: expectedCommand }) => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('delete() hands on its resourceType', async () => {
    const error = await rejection(make().delete('R', 'res-1', type, {}, WRONG_REGION));
    expect(error).toBeInstanceOf(ProvisioningError);
    expect((error as ProvisioningError).resourceType).toBe(type);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it.runIf(readsState)('readCurrentState() hands on its physicalId', async () => {
    mockSend.mockResolvedValue({});
    await make().readCurrentState('res-1', 'R', type);
    const command = mockSend.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command).toBeInstanceOf(expectedCommand);
    expect(command.input).toEqual({ [nameKey]: 'res-1' });
  });

  it.runIf(type !== 'AWS::Glue::Connection')('import() hands on its input', async () => {
    mockSend.mockResolvedValueOnce({});
    const result = await make().import({
      logicalId: 'R',
      resourceType: type,
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      knownPhysicalId: 'res-1',
    });
    expect(result).toEqual({ physicalId: 'res-1', attributes: {} });
    const command = mockSend.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command).toBeInstanceOf(expectedCommand);
    expect(command.input).toEqual({ [nameKey]: 'res-1' });
  });
});

describe('GlueConnectionProvider and GlueTriggerProvider hand on the rest', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('GlueConnectionProvider.create() and update() hand on their resourceType', async () => {
    const provider = new GlueConnectionProvider();
    const created = await rejection(provider.create('C', 'AWS::Glue::Connection', {}));
    expect((created as ProvisioningError).resourceType).toBe('AWS::Glue::Connection');
    const updated = await rejection(
      provider.update('C', 'conn-1', 'AWS::Glue::Connection', {}, {})
    );
    expect((updated as ProvisioningError).resourceType).toBe('AWS::Glue::Connection');
  });

  it('GlueTriggerProvider.unsettledInTransition() hands on its physicalId', async () => {
    mockSend.mockResolvedValueOnce({ Trigger: { State: 'ACTIVATING' } });
    const unsettled = await new GlueTriggerProvider().unsettledInTransition(
      'trig-1',
      'T',
      'AWS::Glue::Trigger',
      new Set(['Actions', 'Tags'])
    );
    expect([...unsettled]).toEqual(['Actions']);
    const command = mockSend.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(command.input).toEqual({ Name: 'trig-1' });
  });
});
