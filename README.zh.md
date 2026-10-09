# lark-team-agent

> 本项目是 [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) 的二次创作版本，基于原项目 MIT 协议进行功能扩展。感谢 zarazhangrui 开源这一优质项目，并鼓励社区在此基础上二创——正是这份开放精神让本项目得以诞生。

[English README](./README.md)

把飞书 / Lark 消息和本地 Claude Code / Codex CLI 打通的团队级 bot。扩展了**多用户独立工作空间**和**自动初始化引导**，让整个产品/研发团队可以共用同一个 bot，各自保持独立的会话、工作目录和记忆。

---

## 适用场景

| 场景 | 说明 |
|------|------|
| **团队共用 AI Agent** | 产品、研发、设计等多个角色通过同一个飞书 bot 使用 Claude Code，各自的会话、工作目录、记忆完全隔离 |
| **企业/团队部署** | 部署在云服务器，成员无需本地安装任何环境，开箱即用 |
| **多项目并行** | 每个用户拥有独立工作空间，可通过 `/cd`、`/ws` 在不同项目间自由切换 |
| **个人开发者** | 兼容原版单用户模式，不启用多用户时与原版完全一致 |

---

## 团队场景扩展功能

在原版 lark-channel-bridge 的基础上，本项目重点扩展了**多人共用同一个 bot** 的团队场景，核心新特性：

### 多用户工作空间（Multi-User Workspace）

每位团队成员拥有完全隔离的独立环境——独立的 session、工作目录和长期记忆，互不干扰。

- **自动初始化**：用户首次私聊 bot 时，自动根据飞书姓名生成拼音目录，在 `workspaceRoot` 下创建专属工作空间
- **目录结构**：每个用户空间包含 `projects/`（项目目录）和 `CC-Memory/`（长期记忆目录）
- **预置配置文件**：自动写入 `CLAUDE.md`（工作空间使用约定）和 `user.md`（用户身份信息）
- **会话隔离**：p2p 私聊的 session scope 改为 `senderId`（不再是 `chatId`），跨设备、跨重装保持稳定
- **并发安全**：同一用户短时间内发多条消息不会触发重复注册，注册失败会给出明确提示

启用方式（在 `config.json` 对应 profile 中）：

```json
{
  "multiUser": {
    "enabled": true,
    "workspaceRoot": "/workspace"
  }
}
```

### 每用户独立飞书身份（OAuth token 隔离）

当 `lark-cli` 身份策略设为 `user-default` 时，每位用户以**自己的**飞书账号独立完成授权。bot 在读取云文档、写入评论、调用飞书 API 时，会以该用户的真实身份操作，各用户凭证互不共享。

- **按需 OAuth 授权**：用户首次触发需要飞书身份的操作时，bot 私信发送设备流授权链接；授权完成后 token 存储在独立的 `lark-cli` 配置目录 `user-tokens/<senderId>/` 下
- **等待状态检测**：若授权流程已在进行中，bot 提醒用户完成浏览器授权，不会重复发起
- **token 隔离**：每次请求按用户注入独立的 `LARKSUITE_CLI_CONFIG_DIR`，token 不会跨用户泄漏
- **自动身份策略**：授权完成后自动执行 `strict-mode off` 和 `default-as auto`，让 lark-cli 无感知地为每次操作选择正确身份

### 模型动态切换（/model）

随时切换模型，无需重启 bridge，支持会话级和全局两种粒度。

| 指令 | 效果 |
|------|------|
| `/model` | 查看当前模型（会话覆盖值 + 全局默认） |
| `/model list` | 查询 API 可用模型列表（按系列分组，标注当前模型） |
| `/model <名称>` | 仅切换当前会话的模型 |
| `/model reset` | 清除会话覆盖，恢复全局默认 |
| `/model --global <名称>` | 修改全局默认，影响所有无会话覆盖的对话 |

- 会话级和全局级设置相互独立，单个会话切换不影响其他用户和其他群
- 模型设置持久化，重启 bridge 后仍然生效

### 首次使用引导（Onboarding）

新成员首次私聊时自动发送欢迎消息，无需人工引导，开箱即用。

