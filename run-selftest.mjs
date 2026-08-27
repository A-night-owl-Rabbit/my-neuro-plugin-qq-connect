import { createRequire } from 'module';
import { pathToFileURL } from 'url';

const require = createRequire(import.meta.url);
const base = new URL('.', pathToFileURL(process.argv[1] || import.meta.url)).pathname;
const root = process.platform === 'win32' && base.startsWith('/') ? base.slice(1).replace(/\//g, '\\') : base;
const { QQClient } = require(root + 'qq-client.js');
const QQConnectPlugin = require(root + 'index.js');
const { SessionManager } = require(root + 'session-manager.js');
require(root + 'rate-limiter.js');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

async function ok(name, fn) {
    try {
        await fn();
        console.log('[ok]', name);
    } catch (err) {
        console.error('[fail]', name, err);
        process.exitCode = 1;
    }
}

function client(overrides = {}) {
    return new QQClient({
        onebotUrl: 'ws://127.0.0.1:3001',
        logger: { info() {}, warn() {}, error() {}, debug() {} },
        ...overrides,
    });
}

// ---- helpers for plugin-level tests ----------------------------------------

function makeAdminPlugin({ unified = true } = {}) {
    const ctx = {
        getConfig: () => ({
            llm: { system_prompt: '你是肥牛。' },
            subtitle_labels: { ai: '肥牛' },
        }),
        log: () => {},
        getPlugin: () => null,
    };
    const plugin = new QQConnectPlugin({}, ctx);
    plugin._aiName = '肥牛';
    plugin._qqPrivatePrefix = '[QQ]';
    plugin._qqReplyPrefix = '[QQ回复]';
    plugin._maxReplyLen = 200;
    plugin._enableAgentTools = false;
    plugin._unifiedContextEnabled = unified;
    plugin._segmentedReplyEnable = false;
    plugin._forwardThreshold = 0;
    plugin._replyWithQuote = false;
    plugin._replyWithMention = false;
    plugin._sessionMgr = new SessionManager({
        logger: { info() {}, warn() {}, error() {} },
    });
    plugin._qqClient = {
        sendPrivateMessage: async () => {},
        sendGroupMessage: async () => {},
    };
    return plugin;
}

function makeFakeVoiceChat(initial = []) {
    return {
        messages: [...initial],
        enableContextLimit: false,
        MODEL: 'test',
        API_URL: 'http://localhost',
        API_KEY: '',
        trimMessages() {},
        saveConversationHistory() { this._saved = (this._saved || 0) + 1; },
        contextCompressor: { checkAndCompressAsync() {} },
    };
}

// ---- existing tests --------------------------------------------------------

await ok('parse reply and first @self', async () => {
    const c = client();
    c.getMsg = async () => ({
        message_id: 123,
        sender: { user_id: 42, nickname: 'Alice' },
        message: [{ type: 'text', data: { text: '原文内容' } }],
    });
    const parsed = await c._parseMessageChain({
        message_type: 'group',
        group_id: 10001,
        self_id: 99999,
        message: [
            { type: 'reply', data: { id: '123' } },
            { type: 'at', data: { qq: '99999' } },
            { type: 'text', data: { text: '总结一下' } },
        ],
    });
    assert(parsed.isAtBot === true, 'should detect @self');
    assert(parsed.reply.content === '原文内容', 'should fetch reply content');
    assert(parsed.text.includes('引用消息 Alice: 原文内容'), 'should inject reply summary');
    assert(parsed.text.includes('总结一下'), 'should keep user text');
});

await ok('parse forward text with clipping marker', async () => {
    const c = client({ forwardExpandLimit: 8 });
    c.getForwardMsg = async () => ({
        messages: [
            {
                data: {
                    nickname: 'Bob',
                    content: [{ type: 'text', data: { text: '这是一段很长的转发内容' } }],
                },
            },
        ],
    });
    const parsed = await c._parseMessageChain({
        message_type: 'group',
        group_id: 10001,
        self_id: 99999,
        message: [{ type: 'forward', data: { id: 'abc' } }],
    });
    assert(parsed.forwardText.includes('Bob:'), 'should extract node sender');
    assert(parsed.text.includes('内容已截断'), 'should mark clipped forward text');
});

await ok('build outgoing quote and mention segments', () => {
    const c = client();
    const segments = c._buildOutgoingMessage('你好', { replyTo: 123, atUser: 456 });
    assert(segments[0].type === 'reply', 'first segment should be reply');
    assert(segments[1].type === 'at', 'second segment should be at');
    assert(segments[3].data.text === '你好', 'text segment should keep message');
});

await ok('sanitize CQ placeholders', () => {
    const text = QQClient.sanitizeCQCodes('[CQ:at,qq=123] hi [CQ:image,file=a.jpg]');
    assert(text.includes('@用户123'), 'should convert at code');
    assert(text.includes('[图片]'), 'should convert image code');
});

// ---- new tests for unified-context refactor --------------------------------

await ok('_buildLLMMessages strips images and preserves order', () => {
    const plugin = makeAdminPlugin();
    const all = [
        { role: 'system', content: 'OLD SYSTEM' },
        { role: 'user', content: '问题1' },
        { role: 'assistant', content: '回答1' },
        {
            role: 'user',
            content: [
                { type: 'text', text: '看看这张图' },
                { type: 'image_url', image_url: { url: 'data:image/png;base64,XXX' } },
            ],
        },
    ];
    const built = plugin._buildLLMMessages('NEW SYSTEM', all);
    assert(built.length === 4, `期望 4 条（system + 3 非 system），实际 ${built.length}`);
    assert(built[0].role === 'system' && built[0].content === 'NEW SYSTEM', 'system 替换为新内容');
    assert(built[1].role === 'user' && built[1].content === '问题1', 'user 1 顺序保留');
    assert(built[2].role === 'assistant' && built[2].content === '回答1', 'assistant 1 顺序保留');
    assert(built[3].role === 'user' && built[3].content === '看看这张图', `多模态应只剩文本，实际: ${JSON.stringify(built[3].content)}`);
    assert(!Array.isArray(built[3].content), '多模态字段应该被剥成字符串');
});

await ok('admin private flow: atomic commit pushes user+assistant pair', async () => {
    const plugin = makeAdminPlugin();
    const initial = [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '电脑端1' },
        { role: 'assistant', content: '电脑端回答1' },
    ];
    global.voiceChat = makeFakeVoiceChat(initial);

    let llmCalledWith = null;
    plugin._callLLMWithTools = async (msgs) => {
        llmCalledWith = msgs;
        return '好的快去吧';
    };
    plugin._sendQQReply = async () => {};

    await plugin._handleAdminMessage(
        { message_type: 'private', user_id: '3639143454', self_id: '0' },
        '去倒水',
    );

    const vm = global.voiceChat.messages;
    assert(vm.length === initial.length + 2, `voiceChat.messages 应 +2 条，实际 +${vm.length - initial.length}`);

    const lastUser = vm[vm.length - 2];
    const lastAssistant = vm[vm.length - 1];

    assert(lastUser.role === 'user' && lastUser._source === 'qq', 'user 标记 _source=qq');
    assert(lastUser.content.startsWith('[QQ] 主人:'), `user 应有前缀，实际: ${lastUser.content}`);
    assert(lastUser.content.includes('去倒水'), 'user 含原始内容');
    assert(lastUser._qq_user === '3639143454', '_qq_user 字段保留');
    assert(typeof lastUser._ts === 'number' && lastUser._ts > 0, '_ts 时间戳存在');

    assert(lastAssistant.role === 'assistant' && lastAssistant._source === 'qq', 'assistant 标记 _source=qq');
    assert(lastAssistant.content.startsWith('[QQ回复] '), `assistant 应有前缀，实际: ${lastAssistant.content}`);
    assert(lastAssistant.content.includes('好的快去吧'), 'assistant 含 LLM 返回内容');

    assert(Array.isArray(llmCalledWith), 'LLM 应被调用并收到 messages 副本');
    const userInLLM = llmCalledWith.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('去倒水'));
    assert(userInLLM, 'LLM 副本应包含本次 user 消息');
    assert(global.voiceChat._saved >= 1, 'saveConversationHistory 应被触发');

    delete global.voiceChat;
});

