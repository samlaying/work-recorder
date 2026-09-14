import test from 'node:test';
import assert from 'node:assert/strict';
import { withSqliteRetry } from '../src/db-retry.js';

test('withSqliteRetry retries SQLITE_BUSY with bounded backoff', async () => {
  let attempts = 0;
  const result = await withSqliteRetry(() => {
    attempts += 1;
    if (attempts < 3) {
      const error = new Error('database is locked');
      error.code = 'SQLITE_BUSY';
      throw error;
    }
    return 'ok';
  }, { retries: 3, baseDelayMs: 1, maxDelayMs: 2 });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);
});

test('withSqliteRetry stops after the retry budget', async () => {
  let attempts = 0;
  await assert.rejects(
    withSqliteRetry(() => {
      attempts += 1;
      const error = new Error('database is locked');
      error.code = 'SQLITE_BUSY';
      throw error;
    }, { retries: 2, baseDelayMs: 1, maxDelayMs: 2 }),
    /database is locked/
  );
  assert.equal(attempts, 3);
});

test('withSqliteRetry does not retry unrelated errors', async () => {
  let attempts = 0;
  await assert.rejects(
    withSqliteRetry(() => {
      attempts += 1;
      throw new Error('syntax error');
    }, { retries: 3, baseDelayMs: 1 }),
    /syntax error/
  );
  assert.equal(attempts, 1);
});
