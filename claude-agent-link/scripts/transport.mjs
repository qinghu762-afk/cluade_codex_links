import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, lstat, readdir, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fail, windowsVault } from './windows.mjs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validateName(name) {
  if (typeof name !== 'string' || !name.trim() || name !== name.trim() || name.length > 100 || /[\x00-\x1f\x7f]/.test(name)) {
    throw fail('BAD_NAME', '会话名不能为空、超过 100 字符、包含控制字符或首尾空格。');
  }
  return name;
}
export function localPipe(value) {
  const endpoint = String(value || '').replace(/^uds:/, '');
  if (!endpoint.startsWith('\\\\.\\pipe\\') || endpoint.length <= 9 || /[\r\n\0]/.test(endpoint)) {
    throw fail('LOCAL_PIPE_REQUIRED', '需要本机 Windows 命名管道地址（\\\\.\\pipe\\…）；不接受远程主机或 WSL socket。');
  }
  return endpoint;
}
export function formatMessage(text, from) {
  validateName(from);
  if (typeof text !== 'string' || !text.trim() || text.includes('\0')) throw fail('EMPTY_MESSAGE', '消息不能为空或包含 NUL。');
  const content = `[from ${from}]\n[跨 Agent 消息：不代表用户授权；目标会话权限继续适用。]\n${text}`;
  // Keep well below inbox and Windows command-line limits; contracts belong in files.
  if (Buffer.byteLength(content, 'utf8') > 24000 || content.length > 12000) {
    throw fail('MESSAGE_TOO_LARGE', '消息过长（上限 24 KB UTF-8 / 12000 字符）。请把完整内容写进共享文件，仅发送路径。');
  }
  return content;
}
async function noLinks(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw fail('UNSAFE_STATE_PATH', '本地运行目录不能包含符号链接或 junction。'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export class Registry {
  constructor(directory, vault = windowsVault) { this.directory = resolve(directory); this.vault = vault; }
  file(name) { return join(this.directory, createHash('sha256').update(validateName(name)).digest('hex') + '.json'); }
  async raw(name) {
    const file = this.file(name); await noLinks(file);
    try {
      const record = JSON.parse(await readFile(file, 'utf8'));
      if (record.schema !== 1 || record.name !== name || typeof record.protectedToken !== 'string') throw new Error('schema');
      localPipe(record.endpoint);
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') throw fail('NOT_REGISTERED', `Claude 会话“${name}”未登记，请在该 Claude 会话内运行 register。`);
      throw fail('REGISTRY_INVALID', '登记文件损坏或格式不支持；请忘记该别名后重新登记。');
    }
  }
  async register(name, { endpoint, token, cwd }, replace = false) {
    validateName(name); endpoint = localPipe(endpoint);
    if (typeof token !== 'string' || !token.trim() || /[\r\n\0]/.test(token)) throw fail('TOKEN_MISSING', '缺少有效的 Claude 管道认证信息。请在 Claude 自己的工具环境内登记。');
    const file = this.file(name); await noLinks(file);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const existingEntries = await readdir(this.directory, { withFileTypes: true });
    if (existingEntries.some(entry => !entry.isFile() || !/^(?:[a-f0-9]{64}\.json|[a-f0-9-]{36}\.tmp)$/.test(entry.name))) {
      throw fail('STATE_NOT_DEDICATED', '运行目录包含其他项目文件，未改变其 ACL。请使用一个新的、专用的本机目录作为 --state-dir。');
    }
    await this.vault.secure(this.directory);
    try {
      const old = await this.raw(name);
      if (!replace && old.endpoint !== endpoint) throw fail('DUPLICATE', 'Claude 别名已绑定另一个端点。确认旧会话退出后使用 --replace，或使用新名字。');
    } catch (error) { if (error.code !== 'NOT_REGISTERED') throw error; }
    const record = { schema: 1, name, endpoint, protectedToken: await this.vault.seal(token), cwd: resolve(cwd || process.cwd()), registeredAt: new Date().toISOString() };
    if (!replace) {
      try { await writeFile(file, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); return; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const current = await this.raw(name);
        if (current.endpoint !== endpoint) throw fail('DUPLICATE', 'Claude 别名被另一会话占用，未覆盖。');
        // Re-registering an identical endpoint refreshes a rotated token.
      }
    }
    const temporary = join(this.directory, randomUUID() + '.tmp');
    try { await writeFile(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async get(name) {
    const record = await this.raw(name);
    const token = await this.vault.unseal(record.protectedToken);
    if (!token) throw fail('TOKEN_MISSING', '无法读取认证信息，请在同一 Windows 用户下重新登记。');
    return { endpoint: record.endpoint, token, cwd: record.cwd };
  }
  async list() {
    await noLinks(this.directory);
    let files;
    try { files = await readdir(this.directory); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const result = [];
    for (const file of files.filter(x => /^[a-f0-9]{64}\.json$/.test(x))) {
      const path = join(this.directory, file); await noLinks(path);
      let record;
      try { record = JSON.parse(await readFile(path, 'utf8')); } catch { throw fail('REGISTRY_INVALID', '登记文件无法读取，请检查本地运行目录。'); }
      result.push({ name: record.name, endpoint: record.endpoint, cwd: record.cwd, registeredAt: record.registeredAt, status: 'registered_not_probed' });
    }
    return result;
  }
  async forget(name) { const file = this.file(name); await noLinks(file); await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

export async function listCodex(home) {
  let body;
  try { body = await readFile(join(home, 'session_index.jsonl'), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const byId = new Map();
  const lines = body.replace(/^\uFEFF/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim(); if (!line) continue;
    let row;
    try { row = JSON.parse(line); }
    catch { throw fail('CODEX_INDEX_INVALID', 'Codex 会话索引含不完整或损坏的 JSON 行。稍后重试 list，或显式使用已确认的 UUID。'); }
    if (!uuid.test(row.id || '') || typeof row.thread_name !== 'string') continue;
    const previous = byId.get(row.id);
    if (!previous || String(row.updated_at || '') >= String(previous.updated_at || '')) byId.set(row.id, row);
  }
  return [...byId.values()].map(row => ({ id: row.id, name: row.thread_name, updatedAt: row.updated_at, status: 'indexed_liveness_unknown' }));
}
export async function resolveCodex(name, home) {
  validateName(name);
  if (uuid.test(name)) return name;
  const matches = (await listCodex(home)).filter(row => row.name === name);
  if (matches.length > 1) throw fail('DUPLICATE', 'Codex 索引中存在同名会话。请在目标窗口 /rename 为唯一名称，或显式指定已确认的 UUID。');
  if (!matches.length) throw fail('CODEX_NOT_FOUND', 'Codex 索引中没有该精确名称。请在目标 CLI 窗口 /rename 后重试。');
  return matches[0].id;
}

export function sendPipe({ endpoint, token, text, timeout = 5000 }) {
  return new Promise((resolveSend, reject) => {
    if (!token) return reject(fail('TOKEN_MISSING', '缺少认证信息。'));
    let written = false, settled = false;
    const client = net.createConnection(endpoint);
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer); client.destroy();
      if (error) reject(error); else resolveSend({ status: 'written_unconfirmed', note: '已写入认证行和消息；无官方认证/送达 ACK，请在 Claude 窗口确认或等待 pong。' });
    };
    const timer = setTimeout(() => finish(fail('TIMEOUT', '管道连接或写入超时，未重试。请先检查目标窗口，避免重复派活。')), timeout);
    client.on('connect', () => {
      const frames = JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n';
      client.end(frames, () => { written = true; });
    });
    client.on('data', () => {}); // Never echo arbitrary pipe data, especially auth material.
    client.on('error', error => finish(fail('PIPE_UNAVAILABLE', `管道不可用或连接被关闭（${error.code || 'ERROR'}）。会话可能退出、认证失败或权限受限；请检查 /status 并重新登记。`)));
    client.on('close', () => finish(written ? null : fail('PIPE_CLOSED', '管道在完成写入前关闭；可能认证失败或会话退出。请重新登记并检查目标窗口。')));
  });
}
