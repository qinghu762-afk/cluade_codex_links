import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const base = fileURLToPath(new URL('../fixtures/', import.meta.url));
const runtime = new URL('../src/engine.mjs', import.meta.url);
const installModule = new URL('../src/install.mjs', import.meta.url);
const ids = { one: '11111111-1111-4111-8111-111111111111', two: '22222222-2222-4222-8222-222222222222' };
async function temporary(t) { await mkdir(base, { recursive: true }); const dir = await mkdtemp(join(base, 'case-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const vault = { secure: async () => {}, seal: async s => 'encrypted:' + Buffer.from(s).toString('base64'), unseal: async s => Buffer.from(s.slice(10), 'base64').toString() };

async function setup(t) {
  const dir = await temporary(t), { Engine } = await import(runtime);
  const messages = [], workers = new Map();
  const options = { stateDir: join(dir, 'state'), vault, transport: async (recipient, message) => {
    messages.push({ recipient, message });
    return { status: recipient.host === 'claude' ? 'written_unconfirmed' : 'queued_unconfirmed' };
  } };
  const claudeEnv = { CLAUDE_CODE_MESSAGING_SOCKET: '\\\\.\\pipe\\synthetic-' + crypto.randomUUID(), CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic-token' };
  const codexEnv = { CODEX_THREAD_ID: ids.one };
  const make = (host, env, extra = {}) => new Engine({ ...options, host, env, cwd: dir, scriptPath: join(dir, host, 'scripts', 'agent-link.mjs'), nodePath: process.execPath, ...extra });
  const claude = make('claude', claudeEnv), codex = make('codex', codexEnv);
  return { dir, options, messages, claude, codex, make, claudeEnv, codexEnv };
}
async function handshake(ctx, first, second) {
  assert.equal((await first.activate(true)).status, 'waiting_for_peer');
  const initiated = await second.activate(true);
  assert.equal(initiated.status, 'handshake_pending');
  let frame = ctx.messages.at(-1).message;
  assert.equal(frame.kind, 'hello');
  await first.accept(frame.pairId, frame.nonce);
  frame = ctx.messages.at(-1).message;
  assert.equal(frame.kind, 'pong');
  await second.confirm(frame.pairId, frame.nonce);
  assert.equal((await first.status()).pairs[0].status, 'ready');
  return initiated.pairId;
}

test('activation requires own identity and explicit local reply consent', async t => {
  const ctx = await setup(t);
  await assert.rejects(ctx.make('codex', {}).activate(true), { code: 'IDENTITY_MISSING' });
  await assert.rejects(ctx.make('claude', {}).activate(true), { code: 'IDENTITY_MISSING' });
  await assert.rejects(ctx.codex.activate(false), { code: 'LOCAL_CONSENT_REQUIRED' });
  assert.equal(ctx.messages.length, 0);
});
for (const order of ['claude-first', 'codex-first']) test(`${order}: registration, nonce handshake, task execution and reply acknowledgment`, async t => {
  const ctx = await setup(t), [first, second] = order === 'claude-first' ? [ctx.claude, ctx.codex] : [ctx.codex, ctx.claude];
  const pairId = await handshake(ctx, first, second);
  const sent = await ctx.claude.send('执行中文任务\n第二行 & %PATH%', pairId);
  const task = ctx.messages.at(-1).message;
  assert.equal(task.kind, 'task'); assert.equal(task.text, '执行中文任务\n第二行 & %PATH%');
  assert.ok(task.command.startsWith('& ')); assert.ok(task.command.includes(process.execPath));
  assert.ok(task.command.includes('reply'));
  assert.ok(!JSON.stringify(task).includes('synthetic-token'));
  await ctx.codex.reply(sent.taskId, '执行完成：报告路径包含 空格.md');
  const reply = ctx.messages.at(-1).message;
  assert.equal(reply.kind, 'result'); assert.ok(reply.text.includes('报告路径包含 空格.md'));
  assert.equal((await ctx.claude.status()).tasks[0].status, 'reply_submitted_unconfirmed');
  await ctx.claude.ack(sent.taskId);
  assert.equal((await ctx.claude.status()).tasks[0].status, 'received');
});

test('multiple candidates require selection and wrong nonce cannot mark a pair ready', async t => {
  const ctx = await setup(t);
  await ctx.codex.activate(true);
  const secondCodex = ctx.make('codex', { CODEX_THREAD_ID: ids.two }); await secondCodex.activate(true);
  const result = await ctx.claude.activate(true);
  assert.equal(result.status, 'choose_peer'); assert.equal(result.candidates.length, 2);
  assert.equal(ctx.messages.length, 0);
  const chosen = await ctx.claude.activate(true, result.candidates[0].id);
  await assert.rejects(ctx.claude.confirm(chosen.pairId, 'wrong'), { code: 'HANDSHAKE_MISMATCH' });
  assert.notEqual((await ctx.claude.status()).pairs[0].status, 'ready');
});

test('refreshing the same session does not duplicate it; stale entries and off are not candidates', async t => {
  const ctx = await setup(t);
  await ctx.codex.activate(true); await ctx.codex.activate(true);
  assert.equal((await ctx.claude.list()).length, 1);
  await ctx.codex.off();
  assert.equal((await ctx.claude.activate(true)).status, 'waiting_for_peer');
});

test('callbacks are unique and cannot be executed as another session', async t => {
  const ctx = await setup(t); const pairId = await handshake(ctx, ctx.claude, ctx.codex);
  const a = await ctx.claude.send('first', pairId), b = await ctx.claude.send('second', pairId);
  assert.notEqual(a.taskId, b.taskId);
  const wrong = ctx.make('codex', { CODEX_THREAD_ID: ids.two });
  await assert.rejects(wrong.reply(a.taskId, 'wrong'), { code: 'WRONG_SESSION' });
  await assert.rejects(ctx.claude.ack(a.taskId), { code: 'NO_REPLY' });
  await ctx.codex.reply(a.taskId, 'ok');
  await assert.rejects(ctx.codex.reply(a.taskId, 'duplicate'), { code: 'ALREADY_REPLIED' });
});

test('send errors are recorded and never silently retried or treated as delivered', async t => {
  const ctx = await setup(t); const pairId = await handshake(ctx, ctx.claude, ctx.codex);
  let count = 0;
  const broken = ctx.make('claude', ctx.claudeEnv, { transport: async () => { count++; throw Object.assign(new Error('timeout'), { code: 'TIMEOUT' }); } });
  await assert.rejects(broken.send('once', pairId), { code: 'TIMEOUT' });
  assert.equal(count, 1); assert.equal((await ctx.claude.status()).tasks[0].status, 'send_failed');
});

test('installer installs each role in isolated homes, upgrades own files and refuses unrelated skills', async t => {
  const dir = await temporary(t), { install, uninstall } = await import(installModule);
  const source = join(dir, 'package'), home = join(dir, 'other-profile');
  await mkdir(join(source, 'scripts'), { recursive: true });
  await writeFile(join(source, 'SKILL.md'), 'fixture skill');
  await writeFile(join(source, 'scripts', 'agent-link.mjs'), "console.log('fixture')");
  await writeFile(join(source, 'package-manifest.json'), JSON.stringify({ appId: 'claude-codex-agent-link', version: '2.0.0', host: 'codex' }));
  const first = await install({ source, home, nodePath: process.execPath, codexPath: process.execPath });
  assert.equal(first.destination, join(home, '.agents', 'skills', 'agent-link'));
  const metadata = JSON.parse(await readFile(join(first.destination, 'installation.json'), 'utf8'));
  assert.equal(metadata.nodePath, process.execPath); assert.equal(metadata.host, 'codex');
  await writeFile(join(source, 'SKILL.md'), 'updated');
  await install({ source, home, nodePath: process.execPath, codexPath: process.execPath });
  assert.equal(await readFile(join(first.destination, 'SKILL.md'), 'utf8'), 'updated');
  await writeFile(join(first.destination, 'my-notes.txt'), 'preserve');
  await assert.rejects(uninstall({ home, host: 'codex' }), { code: 'UNMANAGED_FILES' });
  await rm(join(first.destination, 'my-notes.txt'));
  await uninstall({ home, host: 'codex' });
  await assert.rejects(readFile(join(first.destination, 'SKILL.md')), { code: 'ENOENT' });
  await mkdir(first.destination, { recursive: true }); await writeFile(join(first.destination, 'SKILL.md'), 'unrelated');
  await assert.rejects(install({ source, home, nodePath: process.execPath, codexPath: process.execPath }), { code: 'INSTALL_CONFLICT' });
});

test('fast automatic peer processing cannot overwrite an already acknowledged reply', async t => {
  const ctx = await setup(t);
  const pairId = await handshake(ctx, ctx.claude, ctx.codex);
  ctx.claude.transport = async (_recipient, message) => {
    assert.equal(message.kind, 'task');
    await ctx.codex.reply(message.taskId, 'automatic result');
    await ctx.claude.ack(message.taskId);
    return { status: 'queued_unconfirmed' };
  };
  await ctx.claude.send('execute', pairId);
  assert.equal((await ctx.claude.status()).tasks[0].status, 'received');
});

test('concurrent activation creates one pair and stale registration is excluded', async t => {
  const ctx = await setup(t);
  await Promise.all([ctx.codex.activate(true), ctx.claude.activate(true)]);
  assert.equal((await ctx.codex.status()).pairs.length, 1);
  const old = await ctx.codex.store.get('sessions', ids.one);
  old.updatedAt = '2000-01-01T00:00:00.000Z'; await ctx.codex.store.put('sessions', ids.one, old);
  assert.equal((await ctx.claude.list()).some(s => s.id === ids.one), false);
});

test('private state refuses an unrelated directory without changing its contents', async t => {
  const ctx = await setup(t); const dir = join(ctx.dir, 'unrelated'); await mkdir(dir);
  await writeFile(join(dir, 'keep.txt'), 'keep');
  const rogue = ctx.make('codex', ctx.codexEnv, { stateDir: dir });
  await assert.rejects(rogue.activate(true), { code: 'STATE_CONFLICT' });
  assert.deepEqual(await readdir(dir), ['keep.txt']);
});

test('expired peers cannot receive new tasks from an old ready pair', async t => {
  const ctx = await setup(t); const pairId = await handshake(ctx, ctx.claude, ctx.codex);
  const old = await ctx.codex.store.get('sessions', ids.one); old.updatedAt = '2000-01-01T00:00:00Z'; await ctx.codex.store.put('sessions', ids.one, old);
  const count = ctx.messages.length;
  await assert.rejects(ctx.claude.send('do not dispatch', pairId), { code: 'PEER_INACTIVE' });
  assert.equal(ctx.messages.length, count);
});

test('ack arriving while reply completion reads state cannot be downgraded', async t => {
  const ctx = await setup(t); const pairId = await handshake(ctx, ctx.claude, ctx.codex);
  const sent = await ctx.claude.send('task', pairId);
  let afterTransport = false, injected = false, acknowledgment;
  ctx.codex.transport = async () => { afterTransport = true; return { status: 'written_unconfirmed' }; };
  const original = ctx.codex.store.get.bind(ctx.codex.store);
  ctx.codex.store.get = async (bucket, id) => {
    const snapshot = await original(bucket, id);
    if (afterTransport && !injected && bucket === 'tasks' && id === sent.taskId) {
      injected = true; acknowledgment = ctx.claude.ack(sent.taskId);
      // Model an ack racing a slow disk read; respect a transaction already held.
      await Promise.race([acknowledgment, new Promise(r => setTimeout(r, 80))]);
    }
    return snapshot;
  };
  await ctx.codex.reply(sent.taskId, 'result'); await acknowledgment;
  assert.equal((await ctx.claude.status()).tasks[0].status, 'received');
});

test('off racing confirmation leaves the pair closed, never resurrected', async t => {
  const ctx = await setup(t); await ctx.claude.activate(true); const started = await ctx.codex.activate(true);
  const hello = ctx.messages.at(-1).message; await ctx.claude.accept(started.pairId, hello.nonce);
  const claudeId = ctx.claude.identity().id;
  const original = ctx.codex.store.get.bind(ctx.codex.store); let injected = false, shutdown;
  ctx.codex.store.get = async (bucket, id) => {
    const snapshot = await original(bucket, id);
    if (!injected && bucket === 'sessions' && id === claudeId) {
      injected = true; shutdown = ctx.claude.off();
      await Promise.race([shutdown, new Promise(r => setTimeout(r, 80))]);
    }
    return snapshot;
  };
  await ctx.codex.confirm(started.pairId, hello.nonce); await shutdown;
  assert.equal((await ctx.codex.status()).pairs[0].status, 'closed');
});

test('a delayed result can be acknowledged after a reply transport timeout', async t => {
  const ctx = await setup(t); const pairId = await handshake(ctx, ctx.claude, ctx.codex);
  const sent = await ctx.claude.send('task', pairId);
  ctx.codex.transport = async () => { throw Object.assign(new Error('uncertain delivery'), { code: 'TIMEOUT' }); };
  await assert.rejects(ctx.codex.reply(sent.taskId, 'late result'), { code: 'TIMEOUT' });
  assert.equal((await ctx.claude.status()).tasks[0].status, 'reply_failed');
  await ctx.claude.ack(sent.taskId);
  assert.equal((await ctx.claude.status()).tasks[0].status, 'received');
});

test('installer tolerates brief Windows directory locks without deleting either directory', async t => {
  const dir = await temporary(t), from = join(dir, 'stage'), to = join(dir, 'installed');
  await mkdir(from); await writeFile(join(from, 'content.txt'), 'preserved');
  const { rename } = await import('node:fs/promises');
  const { moveInstalledDirectory } = await import(installModule);
  let calls = 0;
  await moveInstalledDirectory(from, to, async (...args) => { if (++calls < 3) throw Object.assign(new Error('temporary sharing lock'), { code: 'EPERM' }); return rename(...args); });
  assert.equal(calls, 3); assert.equal(await readFile(join(to, 'content.txt'), 'utf8'), 'preserved');
});

test('persistent Windows directory locks fail boundedly and preserve staged files', async t => {
  const dir = await temporary(t), from = join(dir, 'stage'), to = join(dir, 'installed');
  await mkdir(from); await writeFile(join(from, 'content.txt'), 'preserved');
  const { moveInstalledDirectory } = await import(installModule); let calls = 0;
  await assert.rejects(moveInstalledDirectory(from, to, async () => { calls++; throw Object.assign(new Error('still locked'), { code: 'EPERM' }); }), { code: 'EPERM' });
  assert.equal(calls, 5); assert.equal(await readFile(join(from, 'content.txt'), 'utf8'), 'preserved');
});
