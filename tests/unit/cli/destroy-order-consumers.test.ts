import { describe, it, expect } from 'vite-plus/test';
import { orderConsumersBeforeProducers } from '../../../src/cli/commands/destroy.js';

/**
 * `orderConsumersBeforeProducers` topologically reorders the destroy set so a
 * consumer is destroyed BEFORE its producer (the reverse of deploy order),
 * using the consumer → producer edges inferred from cross-stack references.
 */
describe('orderConsumersBeforeProducers', () => {
  it('keeps the original order when there are no cross-stack edges', () => {
    const order = orderConsumersBeforeProducers(['A', 'B', 'C'], new Map());
    expect(order).toEqual(['A', 'B', 'C']);
  });

  it('puts a consumer before its producer (reverse of deploy order)', () => {
    // Consumer depends on Producer (deploy: Producer first). Destroy: Consumer first.
    const edges = new Map([['Consumer', new Set(['Producer'])]]);
    const order = orderConsumersBeforeProducers(['Producer', 'Consumer'], edges);
    expect(order).toEqual(['Consumer', 'Producer']);
  });

  it('orders a 3-stack chain leaf-consumer-first', () => {
    // A <- B <- C (C consumes B consumes A). Destroy must be C, B, A.
    const edges = new Map([
      ['B', new Set(['A'])],
      ['C', new Set(['B'])],
    ]);
    const order = orderConsumersBeforeProducers(['A', 'B', 'C'], edges);
    expect(order).toEqual(['C', 'B', 'A']);
  });

  it('emits a producer only after all of its consumers', () => {
    // P is imported by both C1 and C2. P must be last.
    const edges = new Map([
      ['C1', new Set(['P'])],
      ['C2', new Set(['P'])],
    ]);
    const order = orderConsumersBeforeProducers(['P', 'C1', 'C2'], edges);
    expect(order.indexOf('P')).toBe(2);
    expect(order.indexOf('C1')).toBeLessThan(2);
    expect(order.indexOf('C2')).toBeLessThan(2);
  });

  it('degrades gracefully on a cycle without dropping nodes', () => {
    // Mutual import (A<->B): unresolvable, but every node must still appear once.
    const edges = new Map([
      ['A', new Set(['B'])],
      ['B', new Set(['A'])],
    ]);
    const order = orderConsumersBeforeProducers(['A', 'B'], edges);
    expect(order.slice().sort()).toEqual(['A', 'B']);
    expect(order.length).toBe(2);
  });
});
