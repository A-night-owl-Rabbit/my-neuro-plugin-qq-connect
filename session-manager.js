const DEFAULT_TIMEOUT = 300_000;
const MAX_HISTORY = 20;
const SWEEP_INTERVAL = 30_000;

class Session {
    constructor(key, maxHistory = MAX_HISTORY) {
        this.key = key;
        this.history = [];
        this.maxHistory = maxHistory;
        this.lastActivity = Date.now();
    }

    addUserMessage(text) {
        this.history.push({ role: 'user', content: text });
        this._trim();
        this.lastActivity = Date.now();
    }

    addAssistantMessage(text) {
        this.history.push({ role: 'assistant', content: text });
        this._trim();
        this.lastActivity = Date.now();
    }

    touch() {
        this.lastActivity = Date.now();
    }

    isExpired(timeout) {
        return Date.now() - this.lastActivity > timeout;
    }

    buildMessages(systemPrompt) {
        const msgs = [];
        if (systemPrompt) {
            msgs.push({ role: 'system', content: systemPrompt });
        }
        msgs.push(...this.history);
        return msgs;
    }

    _trim() {
        while (this.history.length > this.maxHistory * 2) {
            this.history.shift();
        }
    }
}

class SessionManager {
    constructor({ timeout = DEFAULT_TIMEOUT, logger = console } = {}) {
        this.timeout = timeout;
        this.logger = logger;
        this._sessions = new Map();
        this._sweepTimer = null;
    }

    start() {
        if (this._sweepTimer) return;
        this._sweepTimer = setInterval(() => this._sweep(), SWEEP_INTERVAL);
    }

    stop() {
        if (this._sweepTimer) {
            clearInterval(this._sweepTimer);
            this._sweepTimer = null;
        }
        this._sessions.clear();
    }

    getOrCreate(key) {
        let session = this._sessions.get(key);
        if (!session) {
            session = new Session(key);
            this._sessions.set(key, session);
            this.logger.info(`[session-mgr] Created session: ${key}`);
        }
        return session;
    }

    get(key) {
        return this._sessions.get(key) || null;
    }

    remove(key) {
        this._sessions.delete(key);
    }

    _sweep() {
        const now = Date.now();
        for (const [key, session] of this._sessions) {
            if (session.isExpired(this.timeout)) {
                this._sessions.delete(key);
                this.logger.info(`[session-mgr] Expired session: ${key}`);
            }
        }
    }

    static buildSessionKey({ userId, messageType, groupId }) {
        if (messageType === 'group' && groupId) {
            return `group:${groupId}:${userId}`;
        }
        return `private:${userId}`;
    }
}

module.exports = { SessionManager, Session };
