# lark-team-agent

> This project is a fork of [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge), extended under the MIT license. Big thanks to zarazhangrui for building this excellent bridge and for openly encouraging community forks — this project wouldn't exist without that spirit.

[中文 README](./README.md)

A team-grade bot that bridges Feishu / Lark messenger with local Claude Code or Codex CLI. It extends the original bridge with **multi-user workspace isolation** and **first-contact onboarding**, so the whole team can share one deployed bot while each member keeps their own isolated session, working directory, and memory.

---

## Who this is for

| Scenario | Details |
|----------|---------|
| **Shared team AI Agent** | Product, engineering, and design members all talk to the same Feishu bot, each with fully isolated sessions and working directories |
| **Server-side deployment** | Deploy once on a cloud server; team members need no local setup |
| **Multiple projects** | Each user has a personal workspace and can freely switch between projects with `/cd` and `/ws` |
| **Solo developers** | Multi-user mode is opt-in; when disabled, behaviour is identical to the original bridge |

---

## Team use-case extensions

Built on top of the original bridge, this project extends it for **team scenarios** where multiple people share one deployed bot. The key additions:

### Multi-user workspace isolation

Each team member gets a fully isolated environment — their own session, working directory, and long-term memory. No one's work interferes with anyone else's.

- **Auto-init on first contact**: when a user DMs the bot for the first time, the bridge reads their Feishu display name, converts it to a pinyin directory name, and creates a personal workspace under `workspaceRoot`
- **Directory layout**: each user workspace contains `projects/` and `CC-Memory/`
- **Pre-seeded config files**: `CLAUDE.md` (workspace conventions) and `user.md` (user identity) are written on initialization
- **Stable session scope**: p2p scope is keyed by `senderId` instead of `chatId`, surviving app reinstalls and device switches
- **Concurrency-safe**: concurrent first messages from the same user share a single registration promise; registration failures send a visible error and halt further processing

Enable in your profile config:

```json
{
  "multiUser": {
    "enabled": true,
    "workspaceRoot": "/workspace"
  }
}
```

### Per-user Feishu identity (OAuth token isolation)

When `lark-cli` identity is set to `user-default`, each user authorizes with their **own** Feishu account independently. The bot can then act as that user when reading docs, writing comments, or calling Feishu APIs — without sharing credentials across users.

- **On-demand OAuth flow**: if a user hasn't authorized yet, the bot sends a private device-flow link; once authorized, their token is stored in an isolated `lark-cli` config directory under `user-tokens/<senderId>/`
- **Pending detection**: if authorization is already in progress, the bot reminds the user to complete the browser flow rather than starting a duplicate
- **Token isolation**: each user's `LARKSUITE_CLI_CONFIG_DIR` is injected per-request, so no token ever leaks across users
- **Automatic identity policy**: after authorization, `lark-cli` is configured with `strict-mode off` and `default-as auto` so it seamlessly picks the right identity for each operation

### Dynamic model switching (`/model`)

Switch models on the fly without restarting the bridge — per session or globally.

| Command | Effect |
|---------|--------|
| `/model` | Show the current model (session override and global default) |
| `/model list` | Query available models from the API, grouped by family, with the current model marked |
| `/model <name>` | Switch model for the current session only |
| `/model reset` | Clear the session override and restore the global default |
| `/model --global <name>` | Change the global default for all sessions without a per-session override |

- Session-level and global-level settings are independent — a per-session switch doesn't affect other users or other chats
- Model preference is persisted and survives bridge restarts

### First-contact onboarding

New team members are greeted automatically — no manual setup or documentation-hunting required.

- After workspace initialization, the bot sends a welcome message introducing its capabilities and available commands
- Supports an external `onboarding.md` file for custom content, with `{name}`, `{workspace}`, and `{pinyinDir}` placeholders
- Built-in default content covers: capability overview, command reference, and CC-Memory usage guide

---

## Original features (fully preserved)

### Message forwarding

- Send a DM directly, or `@bot` in a group, to forward tasks to local Claude Code or Codex CLI
- **Streaming card**: text replies and tool calls update in real time on a single Lark card
- **COT process messages**: optionally send a progress message with agent step text and tool summaries, then deliver the final answer separately
- **Session continuity**: each chat, topic, or document comment thread keeps its own session
- **Queuing and batching**: messages sent in quick succession are handled together; messages during a run queue for the next turn; `/new`, `/cd`, `/ws use`, and `/stop` interrupt the current run

### Working directory management

| Command | Effect |
|---------|--------|
| `/cd <path>` | Switch working directory and reset the current session |
| `/ws list` | List named workspaces |
| `/ws save <name>` | Save the current directory under a name |
| `/ws use <name>` | Switch to a named workspace |
| `/ws remove <name>` | Delete a named workspace |

### Session management

| Command | Effect |
|---------|--------|
| `/new` / `/reset` | Clear the current session |
| `/new chat [name]` | Create a Feishu group chat bound to a new session, inheriting the current working directory; the invoker becomes the group owner |
| `/resume` | Browse and restore compatible history sessions |
| `/stop` | Stop the current run |
| `/timeout [N\|off\|default]` | Set or clear the session idle watchdog |

### Model switching

| Command | Effect |
|---------|--------|
| `/model` | Show the current model |
| `/model list` | Show available models grouped by family |
| `/model <name>` | Switch to the named model; takes effect on the next message |
| `/model reset` | Restore the default model |

