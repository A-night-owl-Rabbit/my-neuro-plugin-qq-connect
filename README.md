# QQ 消息平台（qq-connect）v1.1.1

**my-neuro** 生态下的 **live-2d 社区插件**，通过 **OneBot 11** 协议把肥牛桥接到 QQ：admin 私聊与电脑端语音共享同一份主上下文（含压缩 + 持久化），群聊与陌生人走独立会话；并通过 **Function Calling** 暴露文件 / 系统 / 桌面 TTS / 表情切换等远程 Agent 工具，让你在外面也能用 QQ 远程"指挥"桌面上的肥牛。

底层 QQ 协议端推荐使用 **LLBot**（LLOneBot 的开箱即用打包，下文会给出从下载到扫码登录的完整教程）。

> **TL;DR**：装 LLBot → 在 LLBot 里勾 OneBot 11 正向 WS（默认 `ws://127.0.0.1:3001`）→ 把本插件目录扔进 `live-2d/plugins/community/qq-connect/` → 在 my-neuro 里启用插件、把自己的 QQ 加进 `trusted_users` 设为 `admin` → 重启 → 在 QQ 上私聊机器人 = 直接和电脑前的肥牛对话。

---

## 功能概览

| 能力 | 说明 |
| --- | --- |
| **OneBot 11 客户端** | 正向 WebSocket 接入，自动重连（指数退避，最长 30s）；支持 `access_token` |
| **三级用户权限** | `admin`（主人，统一上下文 + Agent 工具）/ `trusted`（朋友，独立会话）/ `normal`（陌生人，按概率转述） |
| **三级群聊权限** | `trusted`（仅 @ 机器人才回）/ `open`（@ 必回 + 未 @ 按概率回）/ `normal`（仅按概率转述给主人，不直接回） |
| **统一上下文（admin 私聊）** | admin 在 QQ 私聊里说的话会进入电脑端主 `voiceChat.messages`，与语音对话共享同一份压缩 + 可持久化的对话历史 |
| **群聊独立会话** | 群聊（含 admin 在群里 @）一律不入主上下文，避免污染电脑端语音聊天流 |
| **Function Calling 工具** | `create_file` / `read_file` / `delete_file` / `rename_file` / `list_directory` / `file_exists` / `run_command` / `speak_text` / `change_mood` / `get_status`，外加 `send_qq_private_message` / `send_qq_group_message` |
| **路径白名单** | `allowed_paths` 限制 Agent 可操作的目录；阻止操作 `C:\Windows` / `Program Files` / `System32`；危险命令（`format`、`shutdown`、`net user`…）一律拒绝 |
| **限流** | 每 60 秒 30 条（按用户 / 群分桶），可选 `stall`（排队）或 `discard`（丢弃） |
| **MemOS 集成** | 若同时启用 `memos` 插件，会在 admin 回复前自动检索记忆并注入 system prompt，回复后异步入库 |
| **TTS 转述队列** | trusted/normal 触发的"主人，QQ 上有人说……"播报会排队等待 TTS 结束后再播，不打断对话 |
| **多模态消息解析** | @ / 引用 / 合并转发（自动 `get_forward_msg` 展开）/ 图片 / 语音 / 视频 / 文件 / 表情 / Markdown 段都会被结构化解析 |
| **分段回复 / 合并转发** | 长回复可按句号拆条发送或自动折叠成 QQ 合并转发，避免刷屏 |

---

## 架构图

