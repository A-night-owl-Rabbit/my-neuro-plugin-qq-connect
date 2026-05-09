const { Plugin } = require('../../../js/core/plugin-base.js');
const { Events } = require('../../../js/core/events.js');
const { QQClient } = require('./qq-client.js');
const { PermissionManager } = require('./permission-manager.js');
const { GroupPermissionManager } = require('./group-permission.js');
const { SessionManager, Session } = require('./session-manager.js');
const { AgentExecutor } = require('./agent-executor.js');
const { RateLimiter } = require('./rate-limiter.js');
const fs = require('fs');
const path = require('path');

const QQ_TAG = '[QQ消息]';
const SYSTEM_PATCH_ID = 'qq-connect-status';
const SOURCE_TAGS_PATCH_ID = 'qq-connect-source-tags';

function boolValue(value, fallback = false) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const lower = value.trim().toLowerCase();
        if (lower === 'true') return true;
        if (lower === 'false') return false;
        if (lower === '1') return true;
        if (lower === '0') return false;
    }
    return fallback;
}

function intValue(value, fallback) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function numberValue(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

class QQConnectPlugin extends Plugin {

    async onInit() {
        const cfg = this.context.getPluginFileConfig();
        this._cfg = cfg;
        this._pluginDir = this.metadata._dir || path.join(__dirname);
        let appConfig = {};
        try {
            appConfig = this.context.getConfig();
        } catch {
            appConfig = {};
        }
        this._aiName = appConfig?.subtitle_labels?.ai || '肥牛';

        this._qqClient = new QQClient({
            onebotUrl: cfg.onebot_url || 'ws://127.0.0.1:3001',
            token: cfg.token || '',
            actionTimeoutMs: intValue(cfg.action_timeout_ms, 10000),
            forwardExpandLimit: intValue(cfg.forward_expand_limit, 4000),
            ignoreAtAll: boolValue(cfg.ignore_at_all, true),
            ignoreSelfMessage: boolValue(cfg.ignore_bot_self_message, true),
            ignoreQQOfficialAccount: boolValue(cfg.ignore_qq_official_account, true),
            warnEmptyToken: boolValue(cfg.warn_empty_token, true),
            aiName: this._aiName,
            logger: { info: m => this._log('info', m), warn: m => this._log('warn', m), error: m => this._log('error', m), debug: () => {} },
        });

        const users = this._parseJSON(cfg.trusted_users, []);
        const groups = this._parseJSON(cfg.trusted_groups, []);
        this._permMgr = new PermissionManager(users);
        this._groupPermMgr = new GroupPermissionManager(groups);

        this._sessionMgr = new SessionManager({
            timeout: intValue(cfg.session_timeout, 300) * 1000,
            logger: { info: m => this._log('info', m), warn: m => this._log('warn', m), error: m => this._log('error', m) },
        });

        const allowedPaths = this._parseJSON(cfg.allowed_paths, []);
        this._agentExecutor = new AgentExecutor({
            allowedPaths,
            logger: { info: m => this._log('info', m), error: m => this._log('error', m) },
        });

        this._enableAgentTools = boolValue(cfg.enable_agent_tools, true);
        this._normalRelayProb = numberValue(cfg.normal_relay_probability, 0.1);
        this._openReplyProb = numberValue(cfg.open_reply_probability, 0.1);
        this._maxReplyLen = intValue(cfg.max_reply_length, 200);
        this._replyWithQuote = boolValue(cfg.reply_with_quote, false);
        this._replyWithMention = boolValue(cfg.reply_with_mention, false);
        this._forwardThreshold = intValue(cfg.forward_threshold, 0);
        this._segmentedReplyEnable = boolValue(cfg.enable_segmented_reply, false);
        this._segmentedReplyIntervalMs = intValue(cfg.segmented_reply_interval_ms, 1500);

        this._unifiedContextEnabled = boolValue(cfg.unified_context_enabled, true);
        this._qqPrivatePrefix = (cfg.qq_private_prefix || '[QQ]').trim() || '[QQ]';
        this._qqReplyPrefix = (cfg.qq_reply_prefix || '[QQ回复]').trim() || '[QQ回复]';

        this._rateLimiter = new RateLimiter({
            windowMs: intValue(cfg.rate_limit_window_sec, 60) * 1000,
            count: intValue(cfg.rate_limit_count, 30),
            strategy: cfg.rate_limit_strategy || 'stall',
            logger: { warn: m => this._log('warn', m) },
        });

        this._ttsQueue = [];
        this._ttsPlaying = false;
        this._connected = false;
        this._adminSession = null;

        this._onTTSStart = () => { this._ttsPlaying = true; };
        this._onTTSEnd = () => {
            this._ttsPlaying = false;
            this._drainTTSQueue();
        };

        this._qqClient.on('message', (msg) => this._onQQMessage(msg));
        this._qqClient.on('connected', () => {
            this._connected = true;
            this._log('info', 'QQ 已连接');
            this.context.addSystemPromptPatch(SYSTEM_PATCH_ID,
                '你已连接到 QQ 消息平台。主人可以通过 QQ 给你发消息，你也可以主动给 QQ 用户发消息。'
            );
        });
        this._qqClient.on('disconnected', () => {
            this._connected = false;
            this.context.removeSystemPromptPatch(SYSTEM_PATCH_ID);
        });

        if (this._unifiedContextEnabled) {
            this.context.addSystemPromptPatch(SOURCE_TAGS_PATCH_ID, this._buildSourceTagsPatch());
        }

        this._log('info', `QQ Connect 初始化完成 (${users.length} 用户, ${groups.length} 群, 统一上下文=${this._unifiedContextEnabled})`);
    }

    async onStart() {
        this.context.on(Events.TTS_START, this._onTTSStart);
        this.context.on(Events.TTS_END, this._onTTSEnd);
        this._sessionMgr.start();

        if (boolValue(this._cfg.auto_connect, false)) {
            this._log('info', '自动连接 OneBot...');
            this._qqClient.connect();
        }
    }

    async onStop() {
        this.context.off(Events.TTS_START, this._onTTSStart);
        this.context.off(Events.TTS_END, this._onTTSEnd);
        this.context.removeSystemPromptPatch(SYSTEM_PATCH_ID);
        this.context.removeSystemPromptPatch(SOURCE_TAGS_PATCH_ID);
        this._sessionMgr.stop();
        this._qqClient.disconnect();
        this._ttsQueue = [];
        this._log('info', 'QQ Connect 已停止');
    }

    // ===== Function Calling 工具（文件/系统/肥牛控制）=====

    getTools() {
        if (!this._enableAgentTools) return [];
        const agentTools = this._agentExecutor.getToolDefinitions();
        const qqTools = [
            {
                type: 'function',
                function: {
                    name: 'send_qq_private_message',
                    description: '发送 QQ 私聊消息给指定用户',
                    parameters: {
                        type: 'object',
                        properties: {
                            qq_number: { type: 'string', description: '目标 QQ 号' },
                            message: { type: 'string', description: '消息内容' },
                        },
                        required: ['qq_number', 'message'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'send_qq_group_message',
                    description: '发送 QQ 群聊消息',
                    parameters: {
                        type: 'object',
                        properties: {
                            group_id: { type: 'string', description: '目标群号' },
                            message: { type: 'string', description: '消息内容' },
                        },
                        required: ['group_id', 'message'],
                    },
                },
            },
        ];
        return [...agentTools, ...qqTools];
    }

    async executeTool(name, params) {
        if (name === 'send_qq_private_message') {
            return this._toolSendPrivate(params);
        }
        if (name === 'send_qq_group_message') {
            return this._toolSendGroup(params);
        }
        return this._agentExecutor.execute(name, params, this.context);
    }

    async _toolSendPrivate(params) {
        if (!this._connected) return JSON.stringify({ error: 'QQ 未连接' });
        try {
            await this._qqClient.sendPrivateMessage(params.qq_number, params.message);
            return JSON.stringify({ success: true, qq_number: params.qq_number });
        } catch (err) {
            return JSON.stringify({ error: err.message });
        }
    }

    async _toolSendGroup(params) {
        if (!this._connected) return JSON.stringify({ error: 'QQ 未连接' });
        try {
            await this._qqClient.sendGroupMessage(params.group_id, params.message);
            return JSON.stringify({ success: true, group_id: params.group_id });
        } catch (err) {
            return JSON.stringify({ error: err.message });
        }
    }

    // ===== QQ 消息路由 =====

    async _onQQMessage(msg) {
        const content = QQClient.sanitizeCQCodes(msg.content || msg.plain_text || '');
        if (!content) return;

        const limitKey = msg.message_type === 'group' && msg.group_id
            ? `group:${msg.group_id}`
            : `private:${msg.user_id}`;
        const allowed = await this._rateLimiter.waitTurn(limitKey);
        if (!allowed) return;

        this.context.emit('qq:message:received', { ...msg, content });

        if (msg.message_type === 'private') {
            await this._handlePrivateMessage(msg, content);
        } else if (msg.message_type === 'group') {
            await this._handleGroupMessage(msg, content);
        }
    }

    async _handlePrivateMessage(msg, content) {
        const level = this._permMgr.getLevel(msg.user_id);

        if (level === 'none') return;

        this._log('info', `私聊 [${level}] ${msg.user_id}: ${content.slice(0, 80)}`);

        if (level === 'admin') {
            if (this._unifiedContextEnabled) {
                await this._handleAdminMessage(msg, content);
            } else {
                await this._handleAdminMessageLegacy(msg, content);
            }
        } else if (level === 'trusted') {
            await this._handleTrustedMessage(msg, content);
        } else {
            await this._handleNormalRelay(msg, content, 'private');
        }
    }

    async _handleGroupMessage(msg, content) {
        const groupLevel = this._groupPermMgr.getLevel(msg.group_id);
        if (groupLevel === 'none') return;

        this._log('info', `群聊 [${groupLevel}] 群${msg.group_id} 用户${msg.user_id}: ${content.slice(0, 80)}`);

        if (groupLevel === 'normal') {
            await this._handleNormalRelay(msg, content, 'group');
            return;
        }

        if (groupLevel === 'trusted') {
            if (!msg.is_at_bot) return;
        } else if (groupLevel === 'open') {
            if (!msg.is_at_bot && Math.random() >= this._openReplyProb) return;
        }

        const isAdmin = this._permMgr.isAdmin(msg.user_id);
        if (isAdmin) {
            await this._handleGroupAdminMessage(msg, content);
        } else {
            await this._handleGroupReply(msg, content, groupLevel);
        }
    }

    // ===== Admin 私聊：统一上下文路径（原子提交） =====
    // admin 私聊消息会以带前缀的形式进入主 voiceChat.messages，
    // 与电脑端对话共享一份带压缩、可持久化的上下文。
    // 群聊一律不进主上下文（走 _handleGroupAdminMessage）。

    async _handleAdminMessage(msg, content) {
        const voiceChat = global.voiceChat;
        if (!voiceChat || !Array.isArray(voiceChat.messages)) {
            this._log('error', 'voiceChat 不可用，admin 消息处理失败');
            try { await this._qqClient.sendPrivateMessage(msg.user_id, '出错了: 主上下文不可用'); } catch (_) {}
            return;
        }

        const userMsg = {
            role: 'user',
            content: `${this._qqPrivatePrefix} 主人: ${content}`,
            _source: 'qq',
            _qq_user: msg.user_id,
            _ts: Date.now(),
        };

        const systemPrompt = this._buildAdminSystemPrompt(msg);
        const llmMessages = this._buildLLMMessages(
            systemPrompt,
            [...voiceChat.messages, userMsg],
        );

        const memosClient = this._getMemosClient();
        if (memosClient && memosClient.enabled && memosClient.autoInject) {
            try {
                const memories = await memosClient.search(content);
                if (memories && memories.length > 0) {
                    const memoText = memosClient.formatMemoriesForPrompt(memories);
                    llmMessages[0].content +=
                        `\n\n【你对主人的已知记忆，回答时必须自然融入，不要说"根据记忆"】:\n${memoText}`;
                    this._log('info', `MemOS 注入 ${memories.length} 条记忆`);
                }
            } catch (err) {
                this._log('warn', `MemOS 检索失败（不影响回复）: ${err.message}`);
            }
        }

        let trimmed;
        try {
            const tools = this._enableAgentTools ? this._collectAllTools() : undefined;
            const reply = await this._callLLMWithTools(llmMessages, tools);
            trimmed = (reply || '').slice(0, this._maxReplyLen);
            if (!trimmed) {
                throw new Error('LLM 返回空内容');
            }
        } catch (err) {
            this._log('error', `Admin 回复失败: ${err.message}`);
            try { await this._qqClient.sendPrivateMessage(msg.user_id, `出错了: ${err.message}`); } catch (_) {}
            return;
        }

        const assistantMsg = {
            role: 'assistant',
            content: trimmed,
            _source: 'qq',
            _ts: Date.now(),
        };

        // 原子提交：LLM 成功后，user + assistant 一次性入主上下文。
        // 失败时（上面 return）两条都不入，避免污染电脑端看到的对话历史。
        voiceChat.messages.push(userMsg, assistantMsg);
        if (voiceChat.enableContextLimit && typeof voiceChat.trimMessages === 'function') {
            try { voiceChat.trimMessages(); } catch (e) { this._log('warn', `trimMessages 失败: ${e.message}`); }
        }

        try { voiceChat.saveConversationHistory?.(); } catch (e) { this._log('warn', `saveConversationHistory 失败: ${e.message}`); }
        try { voiceChat.contextCompressor?.checkAndCompressAsync?.(); } catch (e) { this._log('warn', `checkAndCompressAsync 失败: ${e.message}`); }

        try {
            await this._sendQQReply(msg, trimmed);
        } catch (err) {
            this._log('warn', `QQ 发送失败（消息已入主上下文）: ${err.message}`);
        }

        this._log('info', `Admin QQ 回复: ${trimmed.slice(0, 50)}...`);

        if (memosClient && memosClient.enabled && memosClient.autoSave) {
            memosClient.addWithBuffer([
                { role: 'user', content },
                { role: 'assistant', content: trimmed },
            ]).catch(err => this._log('warn', `MemOS 写入失败: ${err.message}`));
        }
    }

    // ===== Admin 在群里 @ 肥牛：独立 session，不入主上下文 =====

    async _handleGroupAdminMessage(msg, content) {
        const key = SessionManager.buildSessionKey({
            userId: msg.user_id,
            messageType: 'group',
            groupId: msg.group_id,
        });
        const session = this._sessionMgr.getOrCreate(key);
        session.addUserMessage(content);

        const systemPrompt = this._buildGroupAdminSystemPrompt(msg);
        const messages = session.buildMessages(systemPrompt);

        let trimmed;
        try {
            const tools = this._enableAgentTools ? this._collectAllTools() : undefined;
            const reply = await this._callLLMWithTools(messages, tools);
            trimmed = (reply || '').slice(0, this._maxReplyLen);
            if (!trimmed) {
                throw new Error('LLM 返回空内容');
            }
        } catch (err) {
            this._log('error', `群聊 admin 回复失败: ${err.message}`);
            return;
        }

        session.addAssistantMessage(trimmed);

        try {
            await this._sendQQReply(msg, trimmed);
        } catch (err) {
            this._log('warn', `群聊 admin 发送失败: ${err.message}`);
        }

        this._log('info', `群聊 admin 回复 群${msg.group_id}: ${trimmed.slice(0, 50)}...`);
    }

    // ===== Legacy admin 路径：与改造前一致，给 unified_context_enabled=false 时回退使用 =====

    async _handleAdminMessageLegacy(msg, content) {
        if (!this._adminSession) {
            this._adminSession = new Session('admin-qq', 30);
        }
        this._adminSession.addUserMessage(content);

        const config = this.context.getConfig();
        const basePrompt = config?.llm?.system_prompt || '你是一个友好的AI助手。';
        const aiName = config?.subtitle_labels?.ai || '肥牛';

        const desktopHistory = this._getRecentDesktopHistoryLegacy(6);

        let memoryContext = null;
        const memosClient = this._getMemosClient();
        if (memosClient && memosClient.enabled && memosClient.autoInject) {
            try {
                const memories = await memosClient.search(content);
                if (memories && memories.length > 0) {
                    memoryContext = `\n\n【你对主人的已知记忆，回答时必须自然融入，不要说"根据记忆"】:\n${memosClient.formatMemoriesForPrompt(memories)}`;
                }
            } catch (_) {}
        }

        let systemPrompt = basePrompt + '\n\n';
        if (memoryContext) {
            systemPrompt += memoryContext + '\n\n';
        }
        systemPrompt +=
            `======QQ 文字对话约束（必须严格遵守）======\n` +
            `- 你是${aiName}，正在通过 QQ 与主人进行文字聊天\n` +
            `- 这是纯文字聊天，不是语音对话，回复只会显示在 QQ 消息里\n` +
            `- 回复必须简短精炼，像发微信/QQ消息一样，控制在1-3句话以内，不超过${this._maxReplyLen}字\n` +
            `- 禁止使用任何情感标签（如<开心>、<生气>、<害羞>等角括号标记），这些在QQ里会原样显示很奇怪\n` +
            `- 禁止使用 Markdown 格式（如**加粗**、# 标题、- 列表等）\n` +
            `- 禁止使用颜文字以外的特殊符号装饰\n` +
            `- 用自然口语化的方式回复，就像真人在QQ上打字聊天\n` +
            `======约束结束======`;

        const messages = [{ role: 'system', content: systemPrompt }];
        if (desktopHistory.length > 0) {
            messages.push({ role: 'system', content: `以下是最近在电脑端的对话（供参考上下文）：\n${desktopHistory.map(m => `${m.role === 'user' ? '主人' : aiName}: ${m.content}`).join('\n')}` });
        }
        messages.push(...this._adminSession.history);

        try {
            if (!global.voiceChat) throw new Error('LLM 不可用');
            const tools = this._enableAgentTools ? this._collectAllTools() : undefined;
            const reply = await this._callLLMWithTools(messages, tools);
            const trimmed = (reply || '').slice(0, this._maxReplyLen);
            this._adminSession.addAssistantMessage(trimmed);

            await this._sendQQReply(msg, trimmed);
            this._log('info', `[Legacy] Admin QQ 回复: ${trimmed.slice(0, 50)}...`);

            if (memosClient && memosClient.enabled && memosClient.autoSave) {
                memosClient.addWithBuffer([
                    { role: 'user', content },
                    { role: 'assistant', content: trimmed },
                ]).catch(err => this._log('warn', `MemOS 写入失败: ${err.message}`));
            }
        } catch (err) {
            this._log('error', `[Legacy] Admin 回复失败: ${err.message}`);
            try { await this._qqClient.sendPrivateMessage(msg.user_id, `出错了: ${err.message}`); } catch (_) {}
        }
    }

    _getRecentDesktopHistoryLegacy(count) {
        try {
            const msgs = this.context.getMessages();
            const relevant = msgs.filter(m => m.role === 'user' || m.role === 'assistant');
            return relevant.slice(-count).map(m => ({
                role: m.role,
                content: typeof m.content === 'string' ? m.content.slice(0, 150) : String(m.content).slice(0, 150),
            }));
        } catch {
            return [];
        }
    }

    // ===== LLM 调用与工具循环 =====

    async _callLLMWithTools(messages, tools) {
        const voiceChat = global.voiceChat;
        if (!voiceChat) throw new Error('LLM 不可用');

        const body = {
            model: voiceChat.MODEL,
            messages,
            stream: false,
            temperature: 0.8,
        };
        if (tools && tools.length > 0) body.tools = tools;

        const response = await fetch(`${voiceChat.API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${voiceChat.API_KEY}`,
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API 错误 (${response.status}): ${errText.slice(0, 200)}`);
        }
        const data = await response.json();
        const choice = data.choices[0];

        if (choice.message.tool_calls && choice.message.tool_calls.length > 0) {
            return this._handleToolCalls(messages, choice.message, tools);
        }

        return choice.message.content || '';
    }

    async _handleToolCalls(messages, assistantMsg, tools) {
        messages.push(assistantMsg);

        for (const toolCall of assistantMsg.tool_calls) {
            const name = toolCall.function.name;
            let args = {};
            try { args = JSON.parse(toolCall.function.arguments); } catch {}
            this._log('info', `Agent 工具调用: ${name}(${JSON.stringify(args).slice(0, 100)})`);

            const result = await this._executeToolRouted(name, args);
            messages.push({
                role: 'tool',
                tool_call_id: toolCall.id,
                content: typeof result === 'string' ? result : JSON.stringify(result),
            });
        }

        return this._callLLMWithTools(messages, tools);
    }

    _collectAllTools() {
        try {
            if (global.pluginManager && typeof global.pluginManager.getAllTools === 'function') {
                return global.pluginManager.getAllTools();
            }
        } catch (err) {
            this._log('warn', `收集全局工具失败: ${err.message}`);
        }
        return this.getTools();
    }

    async _executeToolRouted(name, args) {
        try {
            if (global.pluginManager && typeof global.pluginManager.executeTool === 'function') {
                return await global.pluginManager.executeTool(name, args);
            }
        } catch (err) {
            this._log('warn', `全局工具路由失败(${name}): ${err.message}`);
        }
        return this.executeTool(name, args);
    }

    // ===== 消息构造辅助 =====

    /**
     * 构造发给 LLM 的 messages 数组。
     * - 深拷贝（避免后续 push tool_calls 等污染原数组）
     * - 剥除多模态图片字段（QQ 端不需要也不能正确处理）
     * - 替换/插入唯一一条 system 消息
     */
    _buildLLMMessages(systemPrompt, allMessages) {
        const cloned = JSON.parse(JSON.stringify(Array.isArray(allMessages) ? allMessages : []));
        const stripped = cloned.map(m => {
            if (Array.isArray(m.content)) {
                const text = m.content
                    .filter(p => p && p.type === 'text' && typeof p.text === 'string')
                    .map(p => p.text)
                    .join(' ');
                return { ...m, content: text };
            }
            return m;
        });
        const nonSystem = stripped.filter(m => m.role !== 'system');
        return [{ role: 'system', content: systemPrompt }, ...nonSystem];
    }

    _buildAdminSystemPrompt(_msg) {
        const config = this.context.getConfig();
        const basePrompt = config?.llm?.system_prompt || '你是一个友好的AI助手。';
        const aiName = config?.subtitle_labels?.ai || '肥牛';

        return `${basePrompt}\n\n` +
            `======QQ 文字对话约束（必须严格遵守）======\n` +
            `- 你是${aiName}，正在通过 QQ 私聊与主人进行文字聊天\n` +
            `- 这是纯文字聊天，不是语音对话，回复只会显示在 QQ 消息里\n` +
            `- 回复必须简短精炼，像发微信/QQ消息一样，控制在1-3句话以内，不超过${this._maxReplyLen}字\n` +
            `- 禁止使用任何情感标签（如<开心>、<生气>、<害羞>等角括号标记），这些在QQ里会原样显示很奇怪\n` +
            `- 禁止使用 Markdown 格式（如**加粗**、# 标题、- 列表等）\n` +
            `- 禁止使用颜文字以外的特殊符号装饰\n` +
            `- 用自然口语化的方式回复，就像真人在QQ上打字聊天\n` +
            `======约束结束======\n\n` +
            this._buildSourceTagsPatch();
    }

    _buildGroupAdminSystemPrompt(msg) {
        const config = this.context.getConfig();
        const basePrompt = config?.llm?.system_prompt || '你是一个友好的AI助手。';
        const aiName = config?.subtitle_labels?.ai || '肥牛';

        return `${basePrompt}\n\n` +
            `======QQ 群聊约束（必须严格遵守）======\n` +
            `- 你是${aiName}，正在 QQ 群 ${msg.group_id} 中和主人对话\n` +
            `- 这是群聊场景，主人可能只是顺手 @ 你提个问题，跟主人对你的电脑端语音对话是两条独立的会话流\n` +
            `- 这条会话不会同步到电脑端，请只就群里这件事简短回应\n` +
            `- 回复必须简短精炼，1-3 句话以内，不超过${this._maxReplyLen}字\n` +
            `- 禁止使用情感标签（如<开心>、<生气>等角括号标记）\n` +
            `- 禁止使用 Markdown 格式\n` +
            `- 用自然口语化的方式回复，就像真人在 QQ 群里打字\n` +
            `======约束结束======`;
    }

    _buildSourceTagsPatch() {
        const aiName = this._aiName || '肥牛';
        return `======对话历史来源标记说明======\n` +
            `- 历史消息中以 ${this._qqPrivatePrefix} 开头的，是主人在 QQ 私聊里发给你（${aiName}）的消息\n` +
            `- 没有任何前缀的，是主人在电脑端用语音或文字跟你说的话，或是你给主人的回复\n` +
            `- 这些都是同一个主人的连续对话，请按时间顺序理解、按时间远近权衡相关性\n` +
            `- 你和主人在 QQ 群里、和其他人的对话不会出现在这里，是另一条独立的会话流\n` +
            `======说明结束======`;
    }

    _getMemosClient() {
        try {
            const memosPlugin = this.context.getPlugin?.('memos');
            return memosPlugin?.client || null;
        } catch {
            return null;
        }
    }

    // ===== Trusted 路径：独立会话 callLLM =====

    async _handleTrustedMessage(msg, content) {
        const key = SessionManager.buildSessionKey({
            userId: msg.user_id,
            messageType: 'private',
        });
        const session = this._sessionMgr.getOrCreate(key);
        session.addUserMessage(content);

        const nickname = this._permMgr.getNickname(msg.user_id) || msg.user_nickname || `QQ用户${msg.user_id}`;
        const systemPrompt = this._buildTrustedSystemPrompt(nickname, msg.user_id);

        try {
            const reply = await this.context.callLLM('', {
                messages: session.buildMessages(systemPrompt),
                temperature: 0.8,
            });

            const trimmed = reply.slice(0, this._maxReplyLen);
            session.addAssistantMessage(trimmed);

            await this._sendQQReply(msg, trimmed);
            this._log('info', `Trusted 回复 ${msg.user_id}: ${trimmed.slice(0, 50)}...`);

            const config = this.context.getConfig();
            const aiName = config?.subtitle_labels?.ai || '肥牛';
            const relayPrompt = `你是${aiName}，要把QQ上发生的事简短地告诉主人。` +
                `${nickname}在QQ上跟你说了："${content.slice(0, 60)}"，你回复了："${trimmed.slice(0, 60)}"。` +
                `请用一两句自然口语把这件事转述给主人，不要用情感标签。`;
            try {
                const relayText = await this.context.callLLM(relayPrompt, { temperature: 0.8 });
                this._enqueueTTSRelay(relayText.slice(0, 150));
            } catch {
                this._enqueueTTSRelay(`主人，QQ上${nickname}说："${content.slice(0, 30)}"，我回他了。`);
            }
        } catch (err) {
            this._log('error', `Trusted 回复失败: ${err.message}`);
        }
    }

    // ===== 群聊回复路径 =====

    async _handleGroupReply(msg, content, groupLevel) {
        const key = SessionManager.buildSessionKey({
            userId: msg.user_id,
            messageType: 'group',
            groupId: msg.group_id,
        });
        const session = this._sessionMgr.getOrCreate(key);
        session.addUserMessage(content);

        const nickname = msg.user_nickname || `QQ用户${msg.user_id}`;
        const systemPrompt = this._buildGroupSystemPrompt(nickname, msg.user_id, msg.group_id, groupLevel);

        try {
            const reply = await this.context.callLLM('', {
                messages: session.buildMessages(systemPrompt),
                temperature: 0.8,
            });

            const trimmed = reply.slice(0, this._maxReplyLen);
            session.addAssistantMessage(trimmed);

            await this._sendQQReply(msg, trimmed);
            this._log('info', `群聊回复 群${msg.group_id}: ${trimmed.slice(0, 50)}...`);
        } catch (err) {
            this._log('error', `群聊回复失败: ${err.message}`);
        }
    }

    // ===== Normal 转述 =====

    async _handleNormalRelay(msg, content, sourceType) {
        const adminQQ = this._permMgr.getAdminQQ();
        if (!adminQQ) return;
        if (Math.random() > this._normalRelayProb) return;

        const sourceDesc = sourceType === 'group' ? `QQ群${msg.group_id}` : `QQ用户${msg.user_id}`;

        try {
            const config = this.context.getConfig();
            const aiName = config?.subtitle_labels?.ai || '肥牛';

            const relayPrompt = `你是${aiName}。有人在${sourceDesc}说了"${content.slice(0, 100)}"。` +
                `请用简短自然的话（不超过50字）把这件有趣的事转述给主人。不要使用 Markdown。`;

            const relayText = await this.context.callLLM(relayPrompt, { temperature: 0.8 });
            const trimmed = relayText.slice(0, 100);

            await this._qqClient.sendPrivateMessage(adminQQ, trimmed);
            this._log('info', `转述给 admin: ${trimmed.slice(0, 50)}`);

            this._enqueueTTSRelay(trimmed);
        } catch (err) {
            this._log('error', `转述失败: ${err.message}`);
        }
    }

    // ===== TTS 队列 =====

    _enqueueTTSRelay(text) {
        this._ttsQueue.push(text);
        if (!this._ttsPlaying) {
            this._drainTTSQueue();
        }
    }

    _drainTTSQueue() {
        if (this._ttsPlaying || this._ttsQueue.length === 0) return;
        const text = this._ttsQueue.shift();
        try {
            this.context.speakText(text);
        } catch (err) {
            this._log('warn', `TTS relay 失败: ${err.message}`);
            this._drainTTSQueue();
        }
    }

    _waitForTTSEnd() {
        if (!this._ttsPlaying) return Promise.resolve();
        return new Promise((resolve) => {
            const handler = () => {
                this.context.off(Events.TTS_END, handler);
                resolve();
            };
            this.context.on(Events.TTS_END, handler);
        });
    }

    // ===== Trusted/群聊 system prompt（保留原行为） =====

    _buildTrustedSystemPrompt(nickname, userId) {
        const config = this.context.getConfig();
        const basePrompt = config?.llm?.system_prompt || '你是一个友好的AI助手。';
        const aiName = config?.subtitle_labels?.ai || '肥牛';

        return `${basePrompt}\n\n` +
            `======QQ 文字对话约束（必须严格遵守）======\n` +
            `- 你是${aiName}，正在通过 QQ 与用户 ${userId} 进行文字聊天\n` +
            `- 对方的称呼是：${nickname}\n` +
            `- 对方是主人的朋友，不是主人本人\n` +
            `- 回复必须简短精炼，像发QQ消息一样，控制在1-3句话以内，不超过${this._maxReplyLen}字\n` +
            `- 禁止使用任何情感标签（如<开心>、<生气>、<害羞>等角括号标记）\n` +
            `- 禁止使用 Markdown 格式（如**加粗**、# 标题等）\n` +
            `- 用自然口语化的方式回复，就像真人在QQ上打字聊天\n` +
            `======约束结束======`;
    }

    _buildGroupSystemPrompt(nickname, userId, groupId, groupLevel) {
        const config = this.context.getConfig();
        const basePrompt = config?.llm?.system_prompt || '你是一个友好的AI助手。';
        const aiName = config?.subtitle_labels?.ai || '肥牛';

        return `${basePrompt}\n\n` +
            `======QQ 文字对话约束（必须严格遵守）======\n` +
            `- 你是${aiName}，正在 QQ 群 ${groupId} 中与用户进行文字聊天\n` +
            `- 当前发言人：${nickname}（QQ: ${userId}）\n` +
            `- 群聊权限级别：${groupLevel}\n` +
            `- 回复必须简短精炼，像发QQ消息一样，控制在1-3句话以内，不超过${this._maxReplyLen}字\n` +
            `- 禁止使用任何情感标签（如<开心>、<生气>、<害羞>等角括号标记）\n` +
            `- 禁止使用 Markdown 格式（如**加粗**、# 标题等）\n` +
            `- 用自然口语化的方式回复，就像真人在QQ上打字聊天\n` +
            `======约束结束======`;
    }

    // ===== 工具方法 =====

    async _sendQQReply(msg, text) {
        const value = String(text || '').trim();
        if (!value) return;

        const baseOptions = this._buildReplyOptions(msg);
        if (this._segmentedReplyEnable && !this._shouldUseForward(value) && this._shouldSegmentReply(value)) {
            const chunks = this._splitReply(value);
            for (let i = 0; i < chunks.length; i++) {
                const options = i === 0 ? baseOptions : { forwardThreshold: this._forwardThreshold, nodeName: this._aiName };
                await this._sendQQMessageToSource(msg, chunks[i], options);
                if (i < chunks.length - 1) await this._sleep(this._segmentedReplyIntervalMs);
            }
            return;
        }

        await this._sendQQMessageToSource(msg, value, baseOptions);
    }

    async _sendQQMessageToSource(msg, text, options) {
        if (msg.message_type === 'group' && msg.group_id) {
            await this._qqClient.sendGroupMessage(msg.group_id, text, options);
        } else {
            await this._qqClient.sendPrivateMessage(msg.user_id, text, options);
        }
    }

    _buildReplyOptions(msg) {
        const options = {
            forwardThreshold: this._forwardThreshold,
            nodeName: this._aiName,
            selfId: msg.self_id || '0',
        };

        if (this._replyWithQuote && msg.message_id) {
            options.replyTo = msg.message_id;
        }
        if (this._replyWithMention && msg.message_type === 'group' && msg.user_id) {
            options.atUser = msg.user_id;
        }

        return options;
    }

    _shouldUseForward(text) {
        return this._forwardThreshold > 0 && String(text || '').length > this._forwardThreshold;
    }

    _shouldSegmentReply(text) {
        return String(text || '').length >= 80;
    }

    _splitReply(text) {
        const matches = String(text || '').match(/[^。？！~…!?]+[。？！~…!?]+|[^。？！~…!?]+$/g);
        return (matches && matches.length > 1 ? matches : [text])
            .map(s => s.trim())
            .filter(Boolean);
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    }

    _parseJSON(str, fallback) {
        if (Array.isArray(str)) return str;
        if (typeof str !== 'string') return fallback;
        try {
            const parsed = JSON.parse(str);
            return Array.isArray(parsed) ? parsed : fallback;
        } catch {
            return fallback;
        }
    }

    _log(level, message) {
        try {
            this.context.log(level, message);
        } catch {
            console[level === 'error' ? 'error' : 'log'](`[qq-connect] ${message}`);
        }
    }

    _saveConfig() {
        try {
            const cfgPath = path.join(this._pluginDir, 'plugin_config.json');
            const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
            raw.trusted_users.value = JSON.stringify(this._permMgr.toJSON());
            raw.trusted_groups.value = JSON.stringify(this._groupPermMgr.toJSON());
            fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2), 'utf-8');
        } catch (err) {
            this._log('error', `保存配置失败: ${err.message}`);
        }
    }
}

module.exports = QQConnectPlugin;
