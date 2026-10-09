/**
 * `cdkd import` writes a NoEcho-fed position the way a v11 deploy does
 * (go-to-k/cdkd#4043, Phase C, design section 4.5): `***` in `properties` by
 * POSITION, whatever the value's type or length, the coordinate named in
 * `noEchoLeaves`, the observed baseline masked there, and an attribute of the
 * same name echoing the value (an SSM parameter's `Value`) masked and declared
 * in `noEchoAttributeNames`. Through the real resolver and the real capture.
 */
import { describe, it, expect, vi } from 'vite-plus/test';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { ResourceState, StackState } from '../../../src/types/state.js';
import { STATE_SCHEMA_VERSION_CURRENT } from '../../../src/types/state.js';

vi.mock('../../../src/utils/logger.js', () => {
  const fns = {
    setLevel: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => fns,
  };
  return { getLogger: () => fns };
});

vi.mock('../../../src/provisioning/cloud-control-provider.js', () => ({
  CloudControlProvider: { isSupportedResourceType: vi.fn(() => true) },
}));

const { resolveImportedProperties, captureObservedForImportedResources, ObservedBaselineRefusals } =
  await import('../../../src/cli/commands/import.js');
const { getLogger } = await import('../../../src/utils/logger.js');

const SSM = 'AWS::SSM::Parameter';

function template(value: unknown, type = 'String'): CloudFormationTemplate {
  return {
    Parameters: {
      Token: { Type: type, NoEcho: true, Default: value },
      Plain: { Type: 'String', Default: 'plain-value' },
    },
    Resources: {
      Param: {
        Type: SSM,
        Properties: {
          Name: '/app/p',
          Type: 'String',
          Value: { Ref: 'Token' },
          Description: { Ref: 'Plain' },
        },
      },
    },
  } as unknown as CloudFormationTemplate;
}

function stateFrom(tpl: CloudFormationTemplate, attributes: Record<string, unknown>): StackState {
  const resource = tpl.Resources['Param']!;
  return {
    version: STATE_SCHEMA_VERSION_CURRENT,
    stackName: 'import-noecho-stack',
    region: 'us-east-1',
    resources: {
      Param: {
        physicalId: '/app/p',
        resourceType: SSM,
        properties: structuredClone(resource.Properties as Record<string, unknown>),
        attributes,
      } as ResourceState,
    },
    outputs: {},
    lastModified: 0,
  };
}

async function importOf(value: unknown, type?: string): Promise<ResourceState> {
  const tpl = template(value, type);
  const state = stateFrom(tpl, { Value: value, Type: 'String' });
  const refusals = await resolveImportedProperties(
    state,
    tpl,
    'us-east-1',
    {} as never,
    getLogger()
  );
  const registry = {
    getProviderFor: () => ({
      provider: {
        readCurrentState: async () => ({
          Name: '/app/p',
          Type: 'String',
          Value: value,
          Description: 'plain-value',
        }),
      },
      provisionedBy: 'sdk',
    }),
  } as unknown as Parameters<typeof captureObservedForImportedResources>[1];
  await captureObservedForImportedResources(
    state,
    registry,
    getLogger(),
    refusals instanceof ObservedBaselineRefusals ? refusals : new ObservedBaselineRefusals(),
    new Set(['Param'])
  );
  return state.resources['Param']!;
}

describe('cdkd import positions a NoEcho parameter (go-to-k/cdkd#4043 Phase C)', () => {
  it.each([
    ['a long string', 'cdkd-import-noecho-4043-value', 'String'],
    ['a 3-character string', 'q7z', 'String'],
    ['a number', 4242, 'Number'],
  ])('%s: *** in properties and the observed baseline, named in noEchoLeaves', async (_l, value, type) => {
    const record = await importOf(value, type);

    expect(record.properties).toEqual({
      Name: '/app/p',
      Type: 'String',
      Value: '***',
      Description: 'plain-value',
    });
    expect(record.noEchoLeaves).toEqual([['Value']]);
    expect(record.observedProperties?.['Value']).toBe('***');
    // The same-named attribute echoing the value is masked and declared.
    expect(record.attributes?.['Value']).toBe('***');
    expect(record.noEchoAttributeNames).toEqual(['Value']);
    // The ordinary parameter beside it stays in the clear.
    expect(record.observedProperties?.['Description']).toBe('plain-value');
    expect(JSON.stringify(record)).not.toContain(`:${JSON.stringify(value)}`);
  });

  it('writes no noEchoLeaves where no NoEcho source serves a leaf', async () => {
    const tpl = template('x');
    (tpl.Resources['Param']!.Properties as Record<string, unknown>)['Value'] = 'literal';
    const state = stateFrom(tpl, {});
    await resolveImportedProperties(state, tpl, 'us-east-1', {} as never, getLogger());
    expect(state.resources['Param']!.noEchoLeaves).toBeUndefined();
    expect(state.resources['Param']!.properties['Value']).toBe('literal');
  });

  // Review round 4 (#4764), m4: a Fn::GetAtt consumer resolved BEFORE its
  // producer is still positioned, once the producer's echo is declared.
  it('positions a Fn::GetAtt consumer of an echoing producer whatever the record order', async () => {
    const tpl = template('q7z');
    tpl.Resources = {
      Consumer: {
        Type: SSM,
        Properties: { Name: '/app/c', Type: 'String', Value: { 'Fn::GetAtt': ['Param', 'Value'] } },
      },
      ...tpl.Resources,
    } as never;
    const state = stateFrom(tpl, { Value: 'q7z', Type: 'String' });
    state.resources = {
      Consumer: {
        physicalId: '/app/c',
        resourceType: SSM,
        properties: structuredClone(tpl.Resources['Consumer']!.Properties as Record<string, unknown>),
        attributes: {},
      } as ResourceState,
      ...state.resources,
    };
    await resolveImportedProperties(state, tpl, 'us-east-1', {} as never, getLogger());
    expect(state.resources['Param']!.noEchoAttributeNames).toEqual(['Value']);
    expect(state.resources['Consumer']!.properties['Value']).toBe('***');
    expect(state.resources['Consumer']!.noEchoLeaves).toEqual([['Value']]);
  });

  it('G9: an attribute equal to the physical id is not taken as an echo', async () => {
    // Under the value arm's floor, so only the echo rule could mask it.
    const tpl = template('q7z');
    const state = stateFrom(tpl, { Value: 'q7z' });
    state.resources['Param']!.physicalId = 'q7z';
    await resolveImportedProperties(state, tpl, 'us-east-1', {} as never, getLogger());
    expect(state.resources['Param']!.attributes).toEqual({ Value: 'q7z' });
    expect(state.resources['Param']!.noEchoAttributeNames).toBeUndefined();
  });
});
