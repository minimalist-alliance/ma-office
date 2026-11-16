// The real-model proofs' spend and model rules (fleet-run.mjs), in Node: no run on a Fable model (the owner stopped Fable on
// Nov 11), and each reply priced at its own model's list price.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fableProblem, listCost, priceOf } from './fleet-run.mjs';

test('a Fable model is refused, the 5.5 models are not', () => {
  for (const m of ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'CLAUDE-FABLE-6']) assert.match(fableProblem(m), /Fable model/);
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', null, undefined, '']) assert.equal(fableProblem(m), null);
});

test('each model at its own list price; an unlisted one at Opus 5.5', () => {
  const u = { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, cacheWriteTokens: 1_000_000, outputTokens: 1_000_000 };
  assert.equal(listCost(u, 'claude-sonnet-5-5'), 14_700_000);
  assert.equal(listCost(u, 'claude-opus-5-5'), 29_200_000);
  assert.equal(listCost(u, 'claude-haiku-5-5'), 735_000);
  assert.equal(listCost(u, 'claude-fable-5-2'), 58_200_000);
  assert.deepEqual(priceOf('some-new-model'), priceOf('claude-opus-5-5'));
  assert.deepEqual(priceOf('claude-haiku-5-5-20261101'), priceOf('claude-haiku-5-5'));
  assert.equal(listCost(null, 'claude-opus-5-5'), null);
});
