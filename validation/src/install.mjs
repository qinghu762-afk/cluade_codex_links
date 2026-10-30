import { readFile, writeFile, readdir, mkdir, rename, unlink, rmdir, lstat, access } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname, relative, sep, isAbsolute, extname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { APP, noLinks } from './store.mjs';
import { fail, findCommand } from './windows.mjs';

function destination(home, host) {
  if (!['claude', 'codex'].includes(host)) throw fail('BAD_HOST', '安装包宿主必须是 claude 或 codex。');
  return join(resolve(home), host === 'claude' ? '.claude' : '.agents', 'skills', 'agent-link');
}
function inside(root, file) {
  const result = resolve(root, file), rel = relative(resolve(root), result);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw fail('UNSAFE_PATH', '安装文件路径超出本工具目录。');
  return result;
}
async function files(root, prefix = '') {
  const result = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? prefix + '/' + item.name : item.name;
    if (item.isSymbolicLink()) throw fail('UNSAFE_PATH', '安装包不能包含符号链接。');
    if (item.isDirectory()) result.push(...await files(root, name));
    else if (item.isFile()) result.push(name);
    else throw fail('UNSAFE_PATH', '安装包包含非普通文件。');
  }
  return result.sort();
}
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function moveInstalledDirectory(from, to, move = rename) {
  await noLinks(from); await noLinks(to);
  for (let attempt = 0; ; attempt++) {
    try { return await move(from, to); }
    catch (error) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 4) throw error;
      // Windows scanners can briefly hold a newly written directory. Never delete
      // the existing skill to work around a sharing lock; retry the atomic move.
      await new Promise(r => setTimeout(r, 50 * 2 ** attempt));
    }
  }
}
async function ownership(target, host) {
  await noLinks(target);
  let info;
  try { info = JSON.parse(await readFile(join(target, 'installation.json'), 'utf8')); }
  catch { throw fail('INSTALL_CONFLICT', '目标已有其他同名 skill，未覆盖。请先检查 agent-link 目录。'); }
  if (info.appId !== APP || info.host !== host || !info.files || typeof info.files !== 'object') throw fail('INSTALL_CONFLICT', '同名 skill 不属于本安装器，未修改。');
  const actual = await files(target), expected = Object.keys(info.files).concat('installation.json').sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw fail('UNMANAGED_FILES', '安装目录含新增或缺失文件，已停止升级/卸载以保留你的文件。');
  for (const [file, hash] of Object.entries(info.files)) {
    if (digest(await readFile(inside(target, file))) !== hash) throw fail('UNMANAGED_CHANGES', '已安装文件被手动修改，已停止升级/卸载。请先备份并确认这些改动。');
  }
  return info;
}
export async function discoverCodex() {
  let candidate;
  try { candidate = findCommand('codex'); } catch {}
  if (candidate && extname(candidate).toLowerCase() === '.exe') return candidate;
  const roots = [candidate && dirname(candidate), dirname(process.execPath)].filter(Boolean);
  for (const root of roots) {
    const entry = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    try { await access(entry); return entry; } catch {}
  }
  throw fail('CODEX_MISSING', '未找到可安全调用的 Codex .exe 或官方 codex.js，请先安装并登录 Codex CLI，再重新安装 skill。');
}
export async function install({ source, home = homedir(), nodePath = process.execPath, codexPath } = {}) {
  source = resolve(source); await noLinks(source);
  const manifest = JSON.parse(await readFile(join(source, 'package-manifest.json'), 'utf8'));
  if (manifest.appId !== APP || typeof manifest.version !== 'string') throw fail('INVALID_PACKAGE', '不是有效的 Agent Link 安装包。');
  const target = destination(home, manifest.host); await noLinks(target);
  if (source === target) throw fail('ALREADY_INSTALLED', '这是已安装目录；升级请从新下载的安装包运行安装器。');
  if (Number(process.versions.node.split('.')[0]) < 22) throw fail('NODE_VERSION', '需要 Node.js 22 或更新版本。');
  codexPath ||= await discoverCodex();
  if (!isAbsolute(nodePath) || !isAbsolute(codexPath)) throw fail('ABSOLUTE_REQUIRED', 'Node 和 Codex 入口必须是绝对路径。');
  await access(nodePath); await access(codexPath);
  let previous;
  try { await lstat(target); previous = await ownership(target, manifest.host); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
  const packageFiles = (await files(source)).filter(name => name !== 'installation.json');
  if (!packageFiles.includes('SKILL.md') || !packageFiles.includes('scripts/agent-link.mjs')) throw fail('INVALID_PACKAGE', '安装包缺少 skill 或运行脚本。');
  const parent = dirname(target); await noLinks(parent); await mkdir(parent, { recursive: true });
  const stage = inside(parent, '.agent-link-stage-' + randomUUID()); await mkdir(stage);
  const hashes = {};
  for (const file of packageFiles) {
    const bytes = await readFile(inside(source, file));
    const path = inside(stage, file); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' }); hashes[file] = digest(bytes);
  }
  const info = { appId: APP, schema: 2, version: manifest.version, host: manifest.host, nodePath: resolve(nodePath), codexPath: resolve(codexPath), installedAt: new Date().toISOString(), files: hashes };
  await writeFile(join(stage, 'installation.json'), JSON.stringify(info, null, 2), { flag: 'wx' });
  let backup;
  if (previous) { backup = inside(parent, '.agent-link-backup-' + randomUUID()); await moveInstalledDirectory(target, backup); }
  try { await moveInstalledDirectory(stage, target); }
  catch (e) { if (backup) await moveInstalledDirectory(backup, target); throw e; }
  return { status: previous ? 'upgraded' : 'installed', host: manifest.host, destination: target, backup: backup || null,
    next: '当前对话请直接读取已安装 SKILL.md；用户触发开启联动后，在本会话工具环境实际执行 activate --allow-replies。技能发现未刷新时重开一次。' };
}
export async function uninstall({ home = homedir(), host }) {
  const target = destination(home, host); const info = await ownership(target, host);
  for (const file of Object.keys(info.files)) { const path = inside(target, file); await noLinks(path); await unlink(path); }
  await unlink(join(target, 'installation.json'));
  const dirs = [...new Set(Object.keys(info.files).map(f => dirname(f)).filter(f => f !== '.').flatMap(f => {
    const pieces = f.split(/[\\/]/); return pieces.map((_, i) => pieces.slice(0, i + 1).join('/'));
  }))].sort((a, b) => b.length - a.length);
  for (const dir of dirs) await rmdir(inside(target, dir));
  await rmdir(target);
  return { status: 'uninstalled', host, note: '只移除当前宿主安装的本工具文件；另一端 skill、版本备份和私有运行记录保留。' };
}
async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { home: { type: 'string' } } });
  const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const manifest = JSON.parse(await readFile(join(source, 'package-manifest.json'), 'utf8'));
  const result = positionals[0] === 'uninstall'
    ? await uninstall({ home: values.home || homedir(), host: manifest.host })
    : positionals.length ? (() => { throw fail('USAGE', '安装器只接受 install（省略）或 uninstall。'); })()
    : await install({ source, home: values.home || homedir() });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(e => { console.error(JSON.stringify({ error: e.code || 'INSTALL_ERROR', message: e.message })); process.exitCode = 1; });
