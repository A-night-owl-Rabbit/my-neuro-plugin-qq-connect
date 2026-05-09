const EventEmitter = require('events');

const RECONNECT_MIN_DELAY = 1000;
const RECONNECT_MAX_DELAY = 30000;
const DEFAULT_ACTION_TIMEOUT = 10_000;
const DEFAULT_FORWARD_EXPAND_LIMIT = 4000;
const QQ_OFFICIAL_ACCOUNT_ID = '2854196310';

class QQClient extends EventEmitter {
    constructor({
        onebotUrl,
        token = '',
        logger = console,
        actionTimeoutMs = DEFAULT_ACTION_TIMEOUT,
        forwardExpandLimit = DEFAULT_FORWARD_EXPAND_LIMIT,
        ignoreAtAll = true,
        ignoreSelfMessage = true,
        ignoreQQOfficialAccount = true,
        warnEmptyToken = true,
        aiName = '肥牛',
    }) {
        super();
        this.onebotUrl = onebotUrl;
        this.token = token;
        this.logger = logger;
        this.actionTimeoutMs = actionTimeoutMs;
        this.forwardExpandLimit = forwardExpandLimit;
        this.ignoreAtAll = ignoreAtAll;
        this.ignoreSelfMessage = ignoreSelfMessage;
        this.ignoreQQOfficialAccount = ignoreQQOfficialAccount;
        this.warnEmptyToken = warnEmptyToken;
        this.aiName = aiName;

        this.ws = null;
        this._closing = false;
        this._reconnectDelay = RECONNECT_MIN_DELAY;
        this._reconnectTimer = null;
        this._pending = new Map();
        this._echoSeq = 0;
        this._warnedEmptyToken = false;
        this.reconnectCount = 0;
        this.lastError = null;
        this.lastEventAt = 0;
    }

