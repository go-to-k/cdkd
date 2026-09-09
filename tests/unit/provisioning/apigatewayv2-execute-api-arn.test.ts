/**
 * `AWS::ApiGatewayV2::Api`'s constructed `ExecuteApiArn` attribute (issue
 * [#2833](https://github.com/go-to-k/cdkd/issues/2833)).
 *
 * AWS published this read-only attribute in the schema capture refreshed by
 * issue [#2821](https://github.com/go-to-k/cdkd/issues/2821), and `CreateApi`
 * does not return it. A cross-resource `Fn::GetAtt` reads the CACHED
 * `resource.attributes[<CFnName>]` and never calls `getAttribute`, so an absent
 * `*Arn` reaches `guardedPhysicalIdFallback`, which HARD-THROWS because the
 * physical id is a bare api id — the issue #1179 class, a broken deploy rather
 * than a wrong value.
 *
 * `scripts/gen-sdk-attr-coverage.ts` proves the attribute is recorded SOMEWHERE
 * in the file; only this suite proves the CREATE path records it, and with what.
 */
import { describe, it, expect, vi, beforeEach } from 'vite-plus/test';
import { CreateApiCommand, DeleteCorsConfigurationCommand } from '@aws-sdk/client-apigatewayv2';

const mockSend = vi.fn();
/** Injectable so the reachable failure — no region configured — can be driven. */
const regionFn = vi.fn(() => Promise.resolve('us-east-1'));

vi.mock('@aws-sdk/client-apigatewayv2', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return {
    ...orig,
    ApiGatewayV2Client: vi.fn().mockImplementation(() => ({
      send: mockSend,
      config: { region: regionFn },
    })),
  };
});

const mockGetAccountInfo = vi.fn();
vi.mock('../../../src/deployment/intrinsic-function-resolver.js', async (importOriginal) => {
  const orig = (await importOriginal()) as Record<string, unknown>;
  return { ...orig, getAccountInfo: (...args: unknown[]) => mockGetAccountInfo(...args) };
});

const warn = vi.fn();
/** Hoisted like `warn`: an inline `vi.fn()` leaves the debug line unassertable. */
const debug = vi.fn();
vi.mock('../../../src/utils/logger.js', () => {
  const child = { debug, info: vi.fn(), warn, error: vi.fn(), child: vi.fn() };
  child.child = vi.fn().mockReturnValue(child);
  return { getLogger: () => child };
});

const { ApiGatewayV2Provider } = await import(
  '../../../src/provisioning/providers/apigatewayv2-provider.js'
);

const createApi = async () => {
  const provider = new ApiGatewayV2Provider();
  return provider.create('Api', 'AWS::ApiGatewayV2::Api', { Name: 'n', ProtocolType: 'HTTP' });
};

