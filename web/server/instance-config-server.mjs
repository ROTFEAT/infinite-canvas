import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 5 * 1024 * 1024;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRevision = value => Number.isSafeInteger(value) && value >= 0;
const emptyCredential = (value, key) => !Object.hasOwn(value, key) || value[key] === '';

function validConfig(config) {
    return isObject(config) && !Object.hasOwn(config, 'webdav') && emptyCredential(config, 'apiKey') &&
        Array.isArray(config.models) && config.models.every(model => typeof model === 'string') &&
        Array.isArray(config.channels) && config.channels.every(channel =>
            isObject(channel) && typeof channel.id === 'string' && typeof channel.name === 'string' &&
            emptyCredential(channel, 'apiKey') && emptyCredential(channel, 'comfyuiProxyToken') &&
            Array.isArray(channel.models) && channel.models.every(model =>
                isObject(model) && typeof model.name === 'string' && typeof model.capability === 'string'));
}

function httpError(status, message) { return Object.assign(new Error(message), { status }); }

async function readBody(req) {
    if (Number(req.headers['content-length']) > MAX_BYTES) {
        req.resume();
        throw httpError(413, 'Configuration exceeds 5 MiB');
    }
    // Drain excess bytes without retaining them; preserve the socket long enough to return 413.
    return new Promise((resolveBody, reject) => {
        let size = 0;
        let chunks = [];
        req.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_BYTES) {
                chunks = [];
                reject(httpError(413, 'Configuration exceeds 5 MiB'));
            } else chunks.push(chunk);
        });
        req.on('error', () => reject(httpError(400, 'Incomplete request')));
        req.on('end', () => {
            if (size > MAX_BYTES) return;
            try { resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
            catch { reject(httpError(400, 'Invalid JSON')); }
        });
    });
}

// Origin checking is a browser CSRF boundary, not authentication. Run behind trusted network access.
// Only one service process may own this data directory; the queue is process-local.
export function createInstanceConfigServer({ dataDir, origin } = {}) {
    const directory = resolve(dataDir ?? './data');
    const file = join(directory, 'instance-config.json');
    let writes = Promise.resolve();

    async function read() {
        let raw;
        try { raw = await readFile(file, 'utf8'); }
        catch (error) {
            if (error.code === 'ENOENT') return { version: 1, revision: 0, config: null };
            throw error;
        }
        const envelope = JSON.parse(raw);
        if (!isObject(envelope) || envelope.version !== 1 || !isRevision(envelope.revision) || envelope.revision === 0 || !validConfig(envelope.config)) {
            throw new Error('Invalid stored configuration');
        }
        return envelope;
    }

    async function update(body) {
        const current = await read();
        if (body.baseRevision !== current.revision) throw httpError(409, 'Configuration revision conflict');
        if (current.revision === Number.MAX_SAFE_INTEGER) throw new Error('Revision exhausted');
        const envelope = { version: 1, revision: current.revision + 1, config: body.config };
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const temporary = join(directory, `.instance-config-${randomUUID()}.tmp`);
        try {
            await writeFile(temporary, JSON.stringify(envelope), { mode: 0o600, flag: 'wx' });
            await rename(temporary, file);
        } finally {
            await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
        }
        return envelope;
    }

    return createServer(async (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        try {
            if (req.url !== '/api/instance-config') throw httpError(404, 'Not found');
            if (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin !== undefined && req.headers.origin !== origin)) throw httpError(403, 'Origin not allowed');
            let envelope;
            if (req.method === 'GET') envelope = await read();
            else if (req.method === 'PUT') {
                if (!origin || req.headers.origin !== origin || req.headers['x-instance-config'] !== '1') throw httpError(403, 'Write origin and intent required');
                if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw httpError(415, 'JSON content type required');
                const body = await readBody(req);
                if (!isObject(body) || !isRevision(body.baseRevision) || !validConfig(body.config)) throw httpError(400, 'Invalid configuration or credentials present');
                const pending = writes.then(() => update(body));
                writes = pending.catch(() => {});
                envelope = await pending;
            } else {
                res.setHeader('Allow', 'GET, PUT');
                throw httpError(405, 'Method not allowed');
            }
            res.end(JSON.stringify(envelope));
        } catch (error) {
            // Do not expose disk paths, supplied configuration, or credentials in errors/logs.
            res.statusCode = error.status ?? 500;
            res.end(JSON.stringify({ error: error.status ? error.message : 'Configuration storage unavailable' }));
            req.resume();
        }
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const server = createInstanceConfigServer({ dataDir: process.env.CONFIG_DATA_DIR, origin: process.env.INSTANCE_CONFIG_ORIGIN });
    server.listen(Number(process.env.CONFIG_PORT ?? 3003), process.env.CONFIG_HOST ?? '127.0.0.1');
}
