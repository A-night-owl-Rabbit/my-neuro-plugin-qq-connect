const VALID_LEVELS = new Set(['trusted', 'open', 'normal']);

class GroupPermissionManager {
    constructor(trustedGroups = []) {
        this._groups = new Map();

        for (const group of trustedGroups) {
            const id = String(group.group_id || '').trim();
            if (!id) continue;
            const level = VALID_LEVELS.has(group.level) ? group.level : 'normal';
            this._groups.set(id, level);
        }
    }

    addGroup(groupId, level = 'normal') {
        const id = String(groupId).trim();
        this._groups.set(id, VALID_LEVELS.has(level) ? level : 'normal');
    }

    removeGroup(groupId) {
        this._groups.delete(String(groupId).trim());
    }

    getLevel(groupId) {
        return this._groups.get(String(groupId).trim()) || 'none';
    }

    isTrusted(groupId) {
        return this.getLevel(groupId) === 'trusted';
    }

    isOpen(groupId) {
        return this.getLevel(groupId) === 'open';
    }

    isAllowed(groupId) {
        return VALID_LEVELS.has(this.getLevel(groupId));
    }

    listGroups() {
        const result = [];
        for (const [groupId, level] of this._groups) {
            result.push({ group_id: groupId, level });
        }
        return result;
    }

    toJSON() {
        return this.listGroups();
    }
}

module.exports = { GroupPermissionManager };
