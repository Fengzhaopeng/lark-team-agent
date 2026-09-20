# 更新日志

## v0.7.0-beta.1（2026-09-20）

> **Beta**：决策网关（Decision Gateway）首个版本。**默认关闭**，需在 profile 的
> `preferences.decisionGateway` 中显式开启；未配置时所有代码路径与 v0.6.3 完全一致。

### 新增

- **决策网关（Decision Gateway）** — 在 agent 运行链路的**两端**各加一道「闭合集合判定」，
  把「决策」和「生成」拆开：agent 负责生成，网关负责判定。网关不产生任何自由文本，
  只返回**受限选项 + 置信度**，因此输出可校验、可阈值化、可回滚。

  两个能力：

  1. **模型路由**（运行前）— 根据 prompt 复杂度从配置的档位阶梯中选一个模型，
     取代「一个 profile 静态绑定一个模型」。落点在 `run-flow` 的模型解析处，
     优先级为：**会话级 `/model` 覆盖 > 网关路由 > profile 配置 > agent 默认**。
     profile 里显式 pin 的模型**永远不会**被路由改写。
  2. **出站护栏**（投递前）— 回复发往飞书前的最后一道检查，识别凭证、密码、
     内网地址、本机路径四类泄漏。落点是 `sendFinalReply`，覆盖 card / markdown /
     text 三种渲染模式。

- **配置结构**（`preferences.decisionGateway`）：

  ```json
  {
    "decisionGateway": {
      "mode": "dry-run",
      "model": "fast-model-id",
      "threshold": 0.7,
      "timeoutMs": 3000,
      "modelRoute": {
        "tiers": [
          { "label": "轻量", "model": "claude-haiku-4-5", "hint": "单点查询、格式转换、简单改写" },
          { "label": "标准", "model": "claude-sonnet-5", "hint": "常规实现、多文件改动、分析调试" },
          { "label": "重度", "model": "claude-opus-4-8", "hint": "架构决策、长链路推理、疑难诊断" }
        ]
      },
      "outboundGuard": {
        "action": "log",
        "categories": ["api-key", "password", "internal-host", "private-path"],
        "minChars": 40
      }
    }
  }
  ```

  - `mode`：`off`（默认）/ `dry-run`（判定并记录，但不改变任何行为）/ `active`（应用判定）。
  - `model` 与 `baseUrl` / `apiKey` **默认复用 `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`**，
    即与 agent 走同一个内网出口 —— 不引入新的供应商、新的凭证、新的数据出境路径。
  - `outboundGuard.action`：`log`（仅记录并在回复末尾追加一行提示）/ `block`（拦截该条回复）。
    `dry-run` 模式下始终等同 `log`，不会拦截。

### 设计约束（三条不可越过的红线）

1. **失败即降级**：网关任何异常（超时、非 200、答案不在选项内、模型不存在）
   都退化为「未决策」，主链路按原逻辑继续。**它没有任何能力阻断一次运行。**
2. **只收紧，不放开**：网关不能授予权限、不能放宽沙箱、不能绕过白名单。
   确定性规则始终是下限，网关最多是在其之上再加一层。
3. **`dry-run` 先行**：档位阶梯应在真实流量上以 `dry-run` 观察准确率与耗时，
   再切 `active`。判定耗时直接叠加在用户等待上，默认超时 3 秒。

### 实测（2026-09-20，本机 → 内网 modelproxy）

在真实网关上跑过 6 个场景（路由 ×2、不确定边界 ×1、出站检查 ×3）：

| 模型 | 判定 | 单次延迟 |
|---|---|---|
| `deepseek-flash` | **6/6 语义正确**（1 例回抄了选项注释，由解析器兜底）— **推荐** | 1.5–1.7s |
| `claude-sonnet-5` | 256 tokens 下 6/6；64 tokens 下 4/6（2 例截断） | 1.6–4.2s |
| `glm-5.3-flash` | 5/6 — 泄漏场景返回空串即**漏报**，**不推荐** | 1.4–3.9s |

两个默认值是由这次实测定死的，不是拍的：

- **输出预算 256 tokens**。64 tokens 时推理型模型会在吐出 JSON 前耗尽预算，
  截断结果解析成「未决策」——在出站护栏上这是**漏报**，是唯一一种看起来像成功的失败。
- **选项匹配容忍回抄**。模型常把 `- light — 单点查询…` 整行抄回来作为答案，
  严格比对会让路由几乎每次都 abstain（它判对了，我们却扔掉了）。现在接受前置匹配，
  且当两个档位互为前缀时（`light` / `light-plus`）取更具体的那个。

⚠️ 即便最快的模型也要约 1.5 秒，而**模型路由这段时间直接叠加在用户等待上**——
只有「标准 → 轻量」的差价大于这个等待成本时才值得开。**出站护栏不受此限**：
它跑在 run 结束之后，用户此时已经等了整个 run，1.5 秒不可感知。

