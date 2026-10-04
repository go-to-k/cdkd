/**
 * go-to-k/cdkd#4543, the PREVIEW half: `cdkd diff` compares a masked
 * property's layout-2 fingerprint against the stack's resolved inputs, so a
 * changed parameter behind unchanged template text previews the UPDATE the
 * deploy sends. A nested child does not compare it (its deploy classifies a
 * parent-supplied value by secrets this preview never resolves). Through
 * `computeStackDiff` with the real resolver.
 */
import { describe, expect, it, vi } from 'vite-plus/test';

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
vi.mock('@aws-sdk/client-cloudformation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@aws-sdk/client-cloudformation')>();
  return {
    ...actual,
    CloudFormationClient: vi.fn().mockImplementation(() => ({
      send: async () => {
        throw Object.assign(new Error('not in this test'), { name: 'TypeNotFoundException' });
      },
    })),
  };
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDiffTree, computeStackDiff } from '../../../src/cli/commands/diff-recursive.js';
import { DiffCalculator } from '../../../src/analyzer/diff-calculator.js';
import {
  maskedInputFingerprint,
  maskedPropertyFingerprint,
  parameterInputsFor,
} from '../../../src/deployment/masked-property-fingerprints.js';
import type { CloudFormationTemplate } from '../../../src/types/resource.js';
import type { StackState } from '../../../src/types/state.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';

const VALUE = {
  'Fn::Base64': {
    'Fn::Join': ['', ['b=', { Ref: 'P' }, ';pw=', '{{resolve:secretsmanager:app-pw}}']],
  },
};
const templateAt = (value: string): CloudFormationTemplate => ({
  Parameters: { P: { Type: 'String', Default: value } },
  Resources: {
    R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Type: 'String', Value: VALUE } },
  },
});

async function stateStampedAt(value: string): Promise<StackState> {
  const template = templateAt(value);
  const fingerprint = await maskedInputFingerprint(VALUE, {
    template,
    parameterInput: parameterInputsFor({ template, values: { P: value } }).parameterInput,
    resolve: () => Promise.reject(new Error('no node to resolve')),
  });
  return {
    stackName: 'S',
    region: 'us-east-1',
    resources: {
      R: {
        physicalId: 'n',
        resourceType: 'AWS::SSM::Parameter',
        properties: { Name: 'n', Type: 'String', Value: '***' },
        maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(VALUE) },
        maskedPropertyInputFingerprints: { Value: fingerprint! },
      },
    },
    outputs: {},
    version: 10,
    lastModified: 0,
  };
}

async function changeOf(state: StackState, template: CloudFormationTemplate, preview: boolean) {
  const backend = { getState: async () => null } as unknown as S3StateBackend;
  const result = await computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator(), {
    previewMaskedInputs: preview,
  });
  return result.changes.get('R')!;
}

describe('cdkd diff previews a masked property whose parameter moved (go-to-k/cdkd#4543)', () => {
  it('previews the UPDATE for the stack the user named', async () => {
    const change = await changeOf(await stateStampedAt('one'), templateAt('two'), true);
    expect(change.changeType).toBe('UPDATE');
    expect(change.propertyChanges).toEqual([
      expect.objectContaining({ path: 'Value', maskedExpressionChanged: true }),
    ]);
  });

  it('previews nothing for an unchanged parameter (control)', async () => {
    const change = await changeOf(await stateStampedAt('one'), templateAt('one'), true);
    expect(change.changeType).toBe('NO_CHANGE');
  });

  it('does not compare the inputs in a nested child, but still sees a template edit there', async () => {
    const change = await changeOf(await stateStampedAt('one'), templateAt('two'), false);
    expect(change.changeType).toBe('NO_CHANGE');
    const edited = templateAt('one');
    (edited.Resources['R']!.Properties as Record<string, unknown>)['Value'] = {
      'Fn::Base64': {
        'Fn::Join': ['', ['c=', { Ref: 'P' }, ';pw=', '{{resolve:secretsmanager:app-pw}}']],
      },
    };
    const textEdit = await changeOf(await stateStampedAt('one'), edited, false);
    expect(textEdit.changeType).toBe('UPDATE');
  });
});

