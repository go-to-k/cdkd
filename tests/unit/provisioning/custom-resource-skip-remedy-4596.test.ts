import { describe, it, expect, vi, beforeEach, afterEach } from 'vite-plus/test';

// go-to-k/cdkd#4596: every CustomResourceProvider.delete skip arm that can
// fire on a `cdkd deploy` (template removal, replacement, rollback) used to
// name the destroy-side remedy, `cdkd state orphan <stack>`. On a deploy the
// stack is still deployed, so following it drops the record of EVERY live
// resource in it. The remedy is now chosen by `DeleteContext.stackDestroy`;
// the skip outcome and reason are the same in both phases.
const mockLambdaSend = vi.fn();
const mockSnsSend = vi.fn();
const mockS3Send = vi.fn();
const mockStsSend = vi.fn(() => Promise.resolve({ Account: '123456789012' }));

vi.mock('../../../src/utils/aws-clients.js', () => ({
  getAwsClients: () => ({
    lambda: { send: mockLambdaSend },
    sns: { send: mockSnsSend },
    s3: { send: mockS3Send },
    sts: { send: mockStsSend },
  }),
}));

const warnSpy = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const childLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: (...args: unknown[]) => warnSpy(...args),
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

vi.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: () => Promise.resolve('https://s3.example.com/presigned-url'),
}));

import {
  CustomResourceProvider,
  CR_DELETE_HANDLER_FAILED_SKIP_REASON,
  CR_DELETE_INVOKE_FAILED_SKIP_REASON,
  CR_MASKED_SERVICE_TOKEN_SKIP_REASON,
  CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON,
} from '../../../src/provisioning/providers/custom-resource-provider.js';
import type { DeleteContext } from '../../../src/provisioning/region-check.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';
import { resetAccountInfoCache } from '../../../src/deployment/intrinsic-function-resolver.js';

const SERVICE_TOKEN = 'arn:aws:lambda:us-east-1:123456789012:function:Stack-CrHandler';

/** The pre-check finds the function Active; the invoke does what `invoke` says. */
function wireLambda(invoke: () => Promise<unknown>): void {
  mockS3Send.mockImplementation(() => Promise.resolve({}));
  mockLambdaSend.mockImplementation((cmd: { constructor: { name: string } }) => {
    if (cmd.constructor.name === 'InvokeCommand') return invoke();
    return Promise.resolve({ Configuration: { State: 'Active', LastUpdateStatus: 'Successful' } });
  });
}

const ARMS: Array<{
  name: string;
  reason: string;
  serviceToken: string;
  wire: () => void;
  /** The handler arms state "KEEPING the state record", on a destroy only. */
  handlerArm: boolean;
}> = [
  {
    name: 'handler answered FAILED',
    reason: CR_DELETE_HANDLER_FAILED_SKIP_REASON,
    serviceToken: SERVICE_TOKEN,
    handlerArm: true,
    wire: () =>
      wireLambda(() =>
        Promise.resolve({
          Payload: Buffer.from(JSON.stringify({ Status: 'FAILED', Reason: 'upstream refused' })),
        })
      ),
  },
  {
    name: 'invoke failed',
    reason: CR_DELETE_INVOKE_FAILED_SKIP_REASON,
    serviceToken: SERVICE_TOKEN,
    handlerArm: true,
    wire: () =>
      wireLambda(() =>
        Promise.reject(
          Object.assign(new Error('the request body is malformed'), {
            name: 'InvalidRequestContentException',
          })
        )
      ),
  },
  {
    name: 'masked ServiceToken',
    reason: CR_MASKED_SERVICE_TOKEN_SKIP_REASON,
    serviceToken: SECRET_MASK,
    handlerArm: false,
    wire: () => undefined,
  },
  {
    name: '{{resolve:...}} ServiceToken',
    reason: CR_REFERENCE_SERVICE_TOKEN_SKIP_REASON,
    serviceToken: '{{resolve:secretsmanager:provider-arn:SecretString:arn}}',
    handlerArm: false,
    wire: () => undefined,
  },
];

