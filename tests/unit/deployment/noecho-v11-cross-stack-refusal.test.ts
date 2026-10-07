import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { IntrinsicFunctionResolver } from '../../../src/deployment/intrinsic-function-resolver.js';
import type {
  RedactedAttributeRead,
  ResolverContext,
} from '../../../src/deployment/intrinsic-function-resolver.js';
import type { S3StateBackend } from '../../../src/state/s3-state-backend.js';
import {
  clearRecoverableMaskedOutputs,
  recordRecoverableMaskedOutput,
} from '../../../src/deployment/secret-redaction.js';
import { refuseRedactedAttributeReads } from '../../../src/deployment/deploy-engine/masking.js';
import {
  ambientCredentialConfig,
  credentialFingerprint,
} from '../../../src/utils/ambient-client-defaults.js';

/**
 * Maintainer decision 2 on #4043 (schema v11): an output a `NoEcho` template
 * PARAMETER serves persists as `***`, and a consumer deployed by ANOTHER run
 * (nothing recovered in this process) is refused as a cross-stack redacted
 * read rather than sent the mask. In the same run, the in-process recovery
 * serves the real value.
 */
const PARAM_VALUE = 'noecho-parameter-served-output-0001';

function producerBackend(): S3StateBackend {
  return {
    listStacks: vi.fn(async () => [{ stackName: 'ParamProducer', region: 'us-east-1' }]),
    getState: vi.fn(async () => ({
      state: {
        version: 11,
        stackName: 'ParamProducer',
        region: 'us-east-1',
        resources: {},
        // What a v11 deploy persists for `Outputs.ParamOut.Value: { Ref: NoEchoParam }`.
        outputs: { ParamOut: '***', ParamExport: '***' },
        exportNames: ['ParamExport'],
        lastModified: 0,
      },
      etag: 'e',
    })),
  } as unknown as S3StateBackend;
}

function consumerContext(reads: RedactedAttributeRead[]): ResolverContext {
  return {
    template: { Resources: {} },
    resources: {},
    stackName: 'Consumer',
    stateBackend: producerBackend(),
    recordedImports: [],
    redactedAttributeReads: reads,
  };
}

describe('a consumer of a NoEcho-parameter-served export (decision 2)', () => {
  beforeEach(() => clearRecoverableMaskedOutputs());

  it('in ANOTHER run: the read is recorded as cross-stack and the deploy refuses, naming the one-run remedy', async () => {
    const reads: RedactedAttributeRead[] = [];
    const value = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::ImportValue': 'ParamExport' },
      consumerContext(reads)
    );
    // Returned for the diff pass (which must stay stable), never SENT: the
    // provisioning arm refuses before any provider call.
    expect(value).toBe('***');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.kind).toBe('cross-stack');
    let refusal: unknown;
    try {
      refuseRedactedAttributeReads.call(
        {} as never,
        'ConsumerParam',
        'AWS::SSM::Parameter',
        consumerContext(reads)
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    const message = (refusal as Error).message;
    expect(message).toContain('Cannot resolve');
    expect(message).toContain('must deploy in ONE run');
    expect(message).not.toContain(PARAM_VALUE);
  });

  it('in the SAME run: the in-process recovery serves the real value and nothing is refused', async () => {
    recordRecoverableMaskedOutput(
      credentialFingerprint(ambientCredentialConfig()),
      'ParamProducer',
      'us-east-1',
      'ParamExport',
      PARAM_VALUE
    );
    const reads: RedactedAttributeRead[] = [];
    const value = await new IntrinsicFunctionResolver('us-east-1').resolve(
      { 'Fn::ImportValue': 'ParamExport' },
      consumerContext(reads)
    );
    expect(value).toBe(PARAM_VALUE);
    expect(reads).toEqual([]);
    expect(() =>
      refuseRedactedAttributeReads.call(
        {} as never,
        'ConsumerParam',
        'AWS::SSM::Parameter',
        consumerContext(reads)
      )
    ).not.toThrow();
  });
});