- 用户工作空间初始化完成后，自动发送欢迎消息，介绍 bot 能力和可用指令
- 支持通过外部 `onboarding.md` 文件自定义引导内容，支持 `{name}`、`{workspace}`、`{pinyinDir}` 占位符
- 内置默认引导内容，包含：能力介绍、常用指令说明、CC-Memory 使用方法

---

## 原版功能（完整保留）

### 消息转发

- 在飞书私聊直接发消息，或在群里 `@bot`，把任务转给本机 Claude Code / Codex CLI
- **流式卡片**：文本回复和工具调用实时更新在同一张卡片上
- **COT 过程消息**：可选先发一条过程消息展示 agent 的阶段性进度，再单独发送最终答案
- **会话延续**：每个聊天、话题、文档评论有自己的 session，不会互相串
- **消息排队与合并**：短时间连续发送的消息合并处理；任务运行中的消息排队到下一轮

### 工作目录管理

| 指令 | 效果 |
|------|------|
| `/cd <path>` | 切换工作目录，重置当前 session |
| `/ws list` | 查看所有已保存的工作目录 |
| `/ws save <name>` | 将当前目录保存为别名 |
| `/ws use <name>` | 切换到已保存的工作目录 |
| `/ws remove <name>` | 删除工作目录别名 |

### 会话管理

| 指令 | 效果 |
|------|------|
| `/new` / `/reset` | 清除当前 session，开始新对话 |
| `/new chat [名称]` | 新建飞书群并关联 session，自动继承当前工作目录，群主设为发起人本人 |
| `/resume` | 查看并恢复历史 session |
| `/stop` | 停止当前正在运行的任务 |
| `/timeout [N\|off\|default]` | 设置或清除当前 session 的空闲超时 |

### 模型切换

| 指令 | 效果 |
|------|------|
| `/model` | 查看当前使用的模型 |
| `/model list` | 查询可用模型列表（按系列分组） |
| `/model <名称>` | 切换到指定模型，立即对下一次对话生效 |
| `/model reset` | 恢复默认模型 |

### 状态与配置

| 指令 | 效果 |
|------|------|
| `/status` | 查看 profile、agent、工作目录、session、lark-cli 身份、运行状态 |
| `/config` | 调整展示偏好、访问控制、lark-cli 身份策略 |
| `/help` | 帮助卡片 |

### 访问控制

出厂默认只有 bot 创建者可以使用；通过以下指令管理权限：

| 指令 | 效果 |
|------|------|
| `/invite user @某人` | 允许该用户私聊 bot |
| `/invite admin @某人` | 添加为管理员 |
| `/invite group` | 将当前群加入响应名单 |
| `/invite all group` | 一键加入 bot 所在的所有群 |
| `/remove user/admin/group ...` | 移除对应权限 |

### 系统维护

| 指令 | 效果 |
|------|------|
| `/ps` | 列出本地所有 bridge 进程 |
| `/exit <id\|#>` | 停止某个 bridge 进程 |
| `/reconnect` | 强制 WebSocket 重连 |
| `/doctor [描述]` | 运行诊断（低敏感度） |

### 多媒体与文件

- 图片和文件直接发给 bot，bridge 下载到本地后交给 agent 处理
- 支持 CloudDoc 评论中 @bot 触发回复

### 多 Profile / 多 Agent

- 每个 profile 独立维护 app 凭证、sessions、工作目录、lark-cli 目录和日志
- 支持同时运行 Claude + Codex 两个 bot（使用不同 profile）

---

## 快速部署（服务器端）

### 前置条件

- Node.js >= 20.12.0
- Claude Code 已安装并登录：`claude`，详见 https://docs.anthropic.com/en/docs/claude-code/quickstart
- 一个飞书 PersonalAgent 应用（首次启动向导可帮助创建）

### 安装

```bash
git clone https://github.com/Fengzhaopeng/lark-team-agent.git
cd lark-team-agent
pnpm install
pnpm build
npm install -g .
```

### 首次启动

```bash
lark-team-agent run
```

### 启用多用户模式

编辑 `~/.lark-channel/config.json`，在对应 profile 中添加：

