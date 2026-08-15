function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function isRetryablePublisherError(error) {
  return new Set(["EACCES", "EBUSY", "EMFILE", "ENFILE", "EPERM", "ETXTBSY"]).has(error?.code);
}

export class WatchBatchQueue {
  #closed = false;
  #pending = new Map();
  #running = null;

  constructor(processBatch, onError = () => {}) {
    this.processBatch = processBatch;
    this.onError = onError;
  }

  enqueue(filePath) {
    if (this.#closed) return false;
    this.#pending.set(filePath.toLocaleLowerCase("en-US"), filePath);
    this.#schedule();
    return true;
  }

  #schedule() {
    if (this.#running || this.#pending.size === 0) return;
    this.#running = Promise.resolve()
      .then(async () => {
        while (this.#pending.size) {
          const batch = [...this.#pending.values()].sort((left, right) => left.localeCompare(right, "en-US"));
          this.#pending.clear();
          try {
            await this.processBatch(batch);
          } catch (error) {
            this.onError(error);
          }
        }
      })
      .finally(() => {
        this.#running = null;
        if (this.#pending.size) this.#schedule();
      });
  }

  async idle() {
    while (this.#running) await this.#running;
  }

  async close() {
    this.#closed = true;
    await this.idle();
  }
}

export class BuildScheduler {
  #closed = false;
  #pending = false;
  #running = null;
  #timer = null;

  constructor({ delayMs, run, onError = () => {} }) {
    this.delayMs = delayMs;
    this.run = run;
    this.onError = onError;
  }

  request() {
    if (this.#closed) return false;
    this.#pending = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#start();
    }, this.delayMs);
    return true;
  }

  async #start() {
    if (this.#running || !this.#pending) return;
    this.#pending = false;
    this.#running = Promise.resolve()
      .then(() => this.run())
      .catch((error) => this.onError(error))
      .finally(() => {
        this.#running = null;
        if (this.#pending && !this.#closed) this.request();
      });
    await this.#running;
  }

  async flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (this.#running) await this.#running;
    if (this.#pending) await this.#start();
  }

  async close({ flush = true } = {}) {
    this.#closed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    if (flush) await this.flush();
    else this.#pending = false;
    if (this.#running) await this.#running;
  }
}

export async function publishBatchWithRetries(sources, publish, options = {}) {
  const retryAttempts = Math.max(0, Number(options.retryAttempts) || 0);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs) || 0);
  const results = new Map();
  let pending = [...sources];
  let attempt = 0;
  let changed = false;

  while (pending.length) {
    let report;
    try {
      report = await publish(pending);
    } catch (error) {
      report = {
        changed: false,
        results: pending.map((source) => ({ status: "failed", source: source.source, output: source.output, error })),
      };
    }
    changed ||= report.changed === true;

    const sourcesByName = new Map(pending.map((source) => [source.source.toLocaleLowerCase("en-US"), source]));
    const retry = [];
    for (const result of report.results) {
      const key = result.source.toLocaleLowerCase("en-US");
      if (result.status === "failed" && attempt < retryAttempts && isRetryablePublisherError(result.error)) {
        const source = sourcesByName.get(key);
        if (source) retry.push(source);
        options.onRetry?.(result, attempt + 1);
      } else {
        results.set(key, result);
      }
    }

    pending = retry;
    attempt += 1;
    if (pending.length) await wait(retryDelayMs * attempt);
  }

  return {
    changed,
    results: sources.map((source) => results.get(source.source.toLocaleLowerCase("en-US"))).filter(Boolean),
  };
}