```
                ┌─────────────────────────────┐
                │      QQ（手机/PC 客户端）    │
                └──────────────┬──────────────┘
                               │ QQ 协议
                               ▼
                ┌─────────────────────────────┐
                │  LLBot（LLOneBot 打包版）    │
                │   - QQNT 内嵌 / 扫码登录     │
                │   - 暴露 OneBot 11 正向 WS   │
                └──────────────┬──────────────┘
                               │ ws://127.0.0.1:3001
                               ▼
        ┌──────────────────────────────────────────────┐
        │  qq-connect 插件                              │
        │  ┌──────────────┐   ┌──────────────────────┐  │
        │  │ QQClient     │──▶│ 路由 + 权限          │  │
        │  │ (qq-client)  │   │ - admin 私聊        │──┼──▶ voiceChat.messages
        │  │              │   │ - admin 群聊 @      │  │   （主上下文，统一压缩 + 持久化）
        │  └──────────────┘   │ - trusted/group     │──┼──▶ SessionManager（独立会话）
        │                     │ - normal 转述        │──┼──▶ TTS 队列 → context.speakText
        │                     └──────────────────────┘  │
        │                                ▲              │
        │                                │ tools         │
        │                     ┌──────────┴───────────┐  │
        │                     │ AgentExecutor +      │  │
        │                     │ pluginManager 全局工具│  │
        │                     └──────────────────────┘  │
        └──────────────────────────────────────────────┘
                               ▲
                               │
                ┌─────────────────────────────┐
                │   my-neuro live-2d 主程序    │
                │   （桌面端肥牛 + LLM + TTS）  │
                └─────────────────────────────┘
```

---

## 环境要求

- **my-neuro live-2d 主程序**（提供 `Plugin` / `pluginManager` / `voiceChat` / `Events.TTS_*`）。
- **Node.js**（与 my-neuro 一致；插件本身不需要单独 `npm install`，运行时无三方依赖）。
- **Windows / macOS / Linux**：插件代码跨平台，**但 LLBot 官方包以 Windows 为主**，其他系统可改用 napcat / go-cqhttp 等 OneBot 11 兼容实现。
- **一个用于 bot 的 QQ 小号**：强烈建议**不要用大号**登录，避免风控。
- **一个有 Function Calling 能力的 LLM**（与 my-neuro 主对话所用的同一个）。

---

## 一、LLBot 详细教程（QQ 协议端）