describe('AWS::ApiGatewayV2::Api ExecuteApiArn', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockGetAccountInfo.mockReset();
    warn.mockReset();
    debug.mockReset();
    regionFn.mockReset();
    regionFn.mockResolvedValue('us-east-1');
    mockSend.mockResolvedValue({ ApiId: 'abc123', ApiEndpoint: 'https://abc123.example' });
  });

  it('records the constructed ARN alongside ApiId and ApiEndpoint', async () => {
    mockGetAccountInfo.mockResolvedValue({
      accountId: '111122223333',
      region: 'us-east-1',
      partition: 'aws',
      fabricated: false,
    });
    const result = await createApi();
    expect(result.attributes).toEqual({
      ApiId: 'abc123',
      ApiEndpoint: 'https://abc123.example',
      ExecuteApiArn: 'arn:aws:execute-api:us-east-1:111122223333:abc123',
    });
  });

  it('resolves the account for the CLIENT’s region, not the ambient default', async () => {
    // The one production input this method chooses. `getAccountInfo()` with no
    // argument falls back to `process.env.AWS_REGION`, so a deploy targeting
    // another region records an ARN for the wrong one — the #1795 / #1814
    // class. Every other case reads region and partition off the mock's own
    // RETURN, so dropping the argument left them all green (measured).
    // A NON-default region, so the assertion is value-discriminating: with
    // `'us-east-1'` on both sides a hardcoded literal in production passes.
    regionFn.mockResolvedValue('ap-northeast-1');
    mockGetAccountInfo.mockResolvedValue({
      accountId: '111122223333',
      region: 'ap-northeast-1',
      partition: 'aws',
      fabricated: false,
    });
    const result = await createApi();
    expect(mockGetAccountInfo).toHaveBeenCalledWith('ap-northeast-1');
    expect(result.attributes?.['ExecuteApiArn']).toBe(
      'arn:aws:execute-api:ap-northeast-1:111122223333:abc123'
    );
  });

  it('derives the partition rather than hardcoding `aws`', async () => {
    // A hardcoded partition records an ARN naming a partition the API is not
    // in — persisted into state.json, so the wrong value outlives the deploy.
    mockGetAccountInfo.mockResolvedValue({
      accountId: '111122223333',
      region: 'cn-north-1',
      partition: 'aws-cn',
      fabricated: false,
    });
    const result = await createApi();
    expect(result.attributes?.['ExecuteApiArn']).toBe(
      'arn:aws-cn:execute-api:cn-north-1:111122223333:abc123'
    );
  });

  it('canonicalizes the region segment (defence in depth)', async () => {
    // DEFENCE IN DEPTH, and the case says so rather than implying the fold is
    // the only one: `getAccountInfo` returns a region already run through
    // `canonicalizeRegion`, so `US-EAST-1` is a value the real dependency
    // cannot emit and this case only reaches the guard because the mock
    // supplies it. Kept because the fold is free and an unfolded region is
    // persisted (#1795 / #1814); NOT kept as evidence the guard is load-bearing.
    mockGetAccountInfo.mockResolvedValue({
      accountId: '111122223333',
      region: 'US-EAST-1',
      partition: 'aws',
      fabricated: false,
    });
    const result = await createApi();
    expect(result.attributes?.['ExecuteApiArn']).toBe(
      'arn:aws:execute-api:us-east-1:111122223333:abc123'
    );
  });

  it('records NOTHING and warns when the account is fabricated', async () => {
    // An ARN naming a placeholder account is worse than an absent one: it is
    // persisted and looks real. Same refusal `SSMParameterProvider` makes.
    mockGetAccountInfo.mockResolvedValue({
      accountId: '123456789012',
      region: 'us-east-1',
      partition: 'aws',
      fabricated: true,
    });
    const result = await createApi();
    expect(result.attributes).toEqual({
      ApiId: 'abc123',
      ApiEndpoint: 'https://abc123.example',
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ExecuteApiArn'));
  });

  it('still creates the API when the ARN cannot be built, and WARNS', async () => {
    // Pointed at `config.region()` rejecting, which is the reachable throw:
    // `getAccountInfo` does NOT reject when STS is unreachable, it returns
    // `{ fabricated: true }` — the case above. An earlier version of this case
    // rejected `getAccountInfo` and so exercised the catch through a shape the
    // dependency never produces.
    //
    // The API exists by the time this runs, so a failure must not fail the
    // CREATE. It must not be SILENT either: without the warn the only symptom
    // is a later `Fn::GetAtt` hard-throwing from the resolver, naming nothing
    // about the create-time cause.
    regionFn.mockRejectedValueOnce(new Error('no region configured'));
    const result = await createApi();
    expect(result.physicalId).toBe('abc123');
    expect(result.attributes?.['ExecuteApiArn']).toBeUndefined();
    expect(result.attributes?.['ApiId']).toBe('abc123');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('ExecuteApiArn'));
  });

  it('builds the ARN from the CREATE response id, not from a request field', async () => {
    // A physical id read off the request would be `undefined` here, and the
    // constructed ARN would silently end in a bare colon.
    mockGetAccountInfo.mockResolvedValue({
      accountId: '111122223333',
      region: 'us-east-1',
      partition: 'aws',
      fabricated: false,
    });
    mockSend.mockResolvedValue({ ApiId: 'fromResponse', ApiEndpoint: 'https://x.example' });
    const result = await createApi();
    expect(result.attributes?.['ExecuteApiArn']).toContain(':fromResponse');
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(CreateApiCommand);
  });
});

