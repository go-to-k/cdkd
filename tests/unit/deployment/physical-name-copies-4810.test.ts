/**
 * Issue [#4810](https://github.com/go-to-k/cdkd/issues/4810): the value scan
 * keeps a recorded-plaintext match inside an occurrence of a physical id the
 * pass read (`recordPhysicalNameCopy`), and nothing else. The bag below is what
 * a GetAtt reader of a secret-named queue holds once its ARN was re-resolved
 * (go-to-k/cdkd#4800): the queue name, mapped to its reference.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  recordPhysicalNameCopy,
  redactSecretsForState,
  scrubResourceRecord,
  type RecordedSecretValues,
} from '../../../src/deployment/secret-redaction.js';

const REF = '{{resolve:secretsmanager:sdin:SecretString:queue::}}';
const NAME = 'sdin-q-1';
const URL = `https://sqs.us-east-1.amazonaws.com/123456789012/${NAME}`;
const ARN = `arn:aws:sqs:us-east-1:123456789012:${NAME}`;
const OTHER_REF = '{{resolve:secretsmanager:other:SecretString:pw::}}';
const OTHER = 'other-secret-pw';

function readerBag(withCopy: boolean): RecordedSecretValues {
  const bag: RecordedSecretValues = new Map([
    [NAME, REF],
    [OTHER, OTHER_REF],
  ]);
  if (withCopy) recordPhysicalNameCopy(bag, URL);
  return bag;
}

describe('a reader copy of a read physical id (#4810)', () => {
  it('stays plaintext whole, embedded, and in a list; the ARN copy is still redacted', () => {
    const props = {
      Queues: [URL],
      Embedded: `queue=${URL};`,
      Arn: ARN,
    };
    expect(redactSecretsForState(props, readerBag(true))).toEqual({
      Queues: [URL],
      Embedded: `queue=${URL};`,
      Arn: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
    });
  });

  it('control: without the recorded copy, the URL is rewritten (the pre-fix persist)', () => {
    expect(redactSecretsForState({ Queues: [URL] }, readerBag(false))).toEqual({
      Queues: [`https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`],
    });
  });

  it('a secret outside the copy in the same leaf is still redacted', () => {
    expect(redactSecretsForState({ V: `${URL}?pw=${OTHER}` }, readerBag(true))).toEqual({
      V: `${URL}?pw=${OTHER_REF}`,
    });
  });

  it('a needle straddling the edge of the copy is still redacted', () => {
    // `q-1-tail` is a recorded secret that begins inside the URL and ends past it.
    const bag: RecordedSecretValues = new Map([['q-1-tail', '{{resolve:secretsmanager:t}}']]);
    recordPhysicalNameCopy(bag, URL);
    expect(redactSecretsForState({ V: `${URL}-tail` }, bag)).toEqual({
      V: `https://sqs.us-east-1.amazonaws.com/123456789012/sdin-{{resolve:secretsmanager:t}}`,
    });
  });

  it('a leaf equal to a read physical id that is itself a recorded plaintext stays as it is', () => {
    // A log group NAMED from a secret: its physical id IS the name.
    const bag: RecordedSecretValues = new Map([[NAME, REF]]);
    recordPhysicalNameCopy(bag, NAME);
    expect(redactSecretsForState({ LogGroupName: NAME }, bag)).toEqual({ LogGroupName: NAME });
  });

  it('a copy recorded for one bag does not protect another', () => {
    recordPhysicalNameCopy(readerBag(false), URL);
    expect(redactSecretsForState({ Queues: [URL] }, readerBag(false))).toEqual({
      Queues: [`https://sqs.us-east-1.amazonaws.com/123456789012/${REF}`],
    });
  });

  it('through scrubResourceRecord, a literal reference leaf is still persisted as the reference', () => {
    const record = {
      properties: { Queues: [URL], Resource: ARN },
      attributes: { Url: URL },
    };
    const scrubbed = scrubResourceRecord(record, readerBag(true), {
      Queues: [{ Ref: 'SecretQueue' }],
      Resource: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
    });
    expect(scrubbed.properties).toEqual({
      Queues: [URL],
      Resource: `arn:aws:sqs:us-east-1:123456789012:${REF}`,
    });
    expect(scrubbed.attributes).toEqual({ Url: URL });
  });
});
