import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, appendFile, readdir, rm, access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { install } from '../src/install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const packages = process.env.AGENT_LINK_PACKAGE_ROOT || [resolve(root, '..'), resolve(root, '../../outputs/agent-link-skills')].find(p => existsSync(join(p, 'claude-agent-link', 'package-manifest.json')));
async function temp(t) {
  const base = join(root, 'fixtures'); await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'native-'));
  const cleanup = { before: async () => {} };
  // On Windows, never remove a fixture cwd while a worker process still uses it.
  // Keep one teardown hook so a failed early rm cannot skip server/timer cleanup.
  t.after(async () => { await cleanup.before(); await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { dir, cleanup };
}
function child(file, args, env, cwd) {
  return new Promise((res, rej) => {
    const processChild = spawn(process.execPath, [file, ...args], { env: { ...process.env, ...env }, cwd, windowsHide: true });
    let stdout = '', stderr = ''; const timer = setTimeout(() => { processChild.kill(); rej(new Error('fixture timeout')); }, 30000);
    processChild.stdout.setEncoding('utf8').on('data', s => stdout += s); processChild.stderr.setEncoding('utf8').on('data', s => stderr += s);
    processChild.on('error', e => { clearTimeout(timer); rej(e); });
    processChild.on('close', code => { clearTimeout(timer); res({ code, stdout, stderr }); });
  });
}
async function until(check, errors) {
  const untilTime = Date.now() + 45000;
  while (Date.now() < untilTime) {
    if (errors.length) throw errors[0];
    if (await check()) return;
    await new Promise(r => setTimeout(r, 80));
  }
  throw new Error('control workers did not close the loop within 45s');
}

for (const first of ['claude', 'codex']) test(`Windows isolated install + ${first}-first full callback loop, arbitrary cwd and empty PATH`, { skip: process.platform !== 'win32' }, async t => {
  const { dir, cleanup } = await temp(t), profile = join(dir, '模拟 用户 profile'), state = join(dir, 'private state'), cwd = join(dir, 'unrelated project');
  await mkdir(cwd); const queue = join(dir, 'codex-queue.jsonl'); await writeFile(queue, '');
  const fake = join(dir, 'codex fixture.mjs');
  await writeFile(fake, "import{appendFileSync}from'node:fs';const a=process.argv.slice(2);if(a[0]!=='queue'||a[1]!=='--thread'||a[3]!=='--message')process.exit(2);appendFileSync(process.env.LINK_TEST_QUEUE,JSON.stringify({thread:a[2],wire:a[4]})+'\\n');console.log('queued');");
  const installs = {};
  for (const host of ['claude', 'codex']) installs[host] = await install({ source: join(packages, host + '-agent-link'), home: profile, codexPath: fake });
  const endpoint = `\\\\.\\pipe\\agent-link-v2-test-${crypto.randomUUID()}`;
  const environments = {
    claude: { CLAUDE_CODE_MESSAGING_SOCKET: endpoint, CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic-' + crypto.randomUUID(), PATH: '', LINK_TEST_QUEUE: queue },
    codex: { CODEX_THREAD_ID: '33333333-3333-4333-8333-333333333333', PATH: '', LINK_TEST_QUEUE: queue },
  };
  const run = async (host, args) => {
    const result = await child(join(installs[host].destination, 'scripts', 'agent-link.mjs'), [...args, '--state-dir', state], environments[host], cwd);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const events = [], errors = [], pending = new Set();
  async function dispatch(host, wire) {
    const line = wire.split('\n').find(l => l.startsWith('AGENT_LINK_V2 ')); assert.ok(line);
    const message = JSON.parse(line.slice('AGENT_LINK_V2 '.length)); events.push({ host, kind: message.kind });
    if (message.kind === 'hello') await run(host, ['accept', '--pair', message.pairId, '--nonce', message.nonce]);
    else if (message.kind === 'pong') await run(host, ['confirm', '--pair', message.pairId, '--nonce', message.nonce]);
    else if (message.kind === 'task') {
      // Deterministic worker stands in for a model; real installed CLI performs reply.
      await writeFile(message.resultFile, '实际任务结果：中文\n第二行 & %PATH%', 'utf8');
      await run(host, ['reply', '--task', message.taskId, '--message-file', message.resultFile]);
    } else if (message.kind === 'result') await run(host, ['ack', '--task', message.taskId]);
  }
  function schedule(host, wire) { const promise = dispatch(host, wire).catch(e => errors.push(e)).finally(() => pending.delete(promise)); pending.add(promise); }
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setEncoding('utf8');
    let text = '', handled = false;
    socket.on('data', piece => {
      text += piece; const lines = text.split('\n');
      if (lines.length >= 3 && !handled) {
        handled = true;
        try { const auth = JSON.parse(lines[0]), frame = JSON.parse(lines[1]); assert.equal(auth.token, environments.claude.CLAUDE_CODE_MESSAGING_TOKEN); schedule('claude', frame.message.content); }
        catch (e) { errors.push(e); }
        socket.end();
      }
    });
  });
  await new Promise((res, rej) => { server.once('error', rej); server.listen(endpoint, res); });
  let offset = 0, polling = false;
  const timer = setInterval(async () => {
    if (polling) return; polling = true;
    try {
      const lines = (await readFile(queue, 'utf8')).split('\n').filter(Boolean);
      while (offset < lines.length) { const item = JSON.parse(lines[offset++]); assert.equal(item.thread, environments.codex.CODEX_THREAD_ID); schedule('codex', item.wire); }
    } catch (e) { errors.push(e); } finally { polling = false; }
  }, 50);
  cleanup.before = async () => {
    clearInterval(timer);
    while (polling) await new Promise(r => setTimeout(r, 20));
    while (pending.size) await Promise.allSettled([...pending]);
    for (const socket of sockets) socket.destroy();
    await new Promise(res => server.close(res));
  };
  assert.equal((await run(first, ['activate', '--allow-replies'])).status, 'waiting_for_peer');
  const other = first === 'claude' ? 'codex' : 'claude';
  const activated = await run(other, ['activate', '--allow-replies']);
  await until(async () => {
    try { return JSON.parse(await readFile(join(state, 'pairs', activated.pairId + '.json'), 'utf8')).status === 'ready'; } catch { return false; }
  }, errors);
  const message = join(cwd, '任务 输入.txt'); await writeFile(message, '\uFEFF完成测试任务，不调用模型。');
  const sent = await run('claude', ['send', '--message-file', message]);
  await until(async () => JSON.parse(await readFile(join(state, 'tasks', sent.taskId + '.json'), 'utf8')).status === 'received', errors);
  assert.ok(events.some(e => e.kind === 'hello')); assert.ok(events.some(e => e.kind === 'pong')); assert.ok(events.some(e => e.kind === 'task')); assert.ok(events.some(e => e.kind === 'result'));
  const saved = (await Promise.all((await readdir(join(state, 'sessions'))).filter(f => f.endsWith('.json')).map(f => readFile(join(state, 'sessions', f), 'utf8')))).join('\n');
  assert.ok(!saved.includes(environments.claude.CLAUDE_CODE_MESSAGING_TOKEN));
  assert.ok(!saved.includes('"token"'));
  assert.equal(errors.length, 0);
});

test('the shipped installer CLI detects local tools and installs into a separate profile', async t => {
  const { dir } = await temp(t), home = join(dir, 'fresh-home');
  const result = await child(join(packages, 'codex-agent-link', 'scripts', 'install.mjs'), ['--home', home], {}, dir);
  assert.equal(result.code, 0, result.stderr);
  const installed = JSON.parse(result.stdout);
  const info = JSON.parse(await readFile(join(installed.destination, 'installation.json'), 'utf8'));
  assert.equal(info.nodePath, process.execPath); await access(info.codexPath);
});
