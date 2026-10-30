# Claude Code ↔ Codex 联动 Skills

[正式发布 1.0.1](https://github.com/qinghu762-afk/cluade_codex_links/releases/tag/1.0.1)

Windows 原生版，一次安装，两个 CLI 对话各说一句即可登记、配对和握手。

## 下载 1.0.1

| 安装包 | 下载 |
|---|---|
| Claude Code | [claude-agent-link.zip](https://github.com/qinghu762-afk/cluade_codex_links/raw/refs/heads/main/downloads/claude-agent-link.zip) |
| Codex CLI | [codex-agent-link.zip](https://github.com/qinghu762-afk/cluade_codex_links/raw/refs/heads/main/downloads/codex-agent-link.zip) |
| 完整分享包（含两端及验证源码） | [claude-codex-agent-link.zip](https://github.com/qinghu762-afk/cluade_codex_links/raw/refs/heads/main/downloads/claude-codex-agent-link.zip) |

解压后，将各包的 INSTALL.md 路径交给对应对话，要求安装用户级 skill。以后在两端各说：

> 开启联动，允许本次协作的任务结果自动回传。

源码安装入口：[Claude 安装指令](claude-agent-link/INSTALL.md)、[Codex 安装指令](codex-agent-link/INSTALL.md)。

---

# Agent Link：一次安装，两个对话开启联动

适用：同一 Windows 用户、同一台电脑上的 Claude Code CLI 和 Codex CLI。两端需已安装登录；Node.js 22+。无需 Python、WSL、第三方桥接服务或新增 API 账号。

## 第一次只做这两步

1. 把 `claude-agent-link/INSTALL.md` 的路径发给 **Claude Code 对话**，说：“按这个文件安装用户级 skill，安装后读取已安装的 SKILL.md。”
2. 把 `codex-agent-link/INSTALL.md` 的路径发给 **Codex CLI 对话**，说同一句话。

对应对话会定位本机 Node，运行本包的安装器。写用户 skill 目录时可能按现有权限机制请求批准；无需管理员安装，不修改全局执行策略、权限、启动 hook 或登录设置。只在安装/升级时做一次，不是每开一个项目都装。

安装目录：Claude `~/.claude/skills/agent-link`；Codex `~/.agents/skills/agent-link`。如果技能列表没刷新，可重开对话一次；安装器返回的路径可供当前对话直接读取，不必反复安装。

## 以后怎么用

照常从任何项目目录打开两个 CLI。在两个对话里各发一句，先后顺序不限：

> 开启联动，允许本次协作的任务结果自动回传。

也可显式触发：Claude 用 `/agent-link` 加上这句话；Codex 用 `$agent-link` 加上这句话。skill 负责自动登记本会话、选择唯一对端、执行握手。**这句话触发自动登记，不代表一打开窗口就在后台登记。** 如果你只说“开启联动”而没有授权自动结果汇报，skill 会先确认该授权范围。

第一端显示等待对端属于正常状态；另一端开启后会交换 hello/pong，并通过 confirm 记录握手通过。若有多个可选会话，只需要选一次，不会自动挑最近记录或抢占别人的配对。只有记录为 ready 才能派任务。

接着直接对其中一端说：

> 把这个已确认的任务交给对端，完成或遇到阻塞后自动回传结果；你收到结果后检查实际文件。

成功、失败、阻塞都需要实际回传；只在当前窗口回答“已完成”不算发送。每条任务的回传命令和结果文件由工具自动生成，使用绝对 Node/脚本路径及唯一任务标识。工作目录不同时，任务中的素材、契约和报告路径要写成绝对路径。

**原有项目里的 agent-send 不会被覆盖。** 新版激活后使用 agent-link 的配对和回传协议，不再依赖旧名称 thumbnail-maker、手动 UUID 或旧回传命令。现有已开的两个对话可以先读取新版已安装 skill，再分别开启联动；它们不会自动从旧登记迁移成 ready。

## 状态的含义

| 状态 | 说明 |
|---|---|
| waiting_for_peer | 当前会话已登记，等待另一端开启；或对端已有有效配对，未抢占。 |
| choose_peer | 多个候选，需要你选一个。模型用你选择的 ID 配对，不需要你手敲 UUID。 |
| handshake_pending / pong_submitted_unconfirmed | 控制消息已提交，尚不能认为双方已处理。 |
| ready | 匹配本次唯一 nonce 的握手已在发起会话确认。 |
| queued_unconfirmed / written_unconfirmed | 消息已提交或写入，不等于已接收或已执行。 |
| received | 派发方已经处理结果并执行 ack；仍不代表工作内容经人工最终验收。 |

通过安装时保存的 Node 和脚本绝对路径执行 `status` 可查看本会话状态；让对话自己查即可，不用手动复制命令。原生 Claude 界面可能把本机管道消息显示为“Another Claude session sent a message”；内容中的来源标签会区分 Claude/Codex，这个标签本身不构成身份授权。

## 重开、退出和多个会话

- 重开后在每端再说一次完整的开启语句，登记由 skill 自动完成。新 Claude 管道和新 Codex 线程都重新识别，不猜旧身份。
- 默认登记在 12 小时内是候选；超过后需再次开启刷新。这只是候选有效期，不是存活证明。
- 结束一组协作时让双方执行 `off` 释放配对。因没有全局退出 hook，强行关闭窗口可能留下未过期候选；出现多个候选时会让你选择，不能保证从历史登记自动判断谁在线。
- 本地权限审批仍按 CLI 原来的规则进行；授权自动汇报不等于关闭审批或授权任意任务。超时可能已经投递，工具不自动重发。

## 分享给别人

直接分享单端 ZIP 或完整 ZIP。别人只需在自己的两个 CLI 对话里安装对应包，再各自开启联动。**共享的是 skill，不是你已经配对的会话。** 当前版本不连接别人的电脑，不支持跨 Windows 用户或跨机器直接配对。

可分享包只含说明、skill、Node 脚本、版本标记和验证源码。没有你的账号 token、Claude 管道凭据、会话 UUID、安装路径或视频素材。每次安装都会检测接收者自己的绝对 Node/Codex 路径，不用修改源码。

运行数据位于当前用户 `%LOCALAPPDATA%\ClaudeCodexLink`：Windows ACL 只给当前用户和 SYSTEM，Claude 凭据额外用 DPAPI CurrentUser 加密。这里还会有任务内容和结果文件，**不要把这个运行目录打包分享**。

## 升级与卸载

从新版解压目录再次运行对应安装器即可升级，旧版保留为同级 `.agent-link-backup-*` 目录，便于恢复。若发现同名其他 skill、新增文件或已安装文件被手动改动，会停止，保留用户文件，不会盲目覆盖。

卸载：让对应对话读取其安装目录的 `installation.json`，使用保存的 Node 绝对路径运行已安装的 `scripts/install.mjs uninstall`。只删除本宿主且通过所有权/文件校验的工具文件。另一端、版本备份和 `%LOCALAPPDATA%` 的运行数据保留；不会改全局设置。

## 常见问题

| 情况 | 处理 |
|---|---|
| 找不到 Node | 安装指令列有常见位置；必须实际检测到 Node 22+，不会自动安装依赖。运行时不依赖 PATH。 |
| IDENTITY_MISSING | 必须在目标对话自己的工具进程内运行 activate；不能在外层终端、另一个聊天登记。Claude 可改用自己可用的另一个 shell 工具；不能复制 token。 |
| LOCAL_CONSENT_REQUIRED / NOT_ACTIVE | 由用户在当前端说完整开启语句；另一端不能代替你授予本地同意。 |
| PEER_NOT_FOUND / PAIR_NOT_READY | 两端都先开启；检查多候选选择、旧配对和实际握手。 |
| CODEX_FAILED | 目标 CLI 未运行、后台连接或审批有问题；检查窗口。本工具不会自动使用 --no-daemon 或修改认证。 |
| PIPE_UNAVAILABLE / TIMEOUT | 查看目标是否已接收；需要时重新开启登记。不要直接连续重发。 |
| STATE_BUSY | 某个记录事务正在运行，或进程崩溃遗留 transaction.lock。先确认没有正在运行的 agent-link 命令，再检查专用运行目录中的空锁目录，不能删除整份运行数据。 |
| INSTALL_CONFLICT / UNMANAGED_FILES / UNMANAGED_CHANGES | 保留了其他 skill 或你的修改，停止安装/卸载。先备份并检查，不要强制覆盖。 |

派发能力不等于原生生图能力。封面流程位于各端 `references/thumbnail.md`，需要素材与实际 image_gen 工具；不可用时回传阻塞，不会擅自更换账号或计费方式。

## 验证

完整包的 `validation/` 中提供源码和自动化测试。从该目录运行 `node --test tests/core.test.mjs tests/native.test.mjs`；不需要 npm install。测试在隔离的模拟用户目录安装，不会安装到你的真实用户 skill 目录。真实 Windows 管道/DPAPI + 受控 Codex 队列替身用于闭环验证，不会向实际模型发任务。

实际模型按 skill 自主调用工具仍需在目标会话验收；不能把测试程序的自动处理当成对任意模型的保证。详见 `VERIFICATION.md`。

接口参考：[Codex 用户级 skills](https://learn.chatgpt.com/docs/build-skills)、[Claude skills](https://code.claude.com/docs/en/skills)、[Claude Windows 管道认证](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)。
