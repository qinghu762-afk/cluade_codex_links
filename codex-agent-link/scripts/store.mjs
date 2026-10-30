import { mkdir, readFile, writeFile, rename, readdir, lstat, unlink, rmdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail, windowsVault } from './windows.mjs';

export const APP = 'claude-codex-agent-link';
export async function noLinks(path) {
  let current = resolve(path);
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw fail('UNSAFE_PATH', '路径不能包含符号链接或 junction。'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}
export class Store {
  constructor(root, vault = windowsVault) { this.root = resolve(root); this.vault = vault; }
  async init() {
    await noLinks(this.root); await mkdir(this.root, { recursive: true });
    const entries = await readdir(this.root);
    if (entries.length) {
      let marker;
      try { marker = JSON.parse(await readFile(join(this.root, 'owner.json'), 'utf8')); } catch {}
      if (marker?.appId !== APP) throw fail('STATE_CONFLICT', '运行目录不是本工具专用目录，未修改权限。');
    }
    await this.vault.secure(this.root);
    try { await writeFile(join(this.root, 'owner.json'), JSON.stringify({ appId: APP, schema: 2 }), { flag: 'wx' }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
    for (const name of ['sessions', 'pairs', 'tasks', 'messages']) { await noLinks(join(this.root, name)); await mkdir(join(this.root, name), { recursive: true }); }
  }
  path(bucket, id) {
    if (!['sessions', 'pairs', 'tasks', 'messages'].includes(bucket) || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw fail('BAD_ID', '记录标识无效。');
    return join(this.root, bucket, id + '.json');
  }
  async get(bucket, id) {
    const path = this.path(bucket, id); await noLinks(path);
    try { return JSON.parse(await readFile(path, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') throw fail('NOT_FOUND', '找不到本次联动记录，请先开启联动。'); throw fail('STATE_INVALID', '本地联动记录损坏。'); }
  }
  async list(bucket) {
    const dir = join(this.root, bucket); await noLinks(dir);
    let entries;
    try { entries = await readdir(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    return Promise.all(entries.filter(s => /^[a-zA-Z0-9-]+\.json$/.test(s)).map(s => this.get(bucket, s.slice(0, -5))));
  }
  async put(bucket, id, value) {
    const target = this.path(bucket, id); await noLinks(target);
    const temp = join(this.root, bucket, randomUUID() + '.tmp');
    try { await writeFile(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); await rename(temp, target); }
    finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async locked(work) {
    const path = join(this.root, 'transaction.lock');
    const deadline = Date.now() + 5000;
    while (true) {
      try { await mkdir(path); break; }
      catch (e) { if (e.code !== 'EEXIST') throw e; if (Date.now() >= deadline) throw fail('STATE_BUSY', '另一操作正在使用运行目录；未重试发送。如进程崩溃遗留锁，请先确认没有运行中的联动命令。'); await new Promise(r => setTimeout(r, 25)); }
    }
    try { return await work(); } finally { await rmdir(path); }
  }
}
