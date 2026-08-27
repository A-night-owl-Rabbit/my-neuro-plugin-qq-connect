const VALID_LEVELS = new Set(['admin', 'trusted', 'normal']);

class PermissionManager {
    constructor(trustedUsers = []) {
        this._users = new Map();
        this._nicknames = new Map();

        for (const user of trustedUsers) {
            const qq = String(user.qq || '').trim();
            if (!qq) continue;
            const level = VALID_LEVELS.has(user.level) ? user.level : 'none';
            this._users.set(qq, level);
            if (user.nickname) this._nicknames.set(qq, user.nickname);
        }
    }

    addUser(qq, level = 'trusted', nickname = '') {
        const id = String(qq).trim();
        if (!id) return;
        this._users.set(id, VALID_LEVELS.has(level) ? level : 'none');
        if (level === 'admin') {
            this._nicknames.delete(id);
        } else if (nickname) {
            this._nicknames.set(id, nickname);
        }
    }

    removeUser(qq) {
        const id = String(qq).trim();
        this._users.delete(id);
        this._nicknames.delete(id);
    }

    getLevel(qq) {
        return this._users.get(String(qq).trim()) || 'none';
    }

    isAdmin(qq) {
        return this.getLevel(qq) === 'admin';
    }

    isTrustedOrAbove(qq) {
        const level = this.getLevel(qq);
        return level === 'admin' || level === 'trusted';
    }

    getNickname(qq) {
        return this._nicknames.get(String(qq).trim()) || null;
    }

    setNickname(qq, nickname) {
        const id = String(qq).trim();
        if (!this._users.has(id)) return false;
        if (this._users.get(id) === 'admin') return false;
        if (nickname) {
            this._nicknames.set(id, nickname);
        } else {
            this._nicknames.delete(id);
        }
        return true;
    }

    findByNickname(nickname) {
        const target = String(nickname).trim();
        if (!target) return [];
        const results = [];
        for (const [qq, name] of this._nicknames) {
            if (name === target && this._users.has(qq)) {
                results.push({ qq, level: this._users.get(qq), nickname: name });
            }
        }
        return results;
    }

    getAdminQQ() {
        for (const [qq, level] of this._users) {
            if (level === 'admin') return qq;
        }
        return null;
    }

    listUsers() {
        const result = [];
        for (const [qq, level] of this._users) {
            const entry = { qq, level };
            const nickname = this._nicknames.get(qq);
            if (nickname) entry.nickname = nickname;
            result.push(entry);
        }
        return result;
    }

    toJSON() {
        return this.listUsers();
    }
}

module.exports = { PermissionManager };
