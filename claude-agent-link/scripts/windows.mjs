import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, dirname, extname, join } from 'node:path';

export function fail(code, message) { return Object.assign(new Error(message), { code }); }

export function runProcess(command, args, { timeout = 15000, env = process.env, input } = {}) {
  return new Promise((resolve, reject) => {
    // pwsh 7's inherited PSModulePath can break Windows PowerShell 5.1 module loading.
    const childEnv = /(?:^|[\\/])powershell(?:\.exe)?$/i.test(command)
      ? { ...env, PSModulePath: join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') }
      : env;
    const child = spawn(command, args, { env: childEnv, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false, outputLimit = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === 'win32' && child.pid) {
        spawnSync(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
      child.kill();
    }, timeout);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const capture = kind => data => {
      if (stdout.length + stderr.length + data.length > 1024 * 1024) { outputLimit = true; child.kill(); return; }
      if (kind === 'out') stdout += data; else stderr += data;
    };
    child.stdout.on('data', capture('out')); child.stderr.on('data', capture('err'));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); reject(fail('PROCESS_START_FAILED', '无法启动命令，请检查 PATH 和可执行文件。')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return reject(fail('TIMEOUT', '命令超时；未重试。目标可能已收到消息，请先查看目标窗口。'));
      if (outputLimit) return reject(fail('OUTPUT_LIMIT', '命令输出过大，已停止等待。请检查目标窗口，勿直接重发。'));
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

const psHeader = "$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); ";
async function powershell(script, input = '', extraEnv = {}) {
  const result = await runProcess(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psHeader + script], {
    input, env: { ...process.env, ...extraEnv }, timeout: 15000,
  });
  if (result.code !== 0) throw fail('WINDOWS_SECURITY_FAILED', 'Windows 凭据保护或目录 ACL 操作失败。请使用同一 Windows 用户和可写的本机 NTFS 目录。');
  return result.stdout.trim();
}

export const windowsVault = {
  async secure(directory) {
    if (process.platform !== 'win32') throw fail('WINDOWS_REQUIRED', '凭据登记仅支持 Windows 原生 Node.js。');
    await powershell(
      "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; " +
      "$existing=Get-Acl -LiteralPath $env:AGENT_LINK_SECURE_DIR; $owner=$existing.GetOwner([Security.Principal.SecurityIdentifier]).Value; " +
      "$rules=@($existing.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])); " +
      "$safe=($existing.AreAccessRulesProtected -and $owner -eq $sid.Value -and $rules.Count -ge 1); " +
      "foreach($r in $rules) { if($r.IdentityReference.Value -notin @($sid.Value,'S-1-5-18') -or $r.AccessControlType -ne 'Allow' -or $r.IsInherited) { $safe=$false } }; " +
      "$own=@($rules | Where-Object { $_.IdentityReference.Value -eq $sid.Value -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl -and ($_.InheritanceFlags -band 3) -eq 3 }); " +
      "if($safe -and $own.Count -gt 0) { 'secured'; exit 0 }; " +
      "$acl=[Security.AccessControl.DirectorySecurity]::new(); $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false); " +
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')); " +
      "$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'),'FullControl','ContainerInherit,ObjectInherit','None','Allow')); " +
      "Set-Acl -LiteralPath $env:AGENT_LINK_SECURE_DIR -AclObject $acl; 'secured'",
      '', { AGENT_LINK_SECURE_DIR: directory },
    );
  },
  async seal(token) {
    return powershell("$v=[Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString $v -AsPlainText -Force)", token);
  },
  async unseal(ciphertext) {
    return powershell(
      "$s=ConvertTo-SecureString ([Console]::In.ReadToEnd()); $p=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); " +
      "try { [Console]::Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($p)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($p) }", ciphertext,
    );
  },
};

export function findCommand(name) {
  const dirs = (process.env.PATH || '').split(delimiter);
  for (const dir of dirs) {
    for (const suffix of process.platform === 'win32' ? ['.exe', '.cmd', '.ps1', ''] : ['']) {
      const candidate = join(dir.replace(/^"|"$/g, ''), name + suffix);
      try { accessSync(candidate, constants.F_OK); return candidate; } catch {}
    }
  }
  throw fail('COMMAND_NOT_FOUND', `找不到 ${name}，请安装后重新打开终端。`);
}

export function commandInvocation(file, args) {
  const ext = extname(file).toLowerCase();
  if (ext === '.mjs' || ext === '.js') return { command: process.execPath, args: [file, ...args] };
  if (ext === '.cmd' || ext === '.ps1') {
    if (!(args.length === 1 && args[0] === '--version')) {
      throw fail('UNSUPPORTED_SHIM', '无法安全地通过未知 .cmd/.ps1 包装器传递消息。请使用官方 npm 安装，或把 AGENT_LINK_CODEX 指向 Codex .exe / 官方 codex.js。');
    }
    // All user input goes through environment/JSON, never through PowerShell source.
    return {
      command: 'powershell.exe',
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', psHeader +
        "$argvValues=@(ConvertFrom-Json $env:AGENT_LINK_ARGV); & $env:AGENT_LINK_EXEC @argvValues; if ($null -ne $LASTEXITCODE) { exit $LASTEXITCODE }"],
      env: { ...process.env, AGENT_LINK_EXEC: file, AGENT_LINK_ARGV: JSON.stringify(args) },
    };
  }
  return { command: file, args };
}

export async function runCodex(args, timeout) {
  const file = process.env.AGENT_LINK_CODEX || findCommand('codex');
  // Official npm shim: avoid cmd.exe length and quoting limitations entirely.
  if (['.cmd', '.ps1'].includes(extname(file).toLowerCase()) && !process.env.AGENT_LINK_CODEX) {
    const entry = join(dirname(file), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try {
      accessSync(entry, constants.F_OK);
      return runProcess(process.execPath, [entry, ...args], { timeout });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const invocation = commandInvocation(file, args);
  return runProcess(invocation.command, invocation.args, { timeout, env: invocation.env || process.env });
}