LLBot 是把 LLOneBot 与 QQNT 客户端打包好的"开箱即用"版本，下载即可双击启动，无需自己折腾 Electron / 注入器。如果你已经在用 napcat / go-cqhttp 等其它 OneBot 11 实现，跳到第 [二、安装本插件](#二安装本插件) 节即可。

### 1.1 下载 LLBot

**方式一（推荐）：一键安装脚本**

双击本仓库里的 **`安装LLBOT.bat`**：自动从官方 Releases 下载 **LuckyLilliaBot v7.12.2 Desktop 版**（约 90MB，与本插件的测试版本一致），做 SHA256 完整性校验后解压到插件目录下的 `LLBOT/` 文件夹。GitHub 直连失败时会自动尝试镜像源；全部失败会给出手动下载地址。

**方式二：手动下载**

- 官方仓库：[https://github.com/LLOneBot/LuckyLilliaBot](https://github.com/LLOneBot/LuckyLilliaBot)（Releases 页下载 `LLBot-Desktop-win-x64.zip`，本插件测试版本为 v7.12.2）。
- 旧入口：[https://github.com/LLOneBot/LLOneBot](https://github.com/LLOneBot/LLOneBot)（README 里指向 LLBot 整合包）。
- 解压到一个**无中文、无空格**的目录（例如插件目录下的 `LLBOT\`，或 `D:\tools\LLBOT\`）；带中文路径在某些 Windows 环境下会让 PowerShell / Electron 出问题。

> ⚠️ **提示**：LLBot 是社区项目，请只从官方仓库链接下载，避免被植入恶意代码。下载完后建议用 VirusTotal 或杀毒软件扫一遍再运行。

### 1.2 启动 LLBot 并扫码登录 QQ

1. 双击解压目录里的 `LLBot.exe`（或 `llbot.exe`）。
2. 首次启动会弹出 QQNT 登录窗口，**用扫码登录小号**（推荐）。
3. 登录成功后，LLBot 会在系统托盘出现一个图标，左键单击托盘图标可打开 LLBot 的 WebUI 控制台（默认 `http://127.0.0.1:3080`）。

### 1.3 配置 OneBot 11 正向 WebSocket

1. 打开 WebUI 控制台 → 左侧菜单选择 **"OneBot 配置"** / **"网络配置"**。
2. **启用"正向 WebSocket 服务器"**：
   - 主机：`127.0.0.1`（仅本机使用）
   - 端口：`3001`（默认值，与本插件 `onebot_url` 默认 `ws://127.0.0.1:3001` 对齐）
   - **访问令牌（access_token）**：**强烈建议设置一个随机字符串**，例如 `4f8a72b910c63e2d`。把同样的值填到本插件 `plugin_config.json` 的 `token` 字段里。
3. 关闭"反向 WS"、"HTTP 上报"等用不到的通道，减少攻击面。
4. 保存配置 → 重启 LLBot（或在 WebUI 里点"重新加载 OneBot"）。

> ⚠️ **安全须知**：
> - 不要把 `127.0.0.1` 改成 `0.0.0.0`，否则你的 QQ 会暴露给整个局域网；如果一定要远程接入，请走 SSH 隧道或 VPN，不要直接把 `3001` 端口暴露到公网。
> - 必须设置 `access_token`。空 token + 公网监听 = 任何人都能用你的 QQ 给任何人发消息。

### 1.4 验证 LLBot 已对外提供 OneBot 11

打开浏览器访问 `http://127.0.0.1:3080/api/get_login_info?access_token=你的token`，如果返回类似：

```json
{ "status": "ok", "retcode": 0, "data": { "user_id": 123456789, "nickname": "肥牛小号" }, ... }
```

说明 OneBot 11 接口工作正常，可以进入下一步。

### 1.5 LLBot 进阶建议

- **开机自启**：在 WebUI 设置 → 通用，勾选"开机自启"+"启动时最小化到托盘"，重启电脑后无需手动开启。
- **日志位置**：LLBot 的运行日志在解压目录的 `logs/` 与 `bin/llbot/data/logs/`，连不上或登录掉线时优先查这里。
- **风控**：新登录的小号建议先在 QQ 里发几条正常消息、加几个常用群、设置好头像昵称，再接入机器人；冷启动直接发 OneBot action 容易被风控冻结。
- **多账号**：LLBot 单实例只跑一个 QQ；要多账号请开多份 LLBot，分别监听不同端口（`3001` / `3002` / …）。

---

## 二、安装本插件

### 2.1 放置插件目录

将整个仓库内容放到 my-neuro 的社区插件路径下：

```
live-2d/plugins/community/qq-connect/
├── index.js
├── metadata.json
├── plugin_config.json
├── qq-client.js
├── permission-manager.js
├── group-permission.js
├── session-manager.js
├── rate-limiter.js
├── agent-executor.js
├── run-selftest.mjs
└── README.md
```

> 仓库里 **不包含 LLBot 主程序**：LLBot 是独立的 QQ 协议端，请按上文 [1.1](#11-下载-llbot) 单独下载并放到任意位置（不必放进插件目录）。

### 2.2 在 my-neuro 中启用插件

打开 my-neuro 的插件管理界面，把 `qq-connect` 切到"启用"。如果你的 my-neuro 版本还没 UI 化插件管理，可在主配置里手动把 `qq-connect` 加入启用列表，然后重启 live-2d。

### 2.3 自检脚本（可选但推荐）

在插件目录下执行：

```bash
node run-selftest.mjs
```

该脚本会做一系列纯函数 / 类的单元自检（不连接 OneBot、不会发任何 QQ 消息），全部通过会输出 `[ok] xxx`，并以 exit code 0 退出。**自检失败请先解决，再继续后面的配置**。

---

## 三、配置说明（`plugin_config.json`）

> **每次手动改 JSON 后，重启 my-neuro 才会生效**。如果你用记事本，请保存为 UTF-8（**无 BOM**），否则部分 my-neuro 版本会解析失败。

### 3.1 必填项（接入 OneBot）

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `onebot_url` | string | `ws://127.0.0.1:3001` | LLBot 暴露的 OneBot 11 正向 WS 地址 |
| `token` | string | `""` | 与 LLBot 中"访问令牌"完全一致；空字符串表示不鉴权（**仅本机自用时**可接受） |
| `auto_connect` | bool | `false` | 插件启动是否自动连接；建议先手动验证一切正常再打开 |

### 3.2 用户与群权限

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `trusted_users` | string(JSON) | `"[]"` | 信任用户列表，例如 `[{"qq":"10001","level":"admin","nickname":"主人"},{"qq":"20002","level":"trusted","nickname":"朋友"}]`。`level` 取值：`admin` / `trusted` / `normal` |
| `trusted_groups` | string(JSON) | `"[]"` | 信任群列表，例如 `[{"group_id":"700000001","level":"trusted"}]`。`level` 取值：`trusted` / `open` / `normal` |
| `normal_relay_probability` | float | `0.1` | 普通用户消息转述给 admin 的概率 |
| `open_reply_probability` | float | `0.1` | 开放群中**未** @ 时直接回复的概率 |

> **JSON 字段是字符串包 JSON**（my-neuro 的配置规范），编辑时注意转义里面的双引号。

### 3.3 主上下文（admin 私聊）

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `unified_context_enabled` | bool | `true` | 开启后，admin 通过 QQ 私聊与肥牛对话会直接进入 `voiceChat.messages`，与电脑端语音对话共享带压缩、可持久化的同一份上下文。群聊不受影响 |
| `qq_private_prefix` | string | `[QQ]` | admin 私聊消息进入主上下文时附加的来源前缀，便于 LLM 区分是 QQ 私聊还是电脑端语音输入 |
| `qq_reply_prefix` | string | `[QQ回复]` | **v1.1.0 起已弃用**：肥牛在 QQ 给 admin 的回复进入主上下文时**不再附加任何前缀**，与电脑端语音回复结构一致；保留此字段仅为向后兼容 |

### 3.4 回复行为

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `max_reply_length` | int | `200` | AI 回复最大字符数 |
| `reply_with_quote` | bool | `false` | 回复时引用原消息（群聊多人时更易看懂在回谁） |
| `reply_with_mention` | bool | `false` | 群聊回复时先 @ 发送人 |
| `forward_threshold` | int | `0` | 长回复合并转发阈值；超过该字数自动折叠成 QQ 合并转发，`0` 表示关闭 |
| `forward_expand_limit` | int | `4000` | 收到合并转发时最多展开多少字给 AI 理解，超出会标注"内容已截断" |
| `enable_segmented_reply` | bool | `false` | 长回复按句号 / 问号 / 感叹号拆条发送，更像真人聊天 |
| `segmented_reply_interval_ms` | int | `1500` | 分段回复每段间隔毫秒 |

### 3.5 安全与限流

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `ignore_bot_self_message` | bool | `true` | 忽略机器人自己发的消息，防止循环回复 |
| `ignore_at_all` | bool | `true` | 群里 `@全体成员` 不当作 @ 机器人 |
| `ignore_qq_official_account` | bool | `true` | 屏蔽 QQ 管家（账号 `2854196310`）系统提示 |
| `warn_empty_token` | bool | `true` | token 为空时启动连接给安全警告 |
| `rate_limit_window_sec` | int | `60` | 限流窗口（秒） |
| `rate_limit_count` | int | `30` | 每窗口最多处理消息数（按用户 / 群分桶） |
| `rate_limit_strategy` | string | `stall` | `stall` 排队等待 / `discard` 直接丢弃超额 |
| `action_timeout_ms` | int | `10000` | OneBot action 等待回包超时 |
| `session_timeout` | int | `300` | trusted / 群聊独立会话空闲超时（秒） |

### 3.6 Agent 工具

| 配置项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `enable_agent_tools` | bool | `true` | 是否对 admin 启用 Function Calling 工具（文件 / 系统 / 桌面 TTS / 表情） |
| `allowed_paths` | string(JSON) | `"[]"` | 文件操作白名单目录；空数组表示不限制（**强烈建议配置**，例如 `["D:\\bot-workspace"]`，注意 Windows 路径需双反斜杠） |

---

## 四、典型配置示例（私人本机部署）

```jsonc
{
  "onebot_url": { "value": "ws://127.0.0.1:3001" },
  "token":      { "value": "4f8a72b910c63e2d" },
  "auto_connect": { "value": "true" },

  "trusted_users": {
    "value": "[{\"qq\":\"10001\",\"level\":\"admin\",\"nickname\":\"主人\"}]"
  },
  "trusted_groups": {
    "value": "[{\"group_id\":\"700000001\",\"level\":\"trusted\"}]"
  },

  "max_reply_length":   { "value": 200 },
  "reply_with_quote":   { "value": "true" },
  "reply_with_mention": { "value": "true" },
  "forward_threshold":  { "value": 400 },

  "enable_agent_tools": { "value": "true" },
  "allowed_paths":      { "value": "[\"D:\\\\bot-workspace\"]" }
}
```

把上面的 `10001` / `700000001` / token 改成你自己的，重启 my-neuro 即可。

---

## 五、权限模型详解

### 5.1 用户权限（私聊）

| level | 路径 | 上下文 | TTS 转述给主人 | Function Calling |
| --- | --- | --- | --- | --- |
| `admin` | `_handleAdminMessage`（unified_context=true）/ `_handleAdminMessageLegacy`（false） | **进入主上下文**（v1.1.0 起 AI 回复无前缀） | 否（admin 自己跟肥牛聊就够了） | **是**，全量工具 |
| `trusted` | `_handleTrustedMessage` | 独立 `Session`（每用户一份） | 是，"主人，QQ 上 xxx 说……" | 否 |
| `normal` | `_handleNormalRelay` | 不入任何上下文 | 是（按 `normal_relay_probability` 概率） | 否 |
| 不在列表 | 直接丢弃 | — | — | — |

### 5.2 群聊权限

| level | 触发条件 | 路径 | 上下文 |
| --- | --- | --- | --- |
| `trusted` | 必须 @ 机器人 | admin 在群里 @ → `_handleGroupAdminMessage`；其他人 → `_handleGroupReply` | 独立 session |
| `open` | @ 机器人 **或** 按 `open_reply_probability` 自发 | 同上 | 独立 session |
| `normal` | 不主动回复，仅按概率转述给 admin | `_handleNormalRelay` | 不入上下文 |
| 不在列表 | 直接丢弃 | — | — |

> **重要**：admin 在群里被 @，**也不会进主上下文**——群聊会话是独立流，避免群里几十条聊天污染电脑端语音上下文。只有 admin **私聊**才进主上下文。

---

## 六、Function Calling 工具列表

> ⚠️ **必读**：启用 `enable_agent_tools=true` 时，admin 在 QQ 端实际能让肥牛调用的**不只是下面这两张表**，而是 **my-neuro 主程序当前已启用的所有插件 `getTools()` 暴露的全部工具的并集 + 动态注册的工具**。
>
### 6.1 qq-connect 自带的通用工具（来自 `agent-executor`）

| 工具名 | 说明 | 入参 |
| --- | --- | --- |
| `create_file` | 创建或覆盖写入文本文件 | `file_path`, `content` |
| `read_file` | 读取文件（限 100KB 内） | `file_path` |
| `delete_file` | 删除文件 | `file_path` |
| `rename_file` | 重命名 / 移动文件 | `old_path`, `new_path` |
| `list_directory` | 列目录（最多 100 项） | `dir_path` |
| `file_exists` | 检查文件 / 目录是否存在 | `file_path` |
| `run_command` | 执行系统命令（黑名单：format/shutdown/net user/del /s 等） | `command` |
| `speak_text` | 让桌面端肥牛 TTS 说一段话 | `text` |
| `change_mood` | 切换 Live2D 表情 | `emotion` |
| `get_status` | 查询当前状态（平台 / 内存 / 模型） | — |

### 6.2 qq-connect 自带的 QQ 工具

| 工具名 | 说明 | 入参 |
| --- | --- | --- |
| `send_qq_private_message` | 主动私聊任意 QQ 用户 | `qq_number`, `message` |
| `send_qq_group_message` | 主动给指定群发消息 | `group_id`, `message` |

### 6.3 实际可用工具 = 主程序所有已启用插件的工具并集

QQ 端 admin 触发 LLM 调用工具的链路：

```
admin 在 QQ 说话
   │
   ▼
qq-connect: _handleAdminMessage / _handleGroupAdminMessage
   │  tools = enable_agent_tools ? _collectAllTools() : undefined
   ▼
_collectAllTools() ──► global.pluginManager.getAllTools()
                        遍历所有已启用插件 → plugin.getTools()
                        合并所有工具 + 动态注册的工具
   │
   ▼
_callLLMWithTools(messages, tools)
   │  LLM 决定 tool_calls
   ▼
_handleToolCalls ──► _executeToolRouted(name, args)
                       │
                       ▼
                global.pluginManager.executeTool(name, args)
                  按工具名遍历所有插件，找到声明了 name 的插件
                  → plugin.executeTool(name, params)
```

也就是说，**admin 通过 QQ 能调到的工具集合 = 当前 my-neuro 实例下所有已启用插件 `getTools()` 暴露的工具的并集 + 动态注册的工具**。`qq-connect` 自带的 12 个只是其中一部分；如果你装了 `kimi-search`、`memos`、各种自定义插件、Python 桥接插件、智能家居插件等，它们暴露的工具也会**全部出现在 admin 通过 QQ 可调用的列表里**。

### 6.4 各路径的工具可用性对照表

| 来源 | 路径 | 是否传 tools 给 LLM | 实际工具集合 |
| --- | --- | --- | --- |
| admin 私聊 | `_handleAdminMessage`（unified_context=true） | ✅ 传 | 全局工具并集 |
| admin 私聊（legacy） | `_handleAdminMessageLegacy`（unified_context=false） | ✅ 传 | 全局工具并集 |
| admin 群里 @ | `_handleGroupAdminMessage` | ✅ 传 | 全局工具并集 |
| trusted 私聊 | `_handleTrustedMessage` | ❌ 不传（走 `context.callLLM` 纯聊天） | — |
| trusted/open 群里非 admin 发言 | `_handleGroupReply` | ❌ 不传 | — |
| normal 转述 | `_handleNormalRelay` | ❌ 不进 LLM 决策 | — |

**因此：trusted/normal 用户、群里其他成员永远调不到任何工具**，工具能力是 admin 专属。

### 6.5 怎么查看"当前 my-neuro 实例实际可调用的工具列表"

- 启动 my-neuro 时观察 `pluginManager` 注册日志，看哪些插件被加载。
- 在 admin 私聊里直接问肥牛：「你现在有哪些工具可以调用？把所有 function 的 name 和 description 列给我」——LLM 会基于收到的 `tools` 数组照实回答。
- 在 my-neuro 项目源码里 `console.log(global.pluginManager.getAllTools())` 是最权威的方式（开发者模式）。


---

## 七、安全与隐私清单（自检）

- [ ] LLBot 的 OneBot 端口 `3001` 仅监听 `127.0.0.1`，未暴露到公网。
- [ ] LLBot 与 `plugin_config.json` 的 `token` 完全一致，且为高熵随机串。
- [ ] `trusted_users` 里只有自己的 admin QQ + 你充分信任的人。
- [ ] `trusted_groups` 不含开放陌生群。
- [ ] `allowed_paths` 已限定到工作目录，不让 Agent 碰到系统 / 文档 / 隐私目录。
- [ ] **已审计 my-neuro 当前启用的所有插件的 `getTools()`**，确认其中没有未做沙箱的"任意命令执行 / 任意路径访问 / 系统级别 / IoT 控制"工具会被 admin 通过 QQ 间接调用（详见 [6.6](#66-为什么这件事会显著放大攻击面必读安全提示)）。如果不需要远程工具能力，把 `enable_agent_tools` 设为 `false`。
- [ ] 公开仓库 / 截图 / 日志里不要包含真实 QQ 号、token、合并转发原文。
- [ ] 部署机已开自动锁屏与防火墙；新 QQ 小号已养号几天再接入。

---

## 八、故障排查

| 现象 | 排查方向 |
| --- | --- |
| 控制台一直 `Connection lost, reconnecting in Xs...` | 检查 LLBot 是否启动；OneBot 端口与 token 是否对齐；防火墙是否拦了本机回环 |
| `[qq-client] 未配置 OneBot access_token` 警告 | 给 LLBot 与本插件设置同一个 `access_token` |
| 私聊机器人不回复 | 你的 QQ 是不是在 `trusted_users`？level 是不是 `admin` 或 `trusted`？被限流了？ |
| 群里 @ 机器人不回 | 群是不是在 `trusted_groups`？level 是不是 `trusted` / `open`？`ignore_at_all=true` 会让 @全体成员不算 |
| admin 私聊回复不进电脑端历史 | `unified_context_enabled` 是不是 `true`？my-neuro 的 `voiceChat` 全局对象是否可用（控制台搜 `voiceChat 不可用`）|
| Agent 工具一直报"路径不在允许的目录白名单" | `allowed_paths` 配的是不是绝对路径 + 双反斜杠？文件操作的目标在不在白名单内？ |
| 合并转发被自动展开很慢 | 调小 `forward_expand_limit` 或调大 `action_timeout_ms` |
| LLBot 频繁掉线 / QQ 被风控 | 换个养久一点的小号；不要短时间高频外发；先在 QQ 客户端正常聊天几次 |

---

## 九、版本记录

### v1.1.1（2026-05，文档修订）

- **澄清 admin 工具权限范围**：之前 README 第六章只列出 `qq-connect` 自带的 12 个工具，容易让人误以为 admin 通过 QQ 只能调用这些。修订后第六章新增 6.3 / 6.4 / 6.5 / 6.6 四个小节，明确说明 admin 实际可调用的是 my-neuro 当前所有已启用插件 `getTools()` 暴露的工具的并集 + 动态注册的工具，并给出收集链路图、各路径工具可用性对照表、查看实际工具列表的方法、以及攻击面放大场景与缓解措施。
- 安全自检清单（第七章）补一条：审计当前所有启用插件的 `getTools()`。

### v1.1.0（2026-05）

- **AI 回复进主上下文不再附加 `[QQ回复]` 前缀**：admin 收到的 QQ 回复保持纯净文本入 `voiceChat.messages`，与电脑端语音回复结构一致。
- **系统提示同步调整**：`_buildSourceTagsPatch` 删除 `[QQ回复]` 那条说明，把"无前缀"改写为同时涵盖"电脑端用户输入"与"你给主人的回复"两种情况，避免 LLM 困惑。
- `qq_reply_prefix` 配置项保留为弃用字段，向后兼容。
- 群聊 / trusted / 转述路径不变；legacy（`unified_context_enabled=false`）路径不受影响。

### v1.0.0

- 首发：OneBot 11 客户端、三级用户 / 群权限、统一上下文（admin 私聊）、独立 session（trusted / 群聊）、TTS 转述队列、Function Calling 工具集、限流、合并转发解析与外发、分段回复、MemOS 集成、自检脚本。

---

## 十、目录结构（参考）

| 文件 | 说明 |
| --- | --- |
| `index.js` | 插件主入口、消息路由、LLM 工具循环、主上下文写回 |
| `qq-client.js` | OneBot 11 WebSocket 客户端、消息链解析、合并转发处理 |
| `permission-manager.js` | 用户权限管理（admin / trusted / normal） |
| `group-permission.js` | 群权限管理（trusted / open / normal） |
| `session-manager.js` | 独立会话存储与扫描清理（trusted / 群聊） |
| `rate-limiter.js` | 按 key 分桶限流（stall / discard） |
| `agent-executor.js` | Function Calling 工具实现（文件 / 系统 / TTS / 表情） |
| `run-selftest.mjs` | 离线纯函数自检 |
| `metadata.json` | 插件元数据 |
| `plugin_config.json` | 配置模板（已脱敏，token / trusted_users 留空） |
| `package.json` | 仅声明 `selftest` 脚本，无运行时依赖 |
| `.gitignore` | 排除 `LLBOT/`、`node_modules/`、日志、本地隐私配置 |

---

## 十一、给一只追上世界的小肥牛

把肥牛接到 QQ 之后，它就不只是"开机才在桌面"的桌宠了——你出门的时候，它能在 QQ 上回你；你不在家的时候，它能远程帮你 `read_file` 看一眼写到一半的稿子；朋友顺手在群里 @ 它，它会用合适的语气回一句而不会泄露你跟它的私聊。

如果你在这只小肥牛这里获得过哪怕一秒钟的治愈，或者觉得它算个合格的桌面搭子，要不要考虑成为它的"云饲养员"呀？

你的每一次充电，都不是在打赏我，而是在给这只肥牛注入一点点魔法值。让它能变得更聪明、更通人性、能听懂你更多的碎碎念。

不用有压力哦！你愿意打开它，就是对我最大的鼓励啦。如果刚好有余力，就请肥牛喝瓶快乐水叭，它会记住你的味道的！

爱发电 [https://ifdian.net/a/0923A](https://ifdian.net/a/0923A)

---

## 许可证

本项目采用 **CC BY-NC-SA 4.0** 许可证：可自由分享 / 修改，须署名、非商用、相同条款。

