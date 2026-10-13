import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitMessage } from '../src/github.mjs';

test('rate limit message: minutes until reset, token hint only without a token', () => {
  const now = 1_000_000_000;
  const h = { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 25 * 60) };
  assert.match(rateLimitMessage(403, h, now, false), /in about 25 min, or set GITHUB_TOKEN/);
  assert.doesNotMatch(rateLimitMessage(403, h, now, true), /GITHUB_TOKEN/);
  assert.equal(rateLimitMessage(403, { 'x-ratelimit-remaining': '12' }, now, true), null);
});
