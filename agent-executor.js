const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const BLOCKED_PATHS = [
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\ProgramData',
    'System32',
    'system32',
];

const BLOCKED_COMMANDS = [
    'format', 'del /s', 'rmdir /s', 'rd /s',
    'shutdown', 'restart', 'reg delete',
    'net user', 'net localgroup',
];

class AgentExecutor {
    constructor({ allowedPaths = [], logger = console } = {}) {
        this.allowedPaths = allowedPaths;
        this.logger = logger;
    }

    getToolDefinitions() {
        return [
            {
                type: 'function',
                function: {
                    name: 'create_file',
                    description: '创建或覆盖写入文件。可以创建 txt、json 等任意文本文件。',
                    parameters: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: '文件的完整路径' },
                            content: { type: 'string', description: '要写入的文本内容' },
                        },
                        required: ['file_path', 'content'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'read_file',
                    description: '读取文件内容。返回文件的文本内容。',
                    parameters: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: '文件的完整路径' },
                        },
                        required: ['file_path'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'delete_file',
                    description: '删除指定的文件。',
                    parameters: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: '要删除的文件路径' },
                        },
                        required: ['file_path'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'rename_file',
                    description: '重命名或移动文件。',
                    parameters: {
                        type: 'object',
                        properties: {
                            old_path: { type: 'string', description: '原文件路径' },
                            new_path: { type: 'string', description: '新文件路径' },
                        },
                        required: ['old_path', 'new_path'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'list_directory',
                    description: '列出目录下的文件和子目录。',
                    parameters: {
                        type: 'object',
                        properties: {
                            dir_path: { type: 'string', description: '目录路径' },
                        },
                        required: ['dir_path'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'file_exists',
                    description: '检查文件或目录是否存在。',
                    parameters: {
                        type: 'object',
                        properties: {
                            file_path: { type: 'string', description: '要检查的路径' },
                        },
                        required: ['file_path'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'run_command',
                    description: '执行系统命令并返回输出。仅限安全命令。',
                    parameters: {
                        type: 'object',
                        properties: {
                            command: { type: 'string', description: '要执行的命令' },
                        },
                        required: ['command'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'speak_text',
                    description: '让肥牛通过 TTS 在桌面端说一段话。',
                    parameters: {
                        type: 'object',
                        properties: {
                            text: { type: 'string', description: '要说的文字' },
                        },
                        required: ['text'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'change_mood',
                    description: '切换肥牛的表情/情绪。可用值取决于 Live2D 模型。',
                    parameters: {
                        type: 'object',
                        properties: {
                            emotion: { type: 'string', description: '目标情绪名称' },
                        },
                        required: ['emotion'],
                    },
                },
            },
            {
                type: 'function',
                function: {
                    name: 'get_status',
                    description: '获取肥牛当前状态信息（连接状态、插件列表等）。',
                    parameters: { type: 'object', properties: {} },
                },
            },
        ];
    }

    async execute(toolName, params, pluginContext) {
        try {
            switch (toolName) {
                case 'create_file':
                    return this._createFile(params.file_path, params.content);
                case 'read_file':
                    return this._readFile(params.file_path);
                case 'delete_file':
                    return this._deleteFile(params.file_path);
                case 'rename_file':
                    return this._renameFile(params.old_path, params.new_path);
                case 'list_directory':
                    return this._listDirectory(params.dir_path);
                case 'file_exists':
                    return this._fileExists(params.file_path);
                case 'run_command':
                    return this._runCommand(params.command);
                case 'speak_text':
                    return this._speakText(params.text, pluginContext);
                case 'change_mood':
                    return this._changeMood(params.emotion, pluginContext);
                case 'get_status':
                    return this._getStatus(pluginContext);
                default:
                    return JSON.stringify({ error: `未知工具: ${toolName}` });
            }
        } catch (err) {
            this.logger.error(`[agent-executor] Tool ${toolName} error: ${err.message}`);
            return JSON.stringify({ error: err.message });
        }
    }

    _validatePath(filePath) {
        const resolved = path.resolve(filePath);
        for (const blocked of BLOCKED_PATHS) {
            if (resolved.toLowerCase().startsWith(blocked.toLowerCase())) {
                throw new Error(`安全限制：不允许操作系统目录 ${blocked}`);
            }
        }
        if (this.allowedPaths.length > 0) {
            const allowed = this.allowedPaths.some(p =>
                resolved.toLowerCase().startsWith(path.resolve(p).toLowerCase())
            );
            if (!allowed) {
                throw new Error(`安全限制：路径不在允许的目录白名单中。允许的目录: ${this.allowedPaths.join(', ')}`);
            }
        }
        return resolved;
    }

    _createFile(filePath, content) {
        const resolved = this._validatePath(filePath);
        const dir = path.dirname(resolved);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(resolved, content, 'utf-8');
        this.logger.info(`[agent-executor] Created file: ${resolved}`);
        return JSON.stringify({ success: true, path: resolved, size: content.length });
    }

    _readFile(filePath) {
        const resolved = this._validatePath(filePath);
        if (!fs.existsSync(resolved)) {
            return JSON.stringify({ error: '文件不存在', path: resolved });
        }
        const stat = fs.statSync(resolved);
        if (stat.size > 1024 * 100) {
            return JSON.stringify({ error: '文件过大（超过100KB），无法读取', size: stat.size });
        }
        const content = fs.readFileSync(resolved, 'utf-8');
        return JSON.stringify({ success: true, path: resolved, content });
    }

    _deleteFile(filePath) {
        const resolved = this._validatePath(filePath);
        if (!fs.existsSync(resolved)) {
            return JSON.stringify({ error: '文件不存在', path: resolved });
        }
        fs.unlinkSync(resolved);
        this.logger.info(`[agent-executor] Deleted file: ${resolved}`);
        return JSON.stringify({ success: true, path: resolved });
    }

    _renameFile(oldPath, newPath) {
        const resolvedOld = this._validatePath(oldPath);
        const resolvedNew = this._validatePath(newPath);
        if (!fs.existsSync(resolvedOld)) {
            return JSON.stringify({ error: '源文件不存在', path: resolvedOld });
        }
        const dir = path.dirname(resolvedNew);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.renameSync(resolvedOld, resolvedNew);
        this.logger.info(`[agent-executor] Renamed: ${resolvedOld} -> ${resolvedNew}`);
        return JSON.stringify({ success: true, old_path: resolvedOld, new_path: resolvedNew });
    }

    _listDirectory(dirPath) {
        const resolved = this._validatePath(dirPath);
        if (!fs.existsSync(resolved)) {
            return JSON.stringify({ error: '目录不存在', path: resolved });
        }
        const entries = fs.readdirSync(resolved, { withFileTypes: true });
        const items = entries.slice(0, 100).map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
        }));
        return JSON.stringify({ success: true, path: resolved, count: entries.length, items });
    }

    _fileExists(filePath) {
        const resolved = this._validatePath(filePath);
        const exists = fs.existsSync(resolved);
        let type = null;
        if (exists) {
            const stat = fs.statSync(resolved);
            type = stat.isDirectory() ? 'directory' : 'file';
        }
        return JSON.stringify({ exists, path: resolved, type });
    }

    _runCommand(command) {
        const lower = command.toLowerCase();
        for (const blocked of BLOCKED_COMMANDS) {
            if (lower.includes(blocked.toLowerCase())) {
                return JSON.stringify({ error: `安全限制：命令包含被禁止的操作 "${blocked}"` });
            }
        }
        try {
            const output = execSync(command, {
                encoding: 'utf-8',
                timeout: 15000,
                maxBuffer: 1024 * 512,
                windowsHide: true,
            });
            const trimmed = output.length > 2000 ? output.slice(0, 2000) + '\n...(输出已截断)' : output;
            return JSON.stringify({ success: true, output: trimmed });
        } catch (err) {
            return JSON.stringify({
                error: '命令执行失败',
                message: err.message,
                stderr: (err.stderr || '').slice(0, 500),
            });
        }
    }

    _speakText(text, pluginContext) {
        if (!pluginContext) {
            return JSON.stringify({ error: '插件上下文不可用' });
        }
        try {
            pluginContext.speakText(text);
            return JSON.stringify({ success: true, text });
        } catch (err) {
            return JSON.stringify({ error: `TTS 失败: ${err.message}` });
        }
    }

    _changeMood(emotion, pluginContext) {
        if (!pluginContext) {
            return JSON.stringify({ error: '插件上下文不可用' });
        }
        try {
            pluginContext.triggerEmotion(emotion);
            return JSON.stringify({ success: true, emotion });
        } catch (err) {
            return JSON.stringify({ error: `切换情绪失败: ${err.message}` });
        }
    }

    _getStatus(pluginContext) {
        const status = {
            platform: process.platform,
            uptime: Math.floor(process.uptime()),
            memory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        };
        if (pluginContext && typeof pluginContext.getConfig === 'function') {
            try {
                const config = pluginContext.getConfig();
                status.model = config?.llm?.model || 'unknown';
            } catch (_) {}
        }
        return JSON.stringify({ success: true, status });
    }
}

module.exports = { AgentExecutor };
