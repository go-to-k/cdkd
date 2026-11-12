import { afterEach, describe, expect, it } from 'vite-plus/test';

import {
  pasteableAwsProfileFlag,
  setPasteableAwsProfile,
  withPasteableAwsProfile,
} from '../../../src/utils/pasteable-aws-profile.js';
import {
  resetAwsClientDefaults,
  setAssumedRoleCredentials,
  setAwsEndpointOverrideSource,
} from '../../../src/utils/aws-client-defaults.js';

/**
 * go-to-k/cdkd#6138: under `--aws-emulator` the run's `--profile` is dropped
 * while the operator's shell still holds real credentials, so a pasted
 * `aws ...` remedy must name the emulator's endpoint, never run bare.
 */
afterEach(() => {
  setAwsEndpointOverrideSource(undefined);
  setPasteableAwsProfile(undefined);
  resetAwsClientDefaults();
});

describe('pasteable aws commands under --aws-emulator', () => {
  it('carry --endpoint-url, ahead of any profile or role arm', () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9331' }));
    setPasteableAwsProfile('prod');
    setAssumedRoleCredentials({ accessKeyId: 'A', secretAccessKey: 'B', sessionToken: 'C' });
    expect(withPasteableAwsProfile('aws scheduler delete-schedule --name X')).toBe(
      'aws --endpoint-url https://127.0.0.1:9331 scheduler delete-schedule --name X'
    );
  });

  it('print a hole for an endpoint that is not inert in a shell', () => {
    setAwsEndpointOverrideSource(() => ({ endpoint: 'https://127.0.0.1:9331;x' }));
    expect(pasteableAwsProfileFlag()).toBe("--endpoint-url '<endpoint-url>'");
  });

  it('are unchanged without the flag', () => {
    setPasteableAwsProfile('prod');
    expect(withPasteableAwsProfile('aws s3 ls')).toBe('aws --profile prod s3 ls');
    setPasteableAwsProfile(undefined);
    expect(withPasteableAwsProfile('aws s3 ls')).toBe('aws s3 ls');
  });
});
