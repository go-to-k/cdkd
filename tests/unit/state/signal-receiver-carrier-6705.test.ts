import { describe, it, expect } from 'vite-plus/test';
import { stackInstanceIdCarriedFrom } from '../../../src/types/state/helpers.js';

describe('stackInstanceIdCarriedFrom and signalReceiverStackId (go-to-k/cdkd#6705)', () => {
  it('carries a string receiver id verbatim', () => {
    expect(stackInstanceIdCarriedFrom({ signalReceiverStackId: 'arn:x' })).toEqual({
      signalReceiverStackId: 'arn:x',
    });
  });

  it('drops a non-string value and an absent record', () => {
    for (const bad of [1, true, {}, null]) {
      const out = stackInstanceIdCarriedFrom({ signalReceiverStackId: bad } as never);
      expect(Object.hasOwn(out, 'signalReceiverStackId')).toBe(false);
    }
    expect(Object.hasOwn(stackInstanceIdCarriedFrom(undefined), 'signalReceiverStackId')).toBe(false);
  });
});
