class RateLimiter {
    constructor({
        windowMs = 60_000,
        count = 30,
        strategy = 'stall',
        logger = console,
    } = {}) {
        this.windowMs = Math.max(1000, Number(windowMs) || 60_000);
        this.count = Math.max(1, Number(count) || 30);
        this.strategy = strategy === 'discard' ? 'discard' : 'stall';
        this.logger = logger;
        this._buckets = new Map();
    }

    async waitTurn(key = 'global') {
        const bucketKey = String(key || 'global');
        while (true) {
            const decision = this._take(bucketKey);
            if (decision.allowed) return true;
            if (this.strategy === 'discard') {
                this.logger.warn?.(`[rate-limiter] Discard message for ${bucketKey}; retry after ${decision.waitMs}ms`);
                return false;
            }
            await this._sleep(decision.waitMs);
        }
    }

    _take(key) {
        const now = Date.now();
        let bucket = this._buckets.get(key);
        if (!bucket || now >= bucket.resetAt) {
            bucket = { used: 0, resetAt: now + this.windowMs };
            this._buckets.set(key, bucket);
        }

        if (bucket.used < this.count) {
            bucket.used += 1;
            return { allowed: true, waitMs: 0 };
        }

        return { allowed: false, waitMs: Math.max(1, bucket.resetAt - now) };
    }

    _sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
}

module.exports = { RateLimiter };
