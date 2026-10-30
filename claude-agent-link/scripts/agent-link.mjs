#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { Engine } from './engine.mjs';
import { fail } from './windows.mjs';

const help = `Agent Link v2 — 两端各由用户说“开启联动，允许本次协作的任务结果自动回传”\n
activate --allow-replies [--peer <候选ID>]   自动登记并配对\n
status | list | off                          查询 / 本会话退出联动\n
accept --pair <ID> --nonce <nonce>           处理 hello\n
confirm --pair <ID> --nonce <nonce>          处理 pong\n
send --message-file <UTF8文件> [--pair <ID>] 派发用户授权的任务\n
reply --task <ID> --message-file <UTF8文件>  实际回传结果\n
ack --task <ID>                             确认收到结果\n
所有命令可加 --state-dir <专用运行目录>。通过安装时保存的 Node 绝对路径运行。\n
每条控制消息的 command 都要由实际目标会话执行；脚本不会代替模型执行任务或绕过审批。`;

async function main() {
  let parsed;
  try { parsed = parseArgs({ allowPositionals: true, strict: true, options: {
    'allow-replies': { type: 'boolean' }, peer: { type: 'string' }, pair: { type: 'string' }, nonce: { type: 'string' },
    task: { type: 'string' }, 'message-file': { type: 'string' }, 'state-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
  } }); } catch { throw fail('USAGE', '参数无效，请用 --help 查看。'); }
  const { values: o, positionals } = parsed;
  if (o.help || !positionals.length) { console.log(help); return; }
  if (positionals.length !== 1) throw fail('USAGE', '只允许一个操作名，消息请使用 UTF-8 文件。');
  const action = positionals[0];
  const allowed = {
    activate: ['allow-replies', 'peer'], list: [], status: [], off: [],
    accept: ['pair', 'nonce'], confirm: ['pair', 'nonce'], send: ['message-file', 'pair'], reply: ['task', 'message-file'], ack: ['task'],
  };
  if (!(action in allowed) || Object.keys(o).some(k => k !== 'state-dir' && !allowed[action].includes(k))) throw fail('USAGE', '此操作不接受这些选项。');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let info;
  try { info = JSON.parse(await readFile(join(root, 'installation.json'), 'utf8')); }
  catch { throw fail('NOT_INSTALLED', '请先运行本安装包 scripts/install.mjs；不要直接使用未安装包中的运行脚本。'); }
  if (info.appId !== 'claude-codex-agent-link') throw fail('NOT_INSTALLED', '安装记录无效。');
  const stateDir = o['state-dir'] || (process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'ClaudeCodexLink'));
  if (!stateDir) throw fail('LOCALAPPDATA_MISSING', '需要 Windows 原生环境的 LOCALAPPDATA。');
  const engine = new Engine({ host: info.host, stateDir, scriptPath: fileURLToPath(import.meta.url), nodePath: info.nodePath, codexPath: info.codexPath });
  let text;
  if (o['message-file']) {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(resolve(o['message-file']))).replace(/^\uFEFF/, ''); }
    catch { throw fail('MESSAGE_FILE', '消息文件不存在、不可读或不是 UTF-8。'); }
  }
  for (const key of ({ accept: ['pair', 'nonce'], confirm: ['pair', 'nonce'], reply: ['task', 'message-file'], send: ['message-file'], ack: ['task'] }[action] || [])) if (!o[key]) throw fail('USAGE', `缺少 --${key}。`);
  const result = action === 'activate' ? await engine.activate(o['allow-replies'] === true, o.peer)
    : action === 'list' ? await engine.list() : action === 'status' ? await engine.status() : action === 'off' ? await engine.off()
    : action === 'accept' ? await engine.accept(o.pair, o.nonce) : action === 'confirm' ? await engine.confirm(o.pair, o.nonce)
    : action === 'send' ? await engine.send(text, o.pair) : action === 'reply' ? await engine.reply(o.task, text) : await engine.ack(o.task);
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(JSON.stringify({ error: e.code && /^[A-Z_]+$/.test(e.code) ? e.code : 'LOCAL_ERROR', message: /^[A-Z_]+$/.test(e.code || '') ? e.message : '操作失败，请检查路径和本会话权限。' })); process.exitCode = 1; });
