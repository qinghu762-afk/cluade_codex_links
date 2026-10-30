# Codex 安装指令

把下面整段发到对应的 CLI 对话；把“本安装包”替换为实际解压目录，或直接附上本文件的路径。

> 请安装本安装包的用户级 agent-link skill。先阅读本文件，定位当前包根目录。在当前对话的终端工具中查找 Node.js 22+ 的绝对路径，运行该绝对路径的 node.exe 加上本包 scripts/install.mjs 的绝对路径。不要修改全局权限、启动 hook 或执行策略。若需要写入用户技能目录，按当前审批机制请求所需权限。安装完成后读取返回 destination 中的 SKILL.md，让本对话立即知道用法。不要复制任何运行凭据到包内；不要因为本安装请求自动开启联动。

## Node 定位（安装时执行一次）

优先 Get-Command node.exe；若工具 PATH 找不到，依次检查 LOCALAPPDATA\Programs\nodejs\node.exe、ProgramFiles\nodejs\node.exe、USERPROFILE\scoop\apps\nodejs-lts\current\node.exe。只使用实际存在且 --version 验证为 22+ 的 Node，不猜路径、不自动安装依赖。

在 PowerShell 中调用形态：

```powershell
& '<检测到的 node.exe 绝对路径>' '<本包绝对路径>\scripts\install.mjs'
```

安装目录：~/.agents/skills/agent-link。两端安装各做一次。后续在两边分别说：

> 开启联动，允许本次协作的任务结果自动回传。

不再需要固定目录、/rename、手动查 UUID 或手工登记。全局 skill 没刷新时仅需重开一次。启动成功、登录与本机 queue/管道支持仍是前提；本工具不修复宿主自身的启动超时。

## 升级与卸载

从新包再次运行安装器即升级；旧版本留在同级 .agent-link-backup-*。有手动新增/改动文件会停止，避免覆盖。卸载时让对应对话通过保存的 Node 绝对路径执行已安装 scripts/install.mjs uninstall。只卸载本端且校验工具所有权；另一端、备份和私有运行数据保留。

安装器没有联网步骤，不读取登录 token，不修改原先项目里的 agent-send 工具。