describe('AWS::ApiGatewayV2::Api ExecuteApiArn on the import and update paths', () => {
  const ACCOUNT = {
    accountId: '111122223333',
    region: 'us-east-1',
    partition: 'aws',
    fabricated: false,
  };

  beforeEach(() => {
    mockSend.mockReset();
    mockGetAccountInfo.mockReset();
    warn.mockReset();
    debug.mockReset();
    regionFn.mockReset();
    regionFn.mockResolvedValue('us-east-1');
    mockGetAccountInfo.mockResolvedValue(ACCOUNT);
  });

  it('records the same attributes on IMPORT as on create', async () => {
    // An adopted API that carried none would hard-throw on
    // `Fn::GetAtt ExecuteApiArn` while a created one resolved — the split
    // `AppSyncProvider.childImportAttributes` closed for its siblings, and this
    // change is what makes users reach for the attribute at all.
    mockSend.mockResolvedValue({ ApiId: 'imported1', ApiEndpoint: 'https://imported.example' });
    const provider = new ApiGatewayV2Provider();
    const result = await provider.import({
      logicalId: 'Api',
      resourceType: 'AWS::ApiGatewayV2::Api',
      stackName: 'Stack',
      region: 'us-east-1',
      properties: {},
      // The provider is explicit-override only for this type, and
      // `resolveExplicitPhysicalId(input, null)` reads exactly this field.
      knownPhysicalId: 'imported1',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    expect(result?.physicalId).toBe('imported1');
    expect(result?.attributes).toEqual({
      ApiId: 'imported1',
      ApiEndpoint: 'https://imported.example',
      ExecuteApiArn: 'arn:aws:execute-api:us-east-1:111122223333:imported1',
    });
  });

  it('HEALS a record written before the attribute existed, on update', async () => {
    // `ExecuteApiArn` is NEW, so no state record written by an earlier binary
    // carries it — EVERY existing API is in that state. Without re-recording
    // here the fix would only ever help APIs created after it, which is most of
    // its value gone.
    mockSend.mockResolvedValue({ ApiId: 'api1', ApiEndpoint: 'https://healed.example' });
    const provider = new ApiGatewayV2Provider();
    const result = await provider.update(
      'Api',
      'api1',
      'AWS::ApiGatewayV2::Api',
      { Name: 'after', ProtocolType: 'HTTP' },
      { Name: 'before', ProtocolType: 'HTTP' }
    );
    // COMPLETE, not partial: the engine REPLACES attributes when an update
    // returns any, so omitting `ApiEndpoint` here would DROP it from state.
    expect(result.attributes).toEqual({
      ApiId: 'api1',
      ApiEndpoint: 'https://healed.example',
      ExecuteApiArn: 'arn:aws:execute-api:us-east-1:111122223333:api1',
    });
  });

  it('carries the old map forward on the CORS-only arm rather than truncating it', async () => {
    // The arm that REACHES the guard: no mutable Api field changed, but CORS was
    // removed — so `updateApi` enters its `try`, issues
    // `DeleteCorsConfiguration`, calls no `UpdateApi`, and has no endpoint to
    // re-emit. Returning a partial map would REPLACE the stored one and lose
    // `ApiEndpoint`; returning none lets the engine keep what it has.
    //
    // An earlier version of this case passed IDENTICAL properties, which exits
    // at the pre-existing `!changed && !corsRemoved` early return WITHOUT
    // entering the `try` — so it named this guard while never reaching it, and
    // deleting the guard left it green (measured).
    const provider = new ApiGatewayV2Provider();
    const result = await provider.update(
      'Api',
      'api1',
      'AWS::ApiGatewayV2::Api',
      { Name: 'same', ProtocolType: 'HTTP' },
      { Name: 'same', ProtocolType: 'HTTP', CorsConfiguration: { AllowOrigins: ['*'] } }
    );
    expect(result.attributes).toBeUndefined();
    // Proof the arm ran: exactly the CORS delete, and no `UpdateApi`.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0]![0]).toBeInstanceOf(DeleteCorsConfigurationCommand);
    // The ARN is built ONLY when there is an endpoint to pair it with. Without
    // this the gate could be made unconditional and every case above still
    // passes: the account resolves, the ARN is built, `apiEndpoint === undefined`
    // still declines, and `attributes` is still undefined — so the only lost
    // behavior (an STS round trip and a fabricated-account warn about an
    // attribute that will not be written) would go unwatched.
    expect(mockGetAccountInfo).not.toHaveBeenCalled();
  });

  it('carries the old map forward when the ARN cannot be built, rather than erasing it', async () => {
    // The destructive shape, and it is REACHABLE and TRANSIENT: `getAccountInfo`
    // does not reject when STS is unreachable, it returns `fabricated: true`.
    // Writing `{ ApiId, ApiEndpoint }` here REPLACES the stored map (the engine
    // does not merge), so an `ExecuteApiArn` an earlier deploy recorded
    // correctly is erased — and a consumer's `Fn::GetAtt` reading the freshly
    // written attributes in the SAME deploy hard-throws, with the loss
    // persisted. Worse than not healing at all.
    mockGetAccountInfo.mockResolvedValue({ ...ACCOUNT, fabricated: true });
    mockSend.mockResolvedValue({ ApiId: 'api1', ApiEndpoint: 'https://healed.example' });
    const provider = new ApiGatewayV2Provider();
    const result = await provider.update(
      'Api',
      'api1',
      'AWS::ApiGatewayV2::Api',
      { Name: 'after', ProtocolType: 'HTTP' },
      { Name: 'before', ProtocolType: 'HTTP' }
    );
    expect(result.attributes).toBeUndefined();
    // Proof the heal arm ran and DECLINED, rather than never being reached.
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockGetAccountInfo).toHaveBeenCalled();
    // And that the decline is reported AT THE HEAL SITE. `buildExecuteApiArn`
    // already warns about the ARN it could not build; this line is the only
    // thing saying the previously recorded attributes were kept instead.
    // Without it the whole rationale for the line is unheld — deleting it red
    // nothing suite-wide (measured).
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('ExecuteApiArn heal'));
  });

  it('makes no call and records nothing when nothing changed at all', async () => {
    // The pre-existing early return, kept as its own case so the arm above
    // cannot silently absorb it again.
    const provider = new ApiGatewayV2Provider();
    const result = await provider.update(
      'Api',
      'api1',
      'AWS::ApiGatewayV2::Api',
      { Name: 'same', ProtocolType: 'HTTP' },
      { Name: 'same', ProtocolType: 'HTTP' }
    );
    expect(result.attributes).toBeUndefined();
    expect(mockSend).not.toHaveBeenCalled();
  });
});
