import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, stat, mkdir, chmod } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createInstanceConfigServer } from './instance-config-server.mjs';

const origin = 'https://canvas.example.test';
const config = { models: [], channels: [{ id: 'local', name: 'Local', models: [], apiKey: '', comfyuiProxyToken: '', workflows: [{ json: { node: { inputs: { prompt: 'retained' } } } }] }], apiKey: '' };
async function fixture(t, options = {}) {
    const dataDir = await mkdtemp(join(tmpdir(), 'instance-config-'));
    let server;
    async function start() {
        server = createInstanceConfigServer({ dataDir, origin, ...options });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        return `http://127.0.0.1:${server.address().port}/api/instance-config`;
    }
    async function stop() { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    let url = await start();
    t.after(async () => { await stop(); await chmod(dataDir, 0o700); await rm(dataDir, { recursive: true, force: true }); });
    return { dataDir, get url() { return url; }, get: (headers = {}) => fetch(url, { headers }), put: (body, headers = {}) => fetch(url, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Instance-Config': '1', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }), restart: async () => { await stop(); url = await start(); }, request: (path, opts) => fetch(new URL(path, url), opts) };
}

test('empty read, atomic persisted envelope, permissions and restart', async t => {
    const f = await fixture(t);
    const empty = await f.get();
    assert.equal(empty.status, 200);
    assert.equal(empty.headers.get('cache-control'), 'no-store');
    assert.equal(empty.headers.get('access-control-allow-origin'), null);
    assert.deepEqual(await empty.json(), { version: 1, revision: 0, config: null });
    const saved = await f.put({ baseRevision: 0, config });
    assert.equal(saved.status, 200);
    const envelope = { version: 1, revision: 1, config };
    assert.deepEqual(await saved.json(), envelope);
    assert.deepEqual(JSON.parse(await readFile(join(f.dataDir, 'instance-config.json'), 'utf8')), envelope);
    assert.equal((await stat(join(f.dataDir, 'instance-config.json'))).mode & 0o777, 0o600);
    await f.restart();
    assert.deepEqual(await (await f.get()).json(), envelope);
});

test('concurrent compare-and-swap allows exactly one update', async t => {
    const f = await fixture(t);
    const results = await Promise.all(Array.from({ length: 8 }, () => f.put({ baseRevision: 0, config })));
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409, 409, 409, 409, 409, 409, 409]);
    assert.equal((await f.put({ baseRevision: 1, config })).status, 200);
    assert.equal((await (await f.get()).json()).revision, 2);
});

test('invalid payloads and credentials are rejected', async t => {
    const f = await fixture(t);
    for (const bad of [null, [], {}, { ...config, channels: null }, { ...config, channels: [null] }, { ...config, channels: [{ id: 1, name: 'x', models: [] }] }, { ...config, channels: [{ id: 'x', name: 'x', models: null }] }, { ...config, channels: [{ id: 'x', name: 'x', models: [null] }] }, { ...config, apiKey: 'secret' }, { ...config, apiKey: null }, { ...config, webdav: {} }, ...['apiKey', 'comfyuiProxyToken'].flatMap(key => ['secret', false, 1, null, {}].map(value => ({ ...config, channels: [{ ...config.channels[0], [key]: value }] })))]) {
        assert.equal((await f.put({ baseRevision: 0, config: bad })).status, 400, JSON.stringify(bad));
    }
    for (const baseRevision of [-1, 0.5, '0', null, Number.MAX_SAFE_INTEGER + 1]) assert.equal((await f.put({ baseRevision, config })).status, 400);
    for (const body of ['{', 'null', '[]', '{}']) assert.equal((await f.put(body)).status, 400);
    assert.equal((await f.put({ baseRevision: 0, config })).status, 200);
});

test('top-level models must be a string array', async t => {
    const f = await fixture(t);
    for (const models of [undefined, null, {}, 'model', [null], [1], [{}]]) {
        assert.equal((await f.put({ baseRevision: 0, config: { ...config, models } })).status, 400);
    }
    assert.equal((await f.put({ baseRevision: 0, config: { ...config, models: ['model'] } })).status, 200);
});

test('oversized chunked uploads retain the saved revision and allow subsequent writes', async t => {
    const f = await fixture(t);
    assert.equal((await f.put({ baseRevision: 0, config })).status, 200);
    const status = await new Promise((resolve, reject) => {
        const req = httpRequest(f.url, { method: 'PUT', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Instance-Config': '1', 'Transfer-Encoding': 'chunked' } }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        assert.equal(req.hasHeader('Content-Length'), false);
        req.write('{"baseRevision":1,"config":{"models":[],"channels":[],"padding":"');
        for (let i = 0; i < 81; i++) req.write('x'.repeat(64 * 1024));
        req.end('"}}');
    });
    assert.equal(status, 413);
    assert.equal((await (await f.get()).json()).revision, 1);
    assert.equal(JSON.parse(await readFile(join(f.dataDir, 'instance-config.json'), 'utf8')).revision, 1);
    assert.equal((await f.put({ baseRevision: 1, config })).status, 200);
    assert.equal((await (await f.get()).json()).revision, 2);
});

test('CSRF boundary, fixed route and no CORS', async t => {
    const f = await fixture(t);
    for (const headers of [{ Origin: '' }, { Origin: 'https://evil.test' }, { Origin: `${origin}/` }, { 'X-Instance-Config': '' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await f.put({ baseRevision: 0, config }, headers)).status, 403);
    assert.equal((await f.put({ baseRevision: 0, config }, { 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await f.get({ Origin: 'https://evil.test' })).status, 403);
    assert.equal((await f.get({ 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await f.get({ Origin: origin })).status, 200);
    assert.equal((await f.request('/api/elsewhere')).status, 404);
    assert.equal((await f.request('/api/instance-config', { method: 'OPTIONS' })).status, 405);
    const noOrigin = await fixture(t, { origin: undefined });
    assert.equal((await noOrigin.put({ baseRevision: 0, config })).status, 403);
});

test('oversized requests rejected without persistence', async t => {
    const f = await fixture(t);
    assert.equal((await f.put({ baseRevision: 0, config: { ...config, padding: 'x'.repeat(5 * 1024 * 1024) } })).status, 413);
    assert.equal((await (await f.get()).json()).revision, 0);
});

test('corrupt and unsupported disk data are never overwritten', async t => {
    const f = await fixture(t);
    for (const raw of ['broken', JSON.stringify({ version: 2, revision: 1, config }), JSON.stringify({ version: 1, revision: 0, config }), JSON.stringify({ version: 1, revision: 1, config: null })]) {
        await writeFile(join(f.dataDir, 'instance-config.json'), raw);
        assert.equal((await f.get()).status, 500);
        assert.equal((await f.put({ baseRevision: 0, config })).status, 500);
        assert.equal(await readFile(join(f.dataDir, 'instance-config.json'), 'utf8'), raw);
    }
});

test('filesystem read errors do not become empty configuration', async t => {
    const f = await fixture(t);
    await mkdir(join(f.dataDir, 'instance-config.json'));
    assert.equal((await f.get()).status, 500);
    assert.equal((await f.put({ baseRevision: 0, config })).status, 500);
    assert.equal((await stat(join(f.dataDir, 'instance-config.json'))).isDirectory(), true);
});

test('failed writes retain the last good revision', { skip: process.getuid?.() === 0 }, async t => {
    const f = await fixture(t);
    assert.equal((await f.put({ baseRevision: 0, config })).status, 200);
    await chmod(f.dataDir, 0o500);
    assert.equal((await f.put({ baseRevision: 1, config: { ...config, changed: true } })).status, 500);
    assert.equal((await (await f.get()).json()).revision, 1);
    await chmod(f.dataDir, 0o700);
    assert.equal((await f.put({ baseRevision: 1, config })).status, 200);
});