await ok('admin private flow: LLM failure leaves voiceChat.messages clean', async () => {
    const plugin = makeAdminPlugin();
    const initial = [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '电脑端1' },
        { role: 'assistant', content: '电脑端回答1' },
    ];
    global.voiceChat = makeFakeVoiceChat(initial);

    plugin._callLLMWithTools = async () => { throw new Error('mock LLM down'); };
    plugin._sendQQReply = async () => {};
    let errorReplied = false;
    plugin._qqClient.sendPrivateMessage = async () => { errorReplied = true; };

    await plugin._handleAdminMessage(
        { message_type: 'private', user_id: '3639143454', self_id: '0' },
        '请帮我处理',
    );

    const vm = global.voiceChat.messages;
    assert(vm.length === initial.length, `LLM 失败时 voiceChat.messages 不应增加，实际 +${vm.length - initial.length}`);
    const polluted = vm.some(m => m._source === 'qq');
    assert(!polluted, 'voiceChat.messages 不应包含任何 _source=qq 的残留消息');
    assert(errorReplied, '失败时应给用户回错误消息');

    delete global.voiceChat;
});

await ok('group admin flow: isolated session, voiceChat.messages untouched', async () => {
    const plugin = makeAdminPlugin();
    const initial = [
        { role: 'system', content: 'SYS' },
        { role: 'user', content: '电脑端1' },
    ];
    global.voiceChat = makeFakeVoiceChat(initial);

    plugin._callLLMWithTools = async () => '收到，群里这个事';
    plugin._sendQQReply = async () => {};

    await plugin._handleGroupAdminMessage(
        { message_type: 'group', group_id: 11111, user_id: '3639143454', self_id: '0' },
        '群里 @ 你说一句',
    );

    const vm = global.voiceChat.messages;
    assert(vm.length === initial.length, `群聊 admin 不应改 voiceChat.messages，实际变化 +${vm.length - initial.length}`);
    const polluted = vm.some(m => m._source === 'qq');
    assert(!polluted, 'voiceChat.messages 不应出现 _source=qq 的消息');

    const session = plugin._sessionMgr.get(`group:11111:3639143454`);
    assert(session, `应创建独立 session group:11111:3639143454`);
    assert(session.history.length === 2, `session 历史应有 user + assistant 共 2 条，实际 ${session.history.length}`);
    assert(session.history[0].role === 'user' && session.history[0].content === '群里 @ 你说一句', 'session 第 1 条是 user');
    assert(session.history[1].role === 'assistant', 'session 第 2 条是 assistant');

    delete global.voiceChat;
});
