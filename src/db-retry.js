const DEFAULTS = { retries: 4, baseDelayMs: 25, maxDelayMs: 500 };

export function isSqliteBusy(error) {
  return /database is locked|database is busy|SQLITE_BUSY|SQLITE_LOCKED/i.test(
    `${error?.code ?? ''} ${error?.message ?? error ?? ''}`
  );
}

function options(input) {
  return { ...DEFAULTS, ...(input ?? {}) };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withSqliteRetry(operation, input) {
  const opts = options(input);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= opts.retries) throw error;
      await delay(Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt));
    }
  }
}

export function withSqliteRetrySync(operation, input) {
  const opts = options(input);
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt >= opts.retries) throw error;
      const end = Date.now() + Math.min(opts.maxDelayMs, opts.baseDelayMs * 2 ** attempt);
      while (Date.now() < end) {}
    }
  }
}
