import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const ACTIVE = ["queued", "dispatching", "running"];
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const validId = (id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
export async function createGenerationQueue({ dbPath, workers: configs, allowedOrigin, pollMs = 2000, publicPrefix = "/api/generation", requestTimeoutMs = 10000 }) {
    if (!allowedOrigin || new URL(allowedOrigin).origin !== allowedOrigin) throw Error("GENERATION_ALLOWED_ORIGIN must be an exact origin");
    if (!configs?.length || configs.some((w) => !validId(w.id) || !["http:", "https:"].includes(new URL(w.url).protocol))) throw Error("Invalid fixed workers");
    if (new Set(configs.map((w) => w.id)).size !== configs.length) throw Error("Duplicate worker IDs");
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,status TEXT NOT NULL,workerId TEXT,createdAt INTEGER NOT NULL,updatedAt INTEGER NOT NULL,workflow TEXT NOT NULL,clientId TEXT,error TEXT,progress TEXT,history TEXT,retryOf TEXT,cancelRequested INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status,createdAt); CREATE UNIQUE INDEX IF NOT EXISTS jobs_retry ON jobs(retryOf) WHERE retryOf IS NOT NULL;`,
    );
    const workers = configs.map((w) => ({ ...w, online: false, busy: false, clientId: `generation-queue-${w.id}`, socket: null }));
    let closed = false,
        working = null,
        serial = Promise.resolve(),
        timer;
    const lock = (fn) => {
        const result = serial.then(fn);
        serial = result.catch(() => {});
        return result;
    };
    const get = (id) => db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    const active = () => db.prepare("SELECT * FROM jobs WHERE status IN ('queued','dispatching','running') ORDER BY createdAt,rowid").all();
    const update = (id, fields) => {
        db.prepare(
            `UPDATE jobs SET ${Object.keys(fields)
                .map((k) => `${k}=?`)
                .join(",")},updatedAt=? WHERE id=?`,
        ).run(...Object.values(fields), Date.now(), id);
    };
    const clients = new WebSocketServer({ noServer: true });
    const broadcast = (message, clientId) => {
        for (const socket of clients.clients) if (socket.readyState === WebSocket.OPEN && (!clientId || socket.clientId === clientId)) socket.send(JSON.stringify(message));
    };
    const queueStatus = () => ({ type: "status", data: { status: { exec_info: { queue_remaining: active().length } } } });
    const notify = () => broadcast(queueStatus());
    async function request(w, path, options = {}) {
        const response = await fetch(w.url.replace(/\/$/, "") + path, { ...options, signal: AbortSignal.timeout(requestTimeoutMs) });
        if (!response.ok) {
            const detail = (await response.text()).slice(0, 1500);
            throw bad(`Worker ${w.id} returned ${response.status}: ${detail}`, response.status);
        }
        return response;
    }
    const json = (w, path, body) => request(w, path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
    function rewriteAssets(value, workerId) {
        if (Array.isArray(value)) return value.map((v) => rewriteAssets(v, workerId));
        if (!value || typeof value !== "object") return value;
        const result = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rewriteAssets(v, workerId)]));
        if (typeof result.filename === "string" && ["output", "temp"].includes(result.type)) result.subfolder = `__worker__/${workerId}/${result.subfolder || ""}`;
        return result;
    }
    function finish(job, status, error, history) {
        const terminal = history
            ? rewriteAssets(history, job.workerId)
            : {
                  prompt: [0, job.id, JSON.parse(job.workflow), {}, []],
                  outputs: {},
                  status: { completed: false, status_str: "error", messages: [[status === "cancelled" ? "execution_interrupted" : "execution_error", { prompt_id: job.id, exception_message: error || status }]] },
              };
        update(job.id, { status, error: error || null, history: JSON.stringify(terminal) });
        broadcast({ type: status === "succeeded" ? "executing" : "execution_error", data: { prompt_id: job.id, node: null, exception_message: error || undefined } }, job.clientId);
        notify();
    }
    function connect(w) {
        if (closed || w.socket?.readyState === WebSocket.OPEN || w.socket?.readyState === WebSocket.CONNECTING) return;
        const url = new URL("/ws", w.url);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("clientId", w.clientId);
        const socket = new WebSocket(url, { handshakeTimeout: requestTimeoutMs });
        w.socket = socket;
        socket.on("error", () => {});
        socket.on("message", (raw, binary) => {
            if (closed || binary) return;
            try {
                const message = JSON.parse(raw.toString());
                if (message.type === "status") return;
                const job = message.data?.prompt_id ? get(message.data.prompt_id) : active().find((j) => j.workerId === w.id && j.status !== "queued");
                if (!job || job.workerId !== w.id || !ACTIVE.includes(job.status)) return;
                if (message.type === "progress") update(job.id, { progress: JSON.stringify({ value: message.data.value, max: message.data.max, node: message.data.node }) });
                if (message.type === "executing" && message.data.node) update(job.id, { progress: JSON.stringify({ node: message.data.node }) });
                broadcast({ ...message, data: { ...message.data, prompt_id: job.id } }, job.clientId);
            } catch {
                /* Ignore malformed upstream events; HTTP reconciliation remains authoritative. */
            }
        });
    }
    async function cancelOnWorker(w, job, queue) {
        if (queue.queue_running?.some((x) => x[1] === job.id)) await json(w, "/interrupt", { prompt_id: job.id });
        else if (queue.queue_pending?.some((x) => x[1] === job.id)) await json(w, "/queue", { delete: [job.id] });
    }
    async function reconcileWorker(w) {
        connect(w);
        try {
            let queue = await json(w, "/queue");
            w.online = true;
            w.busy = !!(queue.queue_running?.length || queue.queue_pending?.length);
            const job = active().find((j) => j.workerId === w.id && j.status !== "queued");
            if (job) {
                const history = (await json(w, "/history/" + encodeURIComponent(job.id)))[job.id];
                if (history) {
                    const success = history.status?.status_str === "success";
                    finish(job, success ? "succeeded" : job.cancelRequested ? "cancelled" : "failed", success ? null : history.status?.messages?.find((x) => x[0] === "execution_error")?.[1]?.exception_message || "ComfyUI execution failed", history);
                } else if ([...(queue.queue_running || []), ...(queue.queue_pending || [])].some((x) => x[1] === job.id)) {
                    update(job.id, { status: "running" });
                    if (job.cancelRequested) await cancelOnWorker(w, job, queue);
                    return;
                } else {
                    finish(job, job.cancelRequested ? "cancelled" : "interrupted", job.cancelRequested ? "Cancelled by user" : "Worker no longer has this task. Retry manually to avoid duplicate execution.");
                }
                queue = await json(w, "/queue");
                w.busy = !!(queue.queue_running?.length || queue.queue_pending?.length);
            }
            if (w.busy) return;
            const next = active().find((j) => j.status === "queued");
            if (!next) return;
            // Commit ownership before sending. A lost response is reconciled, never reposted.
            update(next.id, { status: "dispatching", workerId: w.id });
            notify();
            try {
                const response = await json(w, "/prompt", { prompt: JSON.parse(next.workflow), prompt_id: next.id, client_id: w.clientId });
                if (response.prompt_id !== next.id) throw Error("Worker did not preserve prompt_id");
                update(next.id, { status: "running" });
                w.busy = true;
            } catch (error) {
                if (error.status >= 400 && error.status < 500) finish(get(next.id), "failed", error.message);
                else w.online = false;
            }
        } catch {
            w.online = false;
        }
    }
    async function tick() {
        if (closed) return;
        if (working) return working;
        working = lock(async () => {
            for (const w of workers) await reconcileWorker(w);
        }).finally(() => {
            working = null;
        });
        return working;
    }
    function enqueue(body, retryOf = null) {
        if (!body.prompt || typeof body.prompt !== "object" || Array.isArray(body.prompt) || !Object.keys(body.prompt).length) throw bad("prompt must be a nonempty ComfyUI workflow");
        if (Object.values(body.prompt).some((n) => !n || typeof n.class_type !== "string" || !n.inputs || typeof n.inputs !== "object")) throw bad("Every prompt node needs class_type and inputs");
        const id = body.prompt_id || randomUUID();
        if (!validId(id)) throw bad("Invalid prompt_id");
        const existing = get(id);
        if (existing) {
            if (existing.workflow !== JSON.stringify(body.prompt)) throw bad("prompt_id already belongs to another workflow", 409);
            return id;
        }
        const now = Date.now();
        db.prepare("INSERT INTO jobs(id,status,createdAt,updatedAt,workflow,clientId,retryOf) VALUES(?,?,?,?,?,?,?)").run(id, "queued", now, now, JSON.stringify(body.prompt), typeof body.client_id === "string" ? body.client_id : null, retryOf);
        notify();
        return id;
    }
    async function cancel(id) {
        const job = get(id);
        if (!job) throw bad("Job not found", 404);
        if (!ACTIVE.includes(job.status)) return;
        if (job.status === "queued") {
            finish(job, "cancelled", "Cancelled by user");
            return;
        }
        update(id, { cancelRequested: 1 });
        const w = workers.find((w) => w.id === job.workerId);
        try {
            const queue = await json(w, "/queue");
            await cancelOnWorker(w, job, queue);
        } catch {
            /* Durable cancellation intent is retried after reconnection. */
        }
    }
    async function* boundedBody(req, limit) {
        if (Number(req.headers["content-length"]) > limit) throw bad("Request body too large", 413);
        let size = 0;
        for await (const part of req) {
            size += part.length;
            if (size > limit) throw bad("Request body too large", 413);
            yield part;
        }
    }
    async function body(req, limit) {
        const parts = [];
        for await (const part of boundedBody(req, limit)) {
            parts.push(part);
        }
        return Buffer.concat(parts);
    }
    async function healthy() {
        for (const w of workers) {
            try {
                await json(w, "/queue");
                w.online = true;
                return w;
            } catch {
                w.online = false;
            }
        }
        throw bad("No ComfyUI workers are available", 503);
    }
    function summary(job) {
        const outputs = [];
        if (job.history) {
            const walk = (v) => {
                if (!v || typeof v !== "object") return;
                if (typeof v.filename === "string" && v.type) {
                    const query = new URLSearchParams({ filename: v.filename, subfolder: v.subfolder || "", type: v.type });
                    outputs.push({ filename: v.filename, type: v.type, url: `${publicPrefix}/view?${query}` });
                } else Object.values(v).forEach(walk);
            };
            walk(JSON.parse(job.history).outputs);
        }
        return {
            id: job.id,
            status: job.status,
            workerId: job.workerId,
            createdAt: job.createdAt,
            updatedAt: job.updatedAt,
            error: job.error || undefined,
            progress: job.progress ? JSON.parse(job.progress) : undefined,
            outputs,
            retryOf: job.retryOf || undefined,
            cancelRequested: !!job.cancelRequested,
        };
    }
    const server = createServer(async (req, res) => {
        const respond = (data, status = 200) => {
            res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
            res.end(JSON.stringify(data));
        };
        try {
            const url = new URL(req.url, "http://queue.local"),
                path = url.pathname;
            if (req.method === "POST" && (req.headers.origin !== allowedOrigin || req.headers["sec-fetch-site"] === "cross-site")) throw bad("Mutation Origin is not allowed", 403);
            if (req.method === "GET" && path === "/health") {
                respond({ ok: true });
                return;
            }
            if (req.method === "POST" && path === "/upload/image") {
                if (!req.headers["content-type"]?.startsWith("multipart/form-data;")) throw bad("Expected multipart/form-data");
                if (Number(req.headers["content-length"]) > 100 * 1024 * 1024) throw bad("Request body too large", 413);
                const upload = boundedBody(req, 100 * 1024 * 1024);
                const w = await healthy();
                const response = await request(w, path, { method: "POST", headers: { "content-type": req.headers["content-type"] }, body: upload, duplex: "half" });
                respond(await response.json());
                return;
            }
            if (req.method === "GET" && (path === "/view" || path === "/system_stats" || /^\/object_info(?:\/[^/]+)?$/.test(path))) {
                let w;
                if (path === "/view") {
                    const subfolder = url.searchParams.get("subfolder") || "";
                    const match = subfolder.match(/^__worker__\/([^/]+)\/(.*)$/);
                    if (match) {
                        w = workers.find((w) => w.id === match[1]);
                        if (!w) throw bad("Unknown output worker");
                        url.searchParams.set("subfolder", match[2]);
                    } else if ((url.searchParams.get("type") || "output") !== "input") throw bad("Output assets require a worker route");
                    if (!url.searchParams.get("filename")) throw bad("filename is required");
                }
                w ||= await healthy();
                const response = await request(w, path + url.search);
                res.writeHead(200, { "content-type": response.headers.get("content-type") || "application/octet-stream" });
                for await (const chunk of response.body) {
                    if (res.destroyed) break;
                    if (!res.write(chunk))
                        await new Promise((r) => {
                            const done = () => {
                                res.off("drain", done);
                                res.off("close", done);
                                r();
                            };
                            res.once("drain", done);
                            res.once("close", done);
                        });
                }
                res.end();
                return;
            }
            let input;
            if (req.method === "POST") {
                try {
                    input = JSON.parse((await body(req, 5 * 1024 * 1024)).toString() || "{}");
                } catch (error) {
                    if (error.status) throw error;
                    throw bad("Invalid JSON body");
                }
                if (!input || typeof input !== "object" || Array.isArray(input)) throw bad("Expected JSON object");
            }
            const handle = async () => {
                if (req.method === "GET") {
                    if (path === "/jobs") {
                        const rows = db.prepare("SELECT * FROM jobs WHERE status IN ('queued','dispatching','running') OR id IN (SELECT id FROM jobs ORDER BY createdAt DESC,rowid DESC LIMIT 200) ORDER BY createdAt DESC,rowid DESC").all();
                        return { jobs: rows.map(summary), workers: workers.map(({ id, online, busy }) => ({ id, online, busy })) };
                    }
                    if (path === "/prompt") return { exec_info: { queue_remaining: active().length } };
                    if (path === "/queue") {
                        const rows = active();
                        const tuple = (j) => [j.createdAt, j.id, JSON.parse(j.workflow), { client_id: j.clientId }, []];
                        return { queue_running: rows.filter((j) => j.status !== "queued").map(tuple), queue_pending: rows.filter((j) => j.status === "queued").map(tuple) };
                    }
                    if (path === "/history" || path.startsWith("/history/")) {
                        const rows = path === "/history" ? db.prepare("SELECT id,history FROM jobs WHERE history IS NOT NULL ORDER BY updatedAt DESC LIMIT 200").all() : [get(decodeURIComponent(path.slice(9)))].filter(Boolean);
                        return Object.fromEntries(rows.filter((j) => j.history).map((j) => [j.id, JSON.parse(j.history)]));
                    }
                }
                if (req.method === "POST") {
                    if (path === "/prompt") return { prompt_id: enqueue(input), number: active().length, node_errors: {} };
                    const retry = path.match(/^\/jobs\/([^/]+)\/retry$/);
                    if (retry) {
                        const job = get(retry[1]);
                        if (!job) throw bad("Job not found", 404);
                        if (!["failed", "interrupted", "cancelled"].includes(job.status)) throw bad("Only failed, interrupted, or cancelled jobs can be retried", 409);
                        const existing = db.prepare("SELECT id FROM jobs WHERE retryOf=?").get(job.id);
                        return { prompt_id: existing?.id || enqueue({ prompt: JSON.parse(job.workflow), client_id: input.client_id || job.clientId }, job.id) };
                    }
                    const match = path.match(/^\/jobs\/([^/]+)\/cancel$/);
                    if (match) {
                        await cancel(match[1]);
                        return { ok: true };
                    }
                    if (path === "/interrupt") {
                        if (!validId(input.prompt_id)) throw bad("prompt_id is required; global interrupts are disabled");
                        await cancel(input.prompt_id);
                        return { ok: true };
                    }
                    if (path === "/queue") {
                        if (input.clear === true) {
                            for (const job of active().filter((j) => j.status === "queued")) await cancel(job.id);
                        } else if (Array.isArray(input.delete) && input.delete.every(validId)) {
                            for (const id of input.delete) await cancel(id);
                        } else throw bad("Expected delete prompt IDs or clear:true");
                        return { ok: true };
                    }
                }
                throw bad("Endpoint not found", 404);
            };
            // Reads and synchronous inserts remain responsive during upstream outages.
            const immediate = req.method === "GET" || path === "/prompt" || /^\/jobs\/[^/]+\/retry$/.test(path);
            const result = await (immediate ? handle() : lock(handle));
            respond(result);
        } catch (error) {
            if (res.headersSent) {
                res.destroy();
                return;
            }
            const failure = error.cause?.status ? error.cause : error;
            respond({ error: failure.status ? failure.message : "Queue service failed; please retry the request" }, failure.status || 500);
        }
    });
    server.on("upgrade", (req, socket, head) => {
        if (new URL(req.url, "http://queue.local").pathname !== "/ws" || req.headers.origin !== allowedOrigin) {
            socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
            return;
        }
        clients.handleUpgrade(req, socket, head, (ws) => {
            ws.clientId = new URL(req.url, "http://queue.local").searchParams.get("clientId") || randomUUID();
            ws.send(JSON.stringify({ ...queueStatus(), data: { ...queueStatus().data, sid: ws.clientId } }));
        });
    });
    return {
        tick,
        get url() {
            return `http://127.0.0.1:${server.address().port}`;
        },
        listen: async (port = 3002, host = "127.0.0.1") => {
            await new Promise((r) => server.listen(port, host, r));
            timer = setInterval(() => void tick(), pollMs);
            for (const w of workers) connect(w);
        },
        close: async () => {
            closed = true;
            clearInterval(timer);
            await working;
            await serial;
            for (const w of workers) w.socket?.terminate();
            for (const socket of clients.clients) socket.terminate();
            await new Promise((r) => server.close(r));
            clients.close();
            db.close();
        },
    };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const app = await createGenerationQueue({
        dbPath: process.env.GENERATION_DB_PATH || "/data/queue.sqlite",
        workers: JSON.parse(process.env.GENERATION_WORKERS || "[]"),
        allowedOrigin: process.env.GENERATION_ALLOWED_ORIGIN,
        publicPrefix: process.env.GENERATION_PUBLIC_PREFIX || "/api/generation",
    });
    await app.listen(Number(process.env.PORT || 3002), "0.0.0.0");
    await app.tick();
    for (const signal of ["SIGINT", "SIGTERM"])
        process.once(signal, async () => {
            await app.close();
            process.exit(0);
        });
}