### 说明

- 新增 `src/decision/`（types / config / provider / gateway / integrate）与
  `tests/unit/decision/` 共 59 个用例。
- 配置写入路径 `normalizePreferences()` 已由测试锁定：`decisionGateway` 块可完整往返，
  且不干扰其它 preference 字段；老 profile 不含该字段时行为不变。

### 刻意未做

- **准入判定**（`policy/access.ts`）保持确定性白名单：该处输入是 open_id 集合成员判定，
  规则 100% 准确、可审计、零成本，换成概率模型是净负收益。
- **附件校验**（`media/attachment.ts`）仍按 kind / size / mime 判定，确定性足够。
- **群消息「该不该理」判定**与**prompt 前置风险重打分**未接入主链路，留待后续版本。

## v0.6.3（2026-09-10）

### 修复

- **团队模式与按需身份授权融合** — v0.6.2 新增的群聊按需授权逻辑（`userTokenRegistry` 构建、`userAuthMode` 判定）此前直接读取原始 `larkCli.identityPreset` 字段，未经过既有的团队模式覆盖机制 `effectiveLarkCliIdentity()`。由于 `/config` 在切回个人模式时会保留切换前保存的 `identityPreset`（团队模式下不清空，以便切回个人模式时恢复生效），存在"当前处于团队模式但 `identityPreset` 残留为 `user-default`"的合法状态；此状态下按需授权逻辑会被错误激活，与团队模式"强制仅使用应用身份"的既定语义冲突。新增 `isUserAuthModeActive()`（`src/config/profile-schema.ts`），统一封装"多用户开启 + 有效身份为 `user-default`"的判断并经由 `effectiveLarkCliIdentity()` 解析，`channel.ts` 中两处相关判断均改为调用该函数。`/config` 命令的 UI 与持久化逻辑未改动。

## v0.6.2（2026-09-10）

### 变更

- **群聊按需身份授权** — 多用户 + `identityPreset: user-default` 模式下，群聊里未完成飞书个人身份授权的成员发消息不再被提前拦截；agent 正常以 bot 身份处理请求，仅当请求内容确实需要发送者本人身份（如读取该人私有文档）时，才由 agent 输出固定哨兵文本 `[[NEED_USER_AUTH]]`，bridge 拦截该哨兵并转为私信授权链接 + 群内提示"需要授权，请重新发送消息"。p2p 私聊行为不变，仍在运行前提前拦截。

## v0.6.1（2026-09-10）

### 新增

- **`/@bot on|off|reset|status` 指令** — 按会话（群）覆盖是否需要 @机器人 才响应，独立于全局 `requireMentionInGroup` 配置。
- **`/quota` 指令** — 查询 API Key 池（`ANTHROPIC_API_KEY_POOL`）中每个 key 的剩余额度、已用额度，汇总展示。

### 修复

- **模型探测（`/model scan`）改为分轮探测** — 对话 / 生图 / 生视频三项能力改为分别顺序探测（而非同时探测三个端点），避免慢速的生图/生视频探测拖慢快速的对话探测；各轮并发限制互相独立。
- **`isImageCapable` 误判** — 部分模型对探测用的小尺寸参数返回 400，此前被误判为不支持生图；现在识别出该类"尺寸不支持但功能可用"的 400 响应，正确标记为支持生图。

## v0.6.0（2026-07-17）

### 新增

- **`/image {描述}` 指令** — 在对话中直接调用可用的图像生成模型（如 GPT Image、Doubao Seedream 系列）生成图片，结果直接发回对话。对话中包含生图需求时，Agent 也可自动调用。支持 `--model <模型ID>` 和 `--size <尺寸>` 参数。
- **`/video {描述}` 指令** — 调用可用的视频生成模型异步生成视频，自动等待任务完成并发回结果链接。
- **`/model scan` 指令** — 对所有可用模型进行实际能力探测（对话 / 生图 / 生视频），结果缓存到本地，有效期 7 天。
- **模型能力自动探测** — Bridge 启动后自动在后台完成模型能力探测，缓存缺失或超过 7 天时自动刷新，无需手动执行 `/model scan`。
- **`/model list` 过滤优化** — 基于探测缓存仅展示支持对话的模型，过滤掉生图 / 生视频等不适用于 Claude Code `--model` 参数的模型。

### 修复

- **CVE-2025-54261（vitest GHSA-5xrq-8626-4rwp）** — 升级 vitest 从 2.x 至 3.2.7，修复高危安全漏洞。
- **`prepare` 脚本兼容性** — 修复 Docker 环境（无 pnpm）下 `npm install` 触发 `prepare` 脚本失败的问题，改为直接调用 `tsup`。
- **Docker 构建失败** — 修复 `.dockerignore` 中路径名旧引用，解决 `pnpm node_modules` 被误复制进镜像导致的 npm 安装报错。

---

## v0.5.x（历史版本）

功能详见 [README](./README.md)。
