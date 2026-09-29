/**
 * `replacementRequestsDifferentName` (issue #3808): a positive answer REFUSES
 * the `--replace` delete-first retry, so every "may be the same name" shape
 * must answer `undefined`, and only a KNOWN difference may answer.
 */
import { describe, it, expect } from 'vite-plus/test';
import {
  renderNameHeldElsewhere,
  replacementRequestsDifferentName,
} from '../../../src/deployment/replacement-name-holder.js';
import { SECRET_MASK } from '../../../src/deployment/secret-redaction.js';

const FN = 'AWS::Lambda::Function';

function ask(over: Partial<Parameters<typeof replacementRequestsDifferentName>[0]>) {
  return replacementRequestsDifferentName({
    oldResourceType: FN,
    newResourceType: FN,
    desiredProperties: { FunctionName: 'taken-name' },
    recorded: { FunctionName: 'my-fn' },
    observed: undefined,
    physicalId: 'my-fn',
    ...over,
  });
}

describe('replacementRequestsDifferentName', () => {
  it('answers when the recorded name differs from the desired one', () => {
    expect(ask({})).toEqual({
      property: 'FunctionName',
      desiredName: 'taken-name',
      heldName: 'my-fn',
      heldProperty: 'FunctionName',
      physicalId: 'my-fn',
    });
  });

  it('answers undefined when the replacement keeps the name (the --replace case)', () => {
    expect(ask({ desiredProperties: { FunctionName: 'my-fn' } })).toBeUndefined();
  });

  it('compares case-insensitively, since some services treat case variants as one name', () => {
    expect(ask({ desiredProperties: { FunctionName: 'MY-FN' } })).toBeUndefined();
  });

  it('answers undefined when the template declares no explicit name', () => {
    expect(ask({ desiredProperties: { Runtime: 'nodejs22.x' } })).toBeUndefined();
    expect(ask({ desiredProperties: { FunctionName: '' } })).toBeUndefined();
    expect(ask({ desiredProperties: { FunctionName: { Ref: 'X' } } })).toBeUndefined();
  });

  it('answers undefined for a type with no known name property', () => {
    expect(
      ask({
        oldResourceType: 'AWS::Pipes::Pipe',
        newResourceType: 'AWS::Pipes::Pipe',
        desiredProperties: { Name: 'taken-name' },
        recorded: { Name: 'my-pipe' },
      })
    ).toBeUndefined();
  });

  it('reads the observed name when the recorded bag has none', () => {
    expect(
      ask({ recorded: {}, observed: { FunctionName: 'taken-name' } })
    ).toBeUndefined();
    expect(
      ask({ recorded: {}, observed: { FunctionName: 'my-fn' } })?.heldName
    ).toBe('my-fn');
  });

  it('prefers the recorded name over the observed one', () => {
    expect(
      ask({
        recorded: { FunctionName: 'taken-name' },
        observed: { FunctionName: 'other' },
      })
    ).toBeUndefined();
  });

  it('skips a redacted recorded value rather than reading it as a name', () => {
    // With the mask skipped, the physical id decides: it embeds the name.
    expect(
      ask({
        recorded: { FunctionName: SECRET_MASK },
        physicalId: 'taken-name',
      })
    ).toBeUndefined();
  });

  it('skips an unresolved dynamic reference state keeps as written', () => {
    // The desired bag is RESOLVED; the record keeps the expression. Read as a
    // name it would differ from the plaintext and refuse a same-name --replace.
    expect(
      ask({
        desiredProperties: { FunctionName: 'my-fn' },
        recorded: { FunctionName: '{{resolve:secretsmanager:app:SecretString:fn}}' },
        physicalId: 'my-fn',
      })
    ).toBeUndefined();
  });

  it('does not render an unresolved reference as the held name', () => {
    const change = ask({
      recorded: { FunctionName: '{{resolve:secretsmanager:app:SecretString:fn}}' },
      physicalId: 'sg-opaque',
    });
    expect(change).toBeDefined();
    expect(change?.heldName).toBeUndefined();
  });

  it('lets a physical id naming the desired name override a differing recorded one', () => {
    // IAM normalises `_` to `-`: the record keeps the template's `app_role`
    // while AWS holds `app-role`, which the template now spells directly.
    expect(
      ask({
        oldResourceType: 'AWS::IAM::Role',
        newResourceType: 'AWS::IAM::Role',
        desiredProperties: { RoleName: 'app-role' },
        recorded: { RoleName: 'app_role' },
        physicalId: 'app-role',
      })
    ).toBeUndefined();
  });

  describe('with no recorded name, the physical id stands in', () => {
    it('answers when the desired name appears nowhere in the physical id', () => {
      expect(ask({ recorded: {}, physicalId: 'MyStack-Fn' })).toEqual({
        property: 'FunctionName',
        desiredName: 'taken-name',
        heldName: undefined,
        heldProperty: undefined,
        physicalId: 'MyStack-Fn',
      });
    });

    it('answers undefined when the physical id embeds the desired name (an ARN or URL)', () => {
      expect(
        ask({
          recorded: {},
          physicalId: 'arn:aws:lambda:us-east-1:123456789012:function:Taken-Name',
        })
      ).toBeUndefined();
    });

    it('answers for a desired name that is only a SUBSTRING of the physical id', () => {
      // A generated `{stack}-{logicalId}` embeds a logical-id-shaped name; the
      // old resource still does not hold it.
      expect(
        ask({ recorded: {}, desiredProperties: { FunctionName: 'orders' }, physicalId: 'MyStack-Orders' })
      ).toBeDefined();
      expect(
        ask({ recorded: {}, desiredProperties: { FunctionName: 'mystack' }, physicalId: 'MyStack-Orders' })
      ).toBeDefined();
    });

    it('reads a queue URL and an IAM path by their final segment', () => {
      expect(
        ask({
          recorded: {},
          physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/taken-name',
        })
      ).toBeUndefined();
      expect(
        ask({ recorded: {}, physicalId: 'arn:aws:iam::123456789012:role/app/taken-name' })
      ).toBeUndefined();
    });

    it("reads Secrets Manager's 6-character suffix as the same name", () => {
      expect(
        ask({
          recorded: {},
          physicalId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:taken-name-AbC123',
        })
      ).toBeUndefined();
    });

    it('does not read a `/` inside a name-shaped physical id as a separator', () => {
      // SSM `/app/db` renamed to `db`, which another parameter holds.
      expect(
        ask({
          oldResourceType: 'AWS::SSM::Parameter',
          newResourceType: 'AWS::SSM::Parameter',
          desiredProperties: { Name: 'db' },
          recorded: { Name: '/app/db' },
          physicalId: '/app/db',
        })
      ).toBeDefined();
      expect(ask({ recorded: {}, physicalId: '/aws/lambda/taken-name' })).toBeDefined();
    });

    it('reads a `|`-joined composite id by its final segment', () => {
      expect(ask({ recorded: {}, physicalId: 'my-bus|taken-name' })).toBeUndefined();
    });

    it('does not read a longer secret name as the desired one', () => {
      expect(
        ask({
          recorded: {},
          desiredProperties: { FunctionName: 'taken' },
          physicalId: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:taken-name-AbC123',
        })
      ).toBeDefined();
    });

    it('answers for an opaque id, refusing (without deleting) even if the name matched', () => {
      expect(ask({ recorded: {}, physicalId: 'sg-0123456789abcdef0' })).toBeDefined();
    });

    it('answers undefined for an empty physical id', () => {
      expect(ask({ recorded: {}, physicalId: '' })).toBeUndefined();
    });
  });

  it('reads the OLD type’s name property on the held side across a Type change', () => {
    // SQS's name property is QueueName; a `FunctionName` on the old bag must
    // not be read for it.
    expect(
      ask({
        oldResourceType: 'AWS::SQS::Queue',
        recorded: { QueueName: 'taken-name', FunctionName: 'my-fn' },
        physicalId: 'https://sqs.us-east-1.amazonaws.com/123456789012/q',
      })
    ).toBeUndefined();
  });
});

describe('renderNameHeldElsewhere', () => {
  it('names both names when state records the held one', () => {
    const text = renderNameHeldElsewhere({
      property: 'FunctionName',
      desiredName: 'taken-name',
      heldName: 'my-fn',
      heldProperty: 'FunctionName',
      physicalId: 'my-fn',
    });
    expect(text).toContain('asks for FunctionName "taken-name"');
    expect(text).toContain('holds FunctionName "my-fn"');
    expect(text).toContain('held by ANOTHER existing resource');
  });

  it('says the old resource does not hold the name when state records none', () => {
    const text = renderNameHeldElsewhere({
      property: 'FunctionName',
      desiredName: 'taken-name',
      heldName: undefined,
      heldProperty: undefined,
      physicalId: 'MyStack-Fn',
    });
    expect(text).toContain('(MyStack-Fn) does not hold that name');
  });

  it('renders a line break in a name inertly', () => {
    const text = renderNameHeldElsewhere({
      property: 'FunctionName',
      desiredName: 'taken\nname',
      heldName: 'my-fn',
      heldProperty: 'FunctionName',
      physicalId: 'my-fn',
    });
    expect(text).not.toContain('\n');
  });
});