### Status and configuration

| Command | Effect |
|---------|--------|
| `/status` | Show profile, agent, cwd, session, lark-cli identity, and run state |
| `/config` | Adjust reply mode, tool-call display, COT mode, access lists, and lark-cli identity |
| `/help` | Help card |

### Access control

Private by default — only the bot creator can use it. Manage access with:

| Command | Effect |
|---------|--------|
| `/invite user @name` | Allow a user to DM the bot |
| `/invite admin @name` | Add an admin |
| `/invite group` | Allow the current group |
| `/invite all group` | Allow every group the bot is in |
| `/remove user @name` | Remove a user |
| `/remove admin @name` | Remove an admin |
| `/remove group` | Remove the current group |

### System maintenance

| Command | Effect |
|---------|--------|
| `/ps` | List local bridge processes |
| `/exit <id\|#>` | Stop a bridge process |
| `/reconnect` | Force a WebSocket reconnect |
| `/doctor [description]` | Run low-sensitivity diagnostics |

### Media and files

- Send images or files directly to the bot; the bridge downloads them locally before passing them to the agent
- CloudDoc comment mentions are handled per document thread

### Multiple profiles / agents

- Each profile has its own app credentials, sessions, workspaces, lark-cli directory, and logs
- Run Claude and Codex as separate bots using separate profiles

---

## Quick deployment

**Recommended: let Claude Code install it for you.**

Open Claude Code on your server and send it this prompt:

```
Help me install and configure lark-team-agent (a Feishu × Claude Code team bot).
Project: https://github.com/Fengzhaopeng/lark-team-agent
Please follow the README to install, configure the Feishu app, and start the service.
```

Claude Code will read the README, run the install steps, and guide you through the Feishu app setup — no manual work needed.

---

### Manual install (fallback)

Prerequisites: Node.js >= 20.12.0, Claude Code installed and logged in.

```bash
git clone https://github.com/Fengzhaopeng/lark-team-agent.git
cd lark-team-agent
npm install --ignore-scripts
npm run build
npm install -g .
lark-team-agent run
```

---

## Data directories

| Path | Content |
|------|---------|
| `~/.lark-channel/config.json` | Root config (profiles + active profile) |
| `~/.lark-channel/profiles/<profile>/sessions.json` | Session state |
| `~/.lark-channel/profiles/<profile>/workspaces.json` | Workspace bindings |
| `~/.lark-channel/profiles/<profile>/users.json` | Multi-user registry (multi-user mode) |
| `~/.lark-channel/profiles/<profile>/lark-cli/` | Profile-local lark-cli directory |
| `~/.lark-channel/profiles/<profile>/logs/` | Structured run logs |
| `/workspace/<pinyinDir>/` | User personal workspace (multi-user mode) |
| `/workspace/<pinyinDir>/CLAUDE.md` | Workspace conventions |
| `/workspace/<pinyinDir>/user.md` | User identity info |
| `/workspace/<pinyinDir>/CC-Memory/` | User long-term memory directory |
| `/workspace/<pinyinDir>/projects/` | User project directory |

---

## Permission modes

The recommended profile config field is `permissions.defaultAccess` and `permissions.maxAccess`. New profiles default to `full` for both values. To tighten a profile, set either to `workspace` or `read-only`.

```json
{
  "permissions": {
    "defaultAccess": "full",
    "maxAccess": "full"
  }
}
```

| Bridge access | Claude permission mode |
|---------------|----------------------|
| `full` | `bypassPermissions` |
| `workspace` | `acceptEdits` |
| `read-only` | `plan` |

The legacy `sandbox` field is still readable for old configs. After the bridge saves the profile, it migrates that setting to canonical `permissions`.

---

## Service commands (background daemon)

Install globally before using service commands. Service commands install a per-profile service:

```bash
lark-team-agent start [--profile <name>]
lark-team-agent stop [--profile <name>]
lark-team-agent restart [--profile <name>]
lark-team-agent status [--profile <name>]
lark-team-agent unregister [--profile <name>]
```

Platform mapping:
- **macOS**: launchd user agent
- **Linux**: systemd user unit
- **Windows**: Task Scheduler task, launched through a `.cmd` wrapper

### Profile management

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

## lark-cli identity policy

Each profile uses a profile-local lark-cli directory at `~/.lark-channel/profiles/<profile>/lark-cli`. The agent process receives `LARKSUITE_CLI_CONFIG_DIR` pointing to that directory, so personal authorization in one profile is not shared with another.

The default policy is `bot-only`. Switch to `user-default` in `/config` to allow an authorized user identity alongside the app identity. `/status` shows the current summary as `lark-cli: app` or `lark-cli: user-ready`.

Each profile may define a default working directory through `workspaces.default`. New profiles can be created with `--workspace <path>`; if omitted, the bridge creates a profile-managed default working directory.

---

## Cloud-doc comments

Cloud-doc comments are document-scoped: anyone who can comment in a supported document and mention the bot can trigger a reply. No separate workspace binding or document allowlist is required.

---

## Development

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
```

---

## Acknowledgements

This project is built on top of [zarazhangrui/feishu-claude-code-bridge](https://github.com/zarazhangrui/feishu-claude-code-bridge) under the MIT license. Thank you zarazhangrui for creating such a solid foundation for bridging Feishu with local AI agents, and for welcoming community forks.

---

## License

[MIT](./LICENSE)