describe('buildDiffTree compares the inputs for the root only (go-to-k/cdkd#4543)', () => {
  it('previews the root row, and reads the same change in a nested child as unmoved', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cdkd-4543-'));
    try {
      const childPath = join(dir, 'child.json');
      // The child reads `P` from its parent row, which now passes `two`.
      writeFileSync(childPath, JSON.stringify(templateAt('one')));
      const parentTemplate = templateAt('two');
      parentTemplate.Resources['Child'] = {
        Type: 'AWS::CloudFormation::Stack',
        Metadata: { 'aws:asset:path': 'child.json' },
        Properties: { Parameters: { P: 'two' } },
      };
      const parentState = await stateStampedAt('one');
      parentState.resources['Child'] = {
        physicalId: 'child',
        resourceType: 'AWS::CloudFormation::Stack',
        properties: { Parameters: { P: 'two' } },
      };
      const childState = { ...(await stateStampedAt('one')), stackName: 'S~Child' };
      const states: Record<string, StackState> = { S: parentState, 'S~Child': childState };
      const root = await buildDiffTree({
        stackName: 'S',
        displayName: 'S',
        region: 'us-east-1',
        template: parentTemplate,
        nestedTemplates: { Child: childPath },
        recursive: true,
        stateBackend: {
          getState: async (name: string) =>
            states[name] ? { state: states[name], etag: 'e' } : null,
        } as unknown as S3StateBackend,
        diffCalculator: new DiffCalculator(),
        isNestedChild: false,
      });
      expect(root.changes.get('R')!.changeType).toBe('UPDATE');
      expect(root.children).toHaveLength(1);
      expect(root.children[0]!.changes.get('R')!.changeType).toBe('NO_CHANGE');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('cdkd diff keeps an input its resolution recorded a secret for as written (go-to-k/cdkd#4543 G2)', () => {
  it('a recovered secret cross-stack value neither moves the preview nor reaches the hash', async () => {
    const { IntrinsicFunctionResolver } = await import(
      '../../../src/deployment/intrinsic-function-resolver.js'
    );
    const { recordMaskOnlyValue } = await import('../../../src/deployment/secret-redaction.js');
    const IMPORT = { 'Fn::ImportValue': 'shared' };
    let plaintext = 'recovered-output-one';
    // A cross-stack read recovered in-process re-registers the plaintext into
    // the bag of the context resolving it (`recoverMaskedOutput`).
    const spy = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolveImportValue')
      .mockImplementation((_arg: unknown, context: unknown) => {
        const bag = (context as { recordedSecretValues?: Map<string, string> })
          .recordedSecretValues;
        if (bag) recordMaskOnlyValue(bag, plaintext);
        return Promise.resolve(plaintext);
      });
    try {
      const value = {
        'Fn::Base64': {
          'Fn::Join': ['', [IMPORT, ';pw=', '{{resolve:secretsmanager:app-pw}}']],
        },
      };
      const template: CloudFormationTemplate = {
        Resources: {
          R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Type: 'String', Value: value } },
        },
      };
      // Stamped with the input kept as written, as the deploy keeps it.
      const stamped = await maskedInputFingerprint(value, {
        template,
        parameterInput: () => ({ kind: 'unknown' }),
        resolve: () =>
          Promise.resolve({ value: 'x', secrets: new Map([['x', '***']]) }),
      });
      const state: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        resources: {
          R: {
            physicalId: 'n',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Name: 'n', Type: 'String', Value: '***' },
            maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) },
            maskedPropertyInputFingerprints: { Value: stamped! },
          },
        },
        outputs: {},
        version: 10,
        lastModified: 0,
      };
      expect((await changeOf(state, template, true)).changeType).toBe('NO_CHANGE');
      plaintext = 'recovered-output-two';
      expect((await changeOf(state, template, true)).changeType).toBe('NO_CHANGE');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('cdkd diff never hashes a physical-id fallback (go-to-k/cdkd#4543 G10)', () => {
  it('an attribute it cannot read is an unknown input: no comparison, no fallback warning', async () => {
    const { getLogger } = await import('../../../src/utils/logger.js');
    const warn = vi.mocked(getLogger().warn);
    warn.mockClear();
    const GETATT = { 'Fn::GetAtt': ['A', 'NotAnAttribute'] };
    const value = {
      'Fn::Base64': { 'Fn::Join': ['', [GETATT, ';pw=', '{{resolve:secretsmanager:app-pw}}']] },
    };
    const template: CloudFormationTemplate = {
      Resources: {
        A: { Type: 'AWS::SNS::Topic', Properties: {} },
        R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Type: 'String', Value: value } },
      },
    };
    // What the deploy stamped when the attribute DID resolve.
    const stamped = await maskedInputFingerprint(value, {
      template,
      parameterInput: () => ({ kind: 'unknown' }),
      resolve: () => Promise.resolve({ value: 'the-real-attribute' }),
    });
    const state: StackState = {
      stackName: 'S',
      region: 'us-east-1',
      resources: {
        A: {
          physicalId: 'arn:aws:sns:us-east-1:1:a',
          resourceType: 'AWS::SNS::Topic',
          properties: {},
        },
        R: {
          physicalId: 'n',
          resourceType: 'AWS::SSM::Parameter',
          properties: { Name: 'n', Type: 'String', Value: '***' },
          maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) },
          maskedPropertyInputFingerprints: { Value: stamped! },
        },
      },
      outputs: {},
      version: 10,
      lastModified: 0,
    };
    const warnsBefore = warn.mock.calls.length;
    const backend = { getState: async () => null } as unknown as S3StateBackend;
    // Only the fingerprint pass is observed: the ordinary diff resolution of
    // the property may still guess and warn as it always did.
    const result = await computeStackDiff(state, template, 'us-east-1', 'S', backend, new DiffCalculator(), {
      previewMaskedInputs: true,
    });
    const row = result.changes.get('R')!;
    expect(row.propertyChanges?.some((pc) => pc.maskedExpressionChanged === true) ?? false).toBe(
      false
    );
    const fallbackWarnings = warn.mock.calls
      .slice(warnsBefore)
      .filter((call) => String(call[0]).includes('NotAnAttribute'));
    // The ordinary resolution warns at most once; the fingerprint pass adds none.
    expect(fallbackWarnings.length).toBeLessThanOrEqual(1);
  });
});