    get connected() {
        return this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    connect() {
        if (this.connected) return;
        this._closing = false;
        if (this.warnEmptyToken && !String(this.token || '').trim() && !this._warnedEmptyToken) {
            this._warnedEmptyToken = true;
            this.logger.warn('[qq-client] 未配置 OneBot access_token；如果 WebSocket 暴露到局域网/公网，可能存在安全风险。');
        }
        this._openWebSocket();
    }

    disconnect() {
        this._closing = true;
        this._clearReconnectTimer();
        this._rejectAllPending(new Error('OneBot connection closed'));
        if (this.ws) {
            try { this.ws.close(); } catch (_) {}
            this.ws = null;
        }
        this.emit('disconnected');
        this.logger.info('[qq-client] Disconnected from OneBot');
    }

    async sendPrivateMessage(userId, message, options = {}) {
        return this._sendMessage({
            isGroup: false,
            sessionId: String(userId),
            action: 'send_private_msg',
            idParam: 'user_id',
            idValue: Number(userId),
            message,
            options,
        });
    }

    async sendGroupMessage(groupId, message, options = {}) {
        return this._sendMessage({
            isGroup: true,
            sessionId: String(groupId),
            action: 'send_group_msg',
            idParam: 'group_id',
            idValue: Number(groupId),
            message,
            options,
        });
    }

    async sendForwardMessage({ isGroup, sessionId, nodes }) {
        const action = isGroup ? 'send_group_forward_msg' : 'send_private_forward_msg';
        const idParam = isGroup ? 'group_id' : 'user_id';
        return this.callAction(action, {
            [idParam]: Number(sessionId),
            messages: nodes,
        });
    }

    async callAction(action, params = {}, options = {}) {
        if (!this.connected) {
            throw new Error('Not connected to OneBot');
        }

        const timeoutMs = Number(options.timeoutMs || this.actionTimeoutMs || DEFAULT_ACTION_TIMEOUT);
        const echo = options.echo || this._nextEcho(action);
        const payload = JSON.stringify({ action, params, echo });

        const promise = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._pending.delete(echo);
                reject(new Error(`OneBot action timeout: ${action}`));
            }, timeoutMs);
            this._pending.set(echo, { action, resolve, reject, timer });
        });

        try {
            this.ws.send(payload);
        } catch (err) {
            const pending = this._pending.get(echo);
            if (pending) {
                clearTimeout(pending.timer);
                this._pending.delete(echo);
            }
            throw err;
        }

        return promise;
    }

    async getMsg(messageId) {
        return this._callActionCompat('get_msg', messageId);
    }

    async getForwardMsg(forwardId) {
        return this._callActionCompat('get_forward_msg', forwardId);
    }

    async getGroupMemberInfo(groupId, userId) {
        const ret = await this._safeCallAction('get_group_member_info', {
            group_id: Number(groupId),
            user_id: Number(userId),
            no_cache: false,
        });
        return ret || this._safeCallAction('get_stranger_info', {
            user_id: Number(userId),
            no_cache: false,
        });
    }

    async getGroupFileUrl(groupId, fileId) {
        return this._safeCallAction('get_group_file_url', {
            group_id: Number(groupId),
            file_id: fileId,
        });
    }

    async getPrivateFileUrl(fileId) {
        return this._safeCallAction('get_private_file_url', { file_id: fileId });
    }

    // --- internal ---

    _buildUrl() {
        let url = this.onebotUrl;
        if (this.token) {
            const sep = url.includes('?') ? '&' : '?';
            url = `${url}${sep}access_token=${encodeURIComponent(this.token)}`;
        }
        return url;
    }

    _openWebSocket() {
        if (this._closing) return;
        try {
            const url = this._buildUrl();
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this._reconnectDelay = RECONNECT_MIN_DELAY;
                this.logger.info(`[qq-client] Connected to OneBot at ${this.onebotUrl}`);
                this.emit('connected');
            };

            this.ws.onmessage = (event) => {
                Promise.resolve(this._handleRawMessage(event.data)).catch((err) => {
                    this.lastError = err.message;
                    this.logger.error(`[qq-client] Handle message failed: ${err.message}`);
                });
            };

            this.ws.onerror = (err) => {
                this.lastError = err.message || String(err);
                this.logger.warn(`[qq-client] WebSocket error: ${this.lastError}`);
            };

            this.ws.onclose = () => {
                this.ws = null;
                this._rejectAllPending(new Error('OneBot connection closed'));
                if (!this._closing) {
                    this.reconnectCount += 1;
                    this.logger.warn(`[qq-client] Connection lost, reconnecting in ${this._reconnectDelay / 1000}s...`);
                    this.emit('disconnected');
                    this._scheduleReconnect();
                }
            };
        } catch (err) {
            this.lastError = err.message;
            this.logger.error(`[qq-client] Failed to connect: ${err.message}`);
            if (!this._closing) {
                this._scheduleReconnect();
            }
        }
    }

    _scheduleReconnect() {
        this._clearReconnectTimer();
        this._reconnectTimer = setTimeout(() => {
            this._reconnectTimer = null;
            this._reconnectDelay = Math.min(this._reconnectDelay * 2, RECONNECT_MAX_DELAY);
            this._openWebSocket();
        }, this._reconnectDelay);
    }

    _clearReconnectTimer() {
        if (this._reconnectTimer) {
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
        }
    }

    _rejectAllPending(err) {
        for (const [echo, pending] of this._pending) {
            clearTimeout(pending.timer);
            pending.reject(err);
            this._pending.delete(echo);
        }
    }

    async _handleRawMessage(raw) {
        let data;
        try {
            data = JSON.parse(raw);
        } catch {
            return;
        }

        if (Object.prototype.hasOwnProperty.call(data, 'echo')) {
            this._resolveActionResponse(data);
            return;
        }

        if (data.post_type !== 'message') return;

        const msgType = data.message_type;
        if (msgType !== 'private' && msgType !== 'group') return;

        const userId = String(data.user_id || '');
        if (this.ignoreQQOfficialAccount && userId === QQ_OFFICIAL_ACCOUNT_ID) return;
        if (this.ignoreSelfMessage && data.self_id && String(data.self_id) === userId) return;

        const sender = data.sender || {};
        const parsedChain = await this._parseMessageChain(data);
        const content = parsedChain.text.trim();
        if (!content && parsedChain.attachments.length === 0) return;

        const parsed = {
            message_type: msgType,
            user_id: userId,
            user_nickname: sender.card || sender.nickname || null,
            content,
            plain_text: content,
            segments: parsedChain.segments,
            attachments: parsedChain.attachments,
            at_targets: parsedChain.atTargets,
            is_at_bot: parsedChain.isAtBot,
            is_at_all: parsedChain.isAtAll,
            reply: parsedChain.reply,
            forward_text: parsedChain.forwardText,
            message_id: data.message_id,
            self_id: data.self_id ? String(data.self_id) : '',
            session_id: msgType === 'group' ? String(data.group_id) : userId,
            timestamp: data.time,
            raw: data,
        };

        if (msgType === 'group') {
            parsed.group_id = String(data.group_id);
        }

        this.lastEventAt = Date.now();
        this.emit('message', parsed);
    }

    _resolveActionResponse(data) {
        const echo = String(data.echo);
        const pending = this._pending.get(echo);
        if (!pending) return;

        clearTimeout(pending.timer);
        this._pending.delete(echo);

        const failed = data.status === 'failed' || (typeof data.retcode === 'number' && data.retcode !== 0);
        if (failed) {
            const message = data.msg || data.wording || `${pending.action} failed, retcode=${data.retcode}`;
            pending.reject(new Error(message));
            return;
        }

        pending.resolve(this._unwrapActionData(data));
    }

    _unwrapActionData(data) {
        if (data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'data')) {
            return data.data;
        }
        return data;
    }

    async _sendMessage({ isGroup, sessionId, action, idParam, idValue, message, options }) {
        const forwardThreshold = Number(options.forwardThreshold || 0);
        const textMessage = typeof message === 'string' ? message : '';
        const shouldForward = options.forceForward || (forwardThreshold > 0 && textMessage.length > forwardThreshold);

        if (shouldForward && textMessage.trim()) {
            return this.sendForwardMessage({
                isGroup,
                sessionId,
                nodes: [this._buildForwardNode(textMessage, options)],
            });
        }

        const onebotMessage = this._buildOutgoingMessage(message, options);
        if (!onebotMessage.length) return null;

        return this.callAction(action, {
            [idParam]: idValue,
            message: onebotMessage,
        });
    }

    _buildOutgoingMessage(message, options = {}) {
        const ret = [];
        if (options.replyTo) {
            ret.push({ type: 'reply', data: { id: String(options.replyTo) } });
        }
        if (options.atUser) {
            ret.push({ type: 'at', data: { qq: String(options.atUser) } });
            ret.push({ type: 'text', data: { text: ' ' } });
        }

        if (Array.isArray(message)) {
            ret.push(...message.filter(Boolean));
        } else if (message !== undefined && message !== null) {
            const text = String(message);
            if (text.trim()) ret.push({ type: 'text', data: { text } });
        }

        return ret;
    }

    _buildForwardNode(text, options = {}) {
        const name = options.nodeName || this.aiName || 'AI';
        const uin = String(options.nodeUin || options.selfId || '0');
        return {
            type: 'node',
            data: {
                name,
                nickname: name,
                uin,
                user_id: uin,
                content: [{ type: 'text', data: { text: String(text) } }],
            },
        };
    }

    async _parseMessageChain(event, options = {}) {
        const chain = Array.isArray(event.message)
            ? event.message
            : QQClient.parseCQMessage(event.raw_message || event.message || '');
        const parts = [];
        const segments = [];
        const attachments = [];
        const atTargets = [];
        const getReply = options.getReply !== false;
        const getForward = options.getForward !== false;
        let isAtBot = false;
        let isAtAll = false;
        let firstAtSelfSkipped = false;
        let reply = null;
        let forwardText = '';

        for (const seg of chain) {
            if (!seg || typeof seg !== 'object') continue;
            const type = seg.type;
            const data = seg.data || {};
            segments.push({ type, data });

            if (type === 'text') {
                const text = String(data.text || '');
                if (text.trim()) parts.push(text.trim());
            } else if (type === 'at') {
                const qq = String(data.qq || '');
                if (qq === 'all') {
                    isAtAll = true;
                    if (!this.ignoreAtAll) parts.push('@全体成员');
                    continue;
                }

                if (event.self_id && qq === String(event.self_id)) {
                    isAtBot = true;
                    if (!firstAtSelfSkipped) {
                        firstAtSelfSkipped = true;
                        continue;
                    }
                }

                const name = await this._resolveAtName(event, qq);
                atTargets.push({ qq, name });
                parts.push(`@${name || `用户${qq}`}(${qq})`);
            } else if (type === 'reply') {
                const replyId = data.id || data.message_id;
                if (!replyId) continue;
                reply = { id: String(replyId), content: '' };
                if (getReply) {
                    const replyPayload = await this.getMsg(replyId).catch((err) => {
                        this.logger.warn(`[qq-client] 获取引用消息失败: ${err.message}`);
                        return null;
                    });
                    if (replyPayload) {
                        reply = this._summarizeMessagePayload(replyPayload, String(replyId));
                    }
                }
                if (reply.content) {
                    parts.push(`[引用消息 ${reply.sender_nickname || reply.sender_id || ''}: ${reply.content}]`);
                } else {
                    parts.push('[引用消息]');
                }
            } else if (type === 'forward' || type === 'forward_msg') {
                const forwardId = data.id || data.forward_id || data.message_id;
                if (!forwardId) {
                    parts.push('[转发消息]');
                    continue;
                }
                if (getForward) {
                    const payload = await this.getForwardMsg(forwardId).catch((err) => {
                        this.logger.warn(`[qq-client] 获取合并转发失败: ${err.message}`);
                        return null;
                    });
                    forwardText = payload ? this._extractForwardText(payload) : '';
                }
                if (forwardText) {
                    parts.push(`[转发消息]\n${this._clipForwardText(forwardText)}`);
                } else {
                    parts.push('[转发消息]');
                }
            } else if (type === 'image') {
                attachments.push({ type: 'image', url: data.url, file: data.file });
                parts.push('[图片]');
            } else if (type === 'record') {
                attachments.push({ type: 'record', url: data.url, file: data.file });
                parts.push('[语音]');
            } else if (type === 'video') {
                attachments.push({ type: 'video', url: data.url, file: data.file });
                parts.push('[视频]');
            } else if (type === 'file') {
                const file = await this._normalizeFileSegment(event, data);
                attachments.push(file);
                parts.push(`[文件:${file.name || 'file'}]`);
            } else if (type === 'face') {
                parts.push(`[表情:${data.id || ''}]`);
            } else if (type === 'markdown') {
                const text = String(data.markdown || data.content || '');
                if (text.trim()) parts.push(text.trim());
            } else {
                this.logger.warn(`[qq-client] 未支持的消息段类型: ${type}`);
            }
        }

        return {
            text: parts.filter(Boolean).join(' ').replace(/\s+\n/g, '\n').trim(),
            segments,
            attachments,
            atTargets,
            isAtBot,
            isAtAll,
            reply,
            forwardText,
        };
    }

    async _normalizeFileSegment(event, data) {
        const file = {
            type: 'file',
            name: data.file_name || data.name || data.file || 'file',
            file: data.file || data.file_id || '',
            url: data.url || '',
        };

        if (!file.url && data.file_id) {
            const ret = event.message_type === 'group'
                ? await this.getGroupFileUrl(event.group_id, data.file_id)
                : await this.getPrivateFileUrl(data.file_id);
            if (ret && ret.url) file.url = ret.url;
            if (ret && (ret.file_name || ret.name)) file.name = ret.file_name || ret.name;
        }

        return file;
    }

    async _resolveAtName(event, qq) {
        if (!qq) return '';
        try {
            if (event.group_id) {
                const info = await this.getGroupMemberInfo(event.group_id, qq);
                return info?.card || info?.nickname || info?.nick || '';
            }
        } catch (err) {
            this.logger.debug?.(`[qq-client] 获取 @ 用户信息失败: ${err.message}`);
        }
        return '';
    }

    _summarizeMessagePayload(payload, fallbackId = '') {
        const sender = payload.sender || {};
        const content = this._messageToText(payload.message || payload.raw_message || '');
        return {
            id: String(payload.message_id || fallbackId || ''),
            sender_id: sender.user_id ? String(sender.user_id) : '',
            sender_nickname: sender.card || sender.nickname || sender.nick || '',
            content,
            time: payload.time || payload.timestamp || 0,
        };
    }

    _extractForwardText(payload, depth = 0) {
        if (!payload || depth > 6) return '';
        const nodes = this._extractForwardNodes(payload);
        const lines = [];

        for (const node of nodes) {
            const data = node.data || node;
            const sender = data.nickname || data.name || node.sender?.nickname || node.sender?.card || '未知用户';
            const content = data.content || node.content || node.message || '';
            const text = Array.isArray(content)
                ? this._messageToText(content, depth + 1)
                : String(content || '').trim();
            if (text) lines.push(`${sender}: ${text}`);
        }

        return lines.join('\n').trim();
    }

    _extractForwardNodes(payload) {
        if (Array.isArray(payload)) return payload;
        if (Array.isArray(payload.messages)) return payload.messages;
        if (Array.isArray(payload.message)) return payload.message;
        if (Array.isArray(payload.data?.messages)) return payload.data.messages;
        if (Array.isArray(payload.data?.message)) return payload.data.message;
        return [];
    }

    _messageToText(message, depth = 0) {
        if (Array.isArray(message)) {
            const parts = [];
            for (const seg of message) {
                if (!seg || typeof seg !== 'object') continue;
                const data = seg.data || {};
                if (seg.type === 'text') parts.push(String(data.text || '').trim());
                else if (seg.type === 'at') parts.push(data.qq === 'all' ? '@全体成员' : `@用户${data.qq}`);
                else if (seg.type === 'image') parts.push('[图片]');
                else if (seg.type === 'record') parts.push('[语音]');
                else if (seg.type === 'video') parts.push('[视频]');
                else if (seg.type === 'file') parts.push(`[文件:${data.file_name || data.name || data.file || 'file'}]`);
                else if (seg.type === 'face') parts.push(`[表情:${data.id || ''}]`);
                else if ((seg.type === 'forward' || seg.type === 'forward_msg') && depth < 6) parts.push('[转发消息]');
                else if (seg.type === 'node' && depth < 6) parts.push(this._messageToText(data.content || [], depth + 1));
            }
            return parts.filter(Boolean).join(' ').trim();
        }
        return QQClient.sanitizeCQCodes(String(message || ''));
    }

    _clipForwardText(text) {
        const limit = Number(this.forwardExpandLimit || DEFAULT_FORWARD_EXPAND_LIMIT);
        if (limit <= 0 || text.length <= limit) return text;
        return `${text.slice(0, limit)}... [内容已截断]`;
    }

    async _callActionCompat(action, id) {
        const value = String(id || '').trim();
        if (!value) return null;

        const paramsList = [{ message_id: value }, { id: value }, { forward_id: value }];
        if (/^\d+$/.test(value)) {
            const num = Number(value);
            paramsList.push({ message_id: num }, { id: num }, { forward_id: num });
        }

        for (const params of paramsList) {
            const ret = await this._safeCallAction(action, params);
            if (ret) return ret;
        }
        return null;
    }

    async _safeCallAction(action, params) {
        try {
            return await this.callAction(action, params);
        } catch (err) {
            this.logger.debug?.(`[qq-client] action ${action} failed: ${err.message}`);
            return null;
        }
    }

    _nextEcho(action) {
        this._echoSeq = (this._echoSeq + 1) % Number.MAX_SAFE_INTEGER;
        return `qqc_${Date.now()}_${this._echoSeq}_${String(action).replace(/\W+/g, '_')}`;
    }

    static parseCQMessage(text) {
        const value = String(text || '');
        const ret = [];
        const regex = /\[CQ:([a-zA-Z0-9_-]+)((?:,[^\]]*)?)\]/g;
        let lastIndex = 0;
        let match;
        while ((match = regex.exec(value))) {
            if (match.index > lastIndex) {
                ret.push({ type: 'text', data: { text: value.slice(lastIndex, match.index) } });
            }
            ret.push({ type: match[1], data: QQClient._parseCQParams(match[2]) });
            lastIndex = regex.lastIndex;
        }
        if (lastIndex < value.length) {
            ret.push({ type: 'text', data: { text: value.slice(lastIndex) } });
        }
        return ret;
    }

    static _parseCQParams(paramString) {
        const data = {};
        const raw = String(paramString || '').replace(/^,/, '');
        if (!raw) return data;
        for (const part of raw.split(',')) {
            const idx = part.indexOf('=');
            if (idx <= 0) continue;
            data[part.slice(0, idx)] = part.slice(idx + 1);
        }
        return data;
    }

    static sanitizeCQCodes(text) {
        let result = String(text || '');
        result = result.replace(/\[CQ:at,qq=all\]/g, '@全体成员');
        result = result.replace(/\[CQ:at,qq=(\d+)\]/g, '@用户$1');
        result = result.replace(/\[CQ:image,[^\]]*\]/g, '[图片]');
        result = result.replace(/\[CQ:face,id=(\d+)\]/g, '[表情:$1]');
        result = result.replace(/\[CQ:record,[^\]]*\]/g, '[语音]');
        result = result.replace(/\[CQ:video,[^\]]*\]/g, '[视频]');
        result = result.replace(/\[CQ:file,[^\]]*\]/g, '[文件]');
        result = result.replace(/\[CQ:reply,[^\]]*\]/g, '[引用消息]');
        result = result.replace(/\[CQ:forward,[^\]]*\]/g, '[转发消息]');
        result = result.replace(/\[CQ:[^\]]*\]/g, '');
        return result.trim();
    }
}

module.exports = { QQClient };