```json
{
  "multiUser": {
    "enabled": true,
    "workspaceRoot": "/workspace"
  }
}
```

确保 `workspaceRoot` 目录已存在且 bridge 进程有写权限：

```bash
mkdir -p /workspace
```

重启 bridge 后，新用户首次私聊即自动完成工作空间初始化。

### 自定义引导内容

在 bridge 配置目录下创建 `onboarding.md`，支持以下占位符：

```
{name}        用户飞书姓名
{workspace}   用户工作空间绝对路径
{pinyinDir}   工作空间目录名（拼音）
```

---

## 数据目录

| 路径 | 内容 |
|------|------|
| `~/.lark-channel/config.json` | 根配置（profiles + 活跃 profile） |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session 状态 |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | 工作目录绑定 |
| `~/.lark-channel/profiles/<profile>/users.json` | 多用户注册表（多用户模式） |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile 独立的 lark-cli 目录 |
| `~/.lark-channel/profiles/<profile>/logs/` | 结构化运行日志 |
| `/workspace/<pinyinDir>/` | 用户独立工作空间（多用户模式） |
| `/workspace/<pinyinDir>/CLAUDE.md` | 工作空间使用约定 |
| `/workspace/<pinyinDir>/user.md` | 用户身份信息 |
| `/workspace/<pinyinDir>/CC-Memory/` | 用户长期记忆目录 |
| `/workspace/<pinyinDir>/projects/` | 用户项目目录 |

---

## 权限模式

Profile 配置推荐使用 `permissions.defaultAccess` 和 `permissions.maxAccess` 字段，新建 Profile 默认均为 `full`。如需收紧，可将任意一项设为 `workspace` 或 `read-only`。

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

| Bridge 访问模式 | Claude 权限模式 |
|----------------|----------------|
| `full` | `bypassPermissions` |
| `workspace` | `acceptEdits` |
| `read-only` | `plan` |

旧版 `sandbox` 字段仍可读取。bridge 保存 profile 后，会把该设置迁移为 canonical `permissions`。

---

## 服务命令（后台 daemon）

使用服务命令前需先全局安装。服务命令为每个 profile 安装独立服务（per-profile service）：

```bash
lark-team-agent start [--profile <name>]
lark-team-agent stop [--profile <name>]
lark-team-agent restart [--profile <name>]
lark-team-agent status [--profile <name>]
lark-team-agent unregister [--profile <name>]
```

平台映射：
- **macOS**：launchd user agent
- **Linux**：systemd user unit
- **Windows**：Task Scheduler 任务，launcher 是 `.cmd`

### Profile 管理

```bash
lark-team-agent profile create <name> --agent claude
lark-team-agent profile list
lark-team-agent profile use <name>
lark-team-agent profile remove <name>
lark-team-agent profile remove <name> --purge --yes
lark-team-agent profile export <name> [--output ./profile.json] [--force]
lark-team-agent profile export <name> --include-secrets --yes
```

---

## lark-cli 身份策略

每个 profile 都使用当前 profile 的 lark-cli 目录：`~/.lark-channel/profiles/<profile>/lark-cli`。agent 子进程会收到指向这个目录的 `LARKSUITE_CLI_CONFIG_DIR`，所以一个 profile 里的个人授权不会共享给另一个 profile。

默认策略是 `bot-only`。可在 `/config` 里切换为 `user-default`，允许授权的用户身份与应用身份并用。`/status` 会显示当前状态为 `lark-cli: app` 或 `lark-cli: user-ready`。

每个 profile 可以有一个默认工作目录：`workspaces.default`。新建 profile 时可以传 `--workspace <path>` 作为初始目录。

---

## 云文档评论

云文档评论按文档权限生效：能在支持的文档里评论并 @bot 的人均可触发回复，无需单独绑定工作目录或建立文档白名单。

---

## 开发

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

---

## 致谢

本项目基于 [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) 开发，遵循 MIT 协议。感谢 zarazhangrui 构建了如此完善的飞书-Claude Code 桥接基础设施，并以开放的态度鼓励社区在此之上继续创作。

---

## License

[MIT](./LICENSE)