const DEPLOY_CONTEXTS: Array<[string, DeleteContext | undefined]> = [
  ['no context', undefined],
  // What `deploy-engine/delete.ts` passes: no `stackDestroy`.
  ['a deploy-engine context', { expectedRegion: 'us-east-1', deletionPolicy: 'Delete' }],
  ['stackDestroy: false', { stackDestroy: false }],
];

const DESTROY_REMEDY = "'cdkd state orphan <stack> --stack-region <region>'";
const DEPLOY_PROHIBITION =
  "Do NOT run 'cdkd state orphan <stack>' on a stack that is still deployed to clear this record";

const warnings = (): string => warnSpy.mock.calls.map((call) => String(call[0])).join('\n');
const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

describe('CustomResourceProvider.delete skip remedy by phase (go-to-k/cdkd#4596)', () => {
  beforeEach(() => {
    mockLambdaSend.mockReset();
    mockSnsSend.mockReset();
    mockS3Send.mockReset();
    warnSpy.mockReset();
    resetAccountInfoCache();
    process.env['CDKD_CR_AUTHZ_MAX_RETRIES'] = '0';
  });

  afterEach(() => {
    delete process.env['CDKD_CR_AUTHZ_MAX_RETRIES'];
  });

  describe.each(ARMS)('$name', ({ reason, serviceToken, wire, handlerArm }) => {
    it('on a stack destroy, names the cdkd state orphan remedy and not the deploy one', async () => {
      wire();
      const result = await new CustomResourceProvider({ responseBucket: 'b' }).delete(
        'CrResource',
        'phys-123',
        'Custom::CrResource',
        { ServiceToken: serviceToken },
        { stackDestroy: true }
      );

      expect(result).toEqual({ outcome: 'skipped', reason });
      const text = warnings();
      expect(text).toContain(DESTROY_REMEDY);
      expect(text).toContain('drops EVERY record for the stack in that region');
      expect(text).not.toContain(DEPLOY_PROHIBITION);
      // Deploy-only advice has no place on a destroy, which has no such flag.
      expect(text).not.toContain('--allow-unaddressed');
      expect(text).not.toContain('ALSO reached from cdkd deploy');
      if (handlerArm) expect(text).toContain('cdkd is KEEPING the state record');
    });

    it.each(DEPLOY_CONTEXTS)(
      'outside a stack destroy (%s), forbids cdkd state orphan and names the deploy-side escapes',
      async (_label, context) => {
        wire();
        const result = await new CustomResourceProvider({ responseBucket: 'b' }).delete(
          'CrResource',
          'phys-123',
          'Custom::CrResource',
          { ServiceToken: serviceToken },
          context
        );

        // Warning text only: the outcome is the same as on a destroy.
        expect(result).toEqual({ outcome: 'skipped', reason });
        const text = warnings();
        expect(text).not.toContain(DESTROY_REMEDY);
        expect(text).not.toContain("clear the stack's records");
        expect(text).toContain(DEPLOY_PROHIBITION);
        // The prohibition is the ONLY mention of the command.
        expect(occurrences(text, 'cdkd state orphan')).toBe(1);
        expect(text).toContain('re-deploy');
        expect(text).toContain("'cdkd deploy --allow-unaddressed' exits 0");
        expect(text).toContain('https://github.com/go-to-k/cdkd/issues/1762');
        // A delete-first replacement or a rollback usually keeps the record;
        // only where the other copy already exists is one left untracked
        // (review of #4603).
        expect(text).toContain('usually FAILS the resource and keeps the record');
        expect(text).toContain('created the new resource first');
        expect(text).toContain('re-created the old one first');
        // A create-first replacement's cleanup skip replaces the record, so
        // the kept record is stated only scoped to a template removal.
        expect(text).not.toContain('cdkd is KEEPING the state record');
        expect(text).toContain('For a resource removed from the template the record is KEPT');
        // Also reached from `cdkd rollback`, which has no such flag.
        expect(text).toContain("'cdkd rollback' has none");
      }
    );
  });
});
