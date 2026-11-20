import { describe, it, expect } from 'vite-plus/test';
import {
  displayPhysicalId,
  secretPhysicalIdSegment,
  withSecretPhysicalIdsMaskedInState,
} from '../../../src/provisioning/secret-physical-id.js';

// go-to-k/cdkd#6694: a WaitConditionHandle's physical id is a pre-signed PUT
// URL, whose query string is the signature that authorizes the PUT.

const TYPE = 'AWS::CloudFormation::WaitConditionHandle';
const BASE = 'https://b.s3.us-east-1.amazonaws.com/wait-condition-signals/H-x.json';
const QUERY =
  'X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=ASIA&X-Amz-Security-Token=tok&X-Amz-Signature=0123456789abcdef';
const URL_ID = `${BASE}?${QUERY}`;

describe('WaitConditionHandle physical id masking', () => {
  it('the query string is the secret segment', () => {
    expect(secretPhysicalIdSegment(TYPE, URL_ID)).toBe(QUERY);
  });

  it('a legacy placeholder or a query-less value carries none', () => {
    expect(secretPhysicalIdSegment(TYPE, 'cdkd-wait-condition-handle-H-uuid')).toBeUndefined();
    expect(secretPhysicalIdSegment(TYPE, `${BASE}?`)).toBeUndefined();
    expect(secretPhysicalIdSegment(TYPE, BASE)).toBeUndefined();
    expect(secretPhysicalIdSegment(TYPE, '')).toBeUndefined();
  });

  it('displays the URL without its signature', () => {
    const shown = displayPhysicalId(TYPE, URL_ID);
    expect(shown).toBe(`${BASE}?****cdef`);
    expect(shown).not.toContain('X-Amz-Signature');
  });

  it('masks every copy of the URL in a displayed state (e.g. in user data)', () => {
    const state = {
      resources: {
        Handle: { resourceType: TYPE, physicalId: URL_ID, properties: {} },
        Instance: {
          resourceType: 'AWS::EC2::Instance',
          physicalId: 'i-1',
          properties: { Tags: [{ Key: 'signal', Value: `curl -X PUT '${URL_ID}'` }] },
        },
      },
    };
    const shown = JSON.stringify(withSecretPhysicalIdsMaskedInState(state));
    expect(shown).not.toContain('X-Amz-Signature=');
    expect(shown).toContain(`${BASE}?****cdef`);
  });

  it('another type with a URL id is untouched', () => {
    expect(secretPhysicalIdSegment('AWS::SQS::Queue', URL_ID)).toBeUndefined();
  });
});