describe('cdkd diff never fetches a secret a masked property input yields (go-to-k/cdkd#4543 P29)', () => {
  it('a cross-stack read yielding a {{resolve:...}} reference is kept as written, never fetched', async () => {
    const { IntrinsicFunctionResolver } = await import(
      '../../../src/deployment/intrinsic-function-resolver.js'
    );
    let fetched = 0;
    const fetch = vi
      .spyOn(IntrinsicFunctionResolver.prototype, 'resolveSecretsManagerReference')
      .mockImplementation(() => Promise.resolve(`fetched-plaintext-${++fetched}`));
    try {
      const IMPORT = { 'Fn::ImportValue': 'shared-pw' };
      const value = {
        'Fn::Base64': { 'Fn::Join': ['', ['b=', { Ref: 'P' }, ';pw=', IMPORT]] },
      };
      const templateAtP = (p: string): CloudFormationTemplate => ({
        Parameters: { P: { Type: 'String', Default: p } },
        Resources: {
          R: { Type: 'AWS::SSM::Parameter', Properties: { Name: 'n', Type: 'String', Value: value } },
        },
      });
      // The producer's state holds its secret output as the expression, as
      // the save writes it; resolving it would fetch the secret.
      const producer: StackState = {
        stackName: 'Producer',
        region: 'us-east-1',
        resources: {},
        outputs: { 'shared-pw': '{{resolve:secretsmanager:app-pw}}' },
        exportNames: ['shared-pw'],
        version: 10,
        lastModified: 0,
      };
      const backend = {
        listStacks: async () => [{ stackName: 'Producer', region: 'us-east-1' }],
        getState: async (name: string) =>
          name === 'Producer' ? { state: producer, etag: 'e' } : null,
      } as unknown as S3StateBackend;
      // What the deploy stamps: the reference stays as written, the parameter
      // enters as its value.
      const template = templateAtP('one');
      const stamped = await maskedInputFingerprint(value, {
        template,
        parameterInput: parameterInputsFor({ template, values: { P: 'one' } }).parameterInput,
        resolve: () => Promise.resolve({ value: '{{resolve:secretsmanager:app-pw}}' }),
      });
      expect(stamped).toBeDefined();
      const state: StackState = {
        stackName: 'S',
        region: 'us-east-1',
        resources: {
          R: {
            physicalId: 'n',
            resourceType: 'AWS::SSM::Parameter',
            properties: { Name: 'n', Type: 'String', Value: '***' },
            maskedPropertyFingerprints: { Value: maskedPropertyFingerprint(value) },
            maskedPropertyInputFingerprints: { Value: stamped! },
          },
        },
        outputs: {},
        version: 10,
        lastModified: 0,
      };
      const rowOf = async (t: CloudFormationTemplate) =>
        (
          await computeStackDiff(state, t, 'us-east-1', 'S', backend, new DiffCalculator(), {
            previewMaskedInputs: true,
          })
        ).changes.get('R')!;
      // Unchanged inputs: no preview, and no secret fetched.
      expect((await rowOf(templateAtP('one'))).changeType).toBe('NO_CHANGE');
      // The comparison did run (control): a moved parameter beside the
      // cross-stack read previews the UPDATE, still without a fetch.
      expect((await rowOf(templateAtP('two'))).changeType).toBe('UPDATE');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });
});
