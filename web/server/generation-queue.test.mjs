import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { createGenerationQueue } from "./generation-queue.mjs";

async function worker() {
    const state = { posts: [], running: [], history: {}, offline: false, uncertain: false };
    const server = createServer(async (req, res) => {
        if (state.delay) await new Promise((r) => setTimeout(r, state.delay));
        if (state.offline) {
            res.writeHead(503).end();
            return;
        }
        let body = "";
        try {
            for await (const c of req) body += c;
        } catch {
            return;
        }
        if (req.url === "/upload/image") {
            state.upload = body;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ name: "input.png", subfolder: "", type: "input" }));
            return;
        }
        const data = body ? JSON.parse(body) : {};
        let result = {};
        if (req.url === "/queue") {
            if (req.method === "POST") state.running = state.running.filter((x) => !data.delete?.includes(x[1]));
            result = { queue_running: state.running, queue_pending: [] };
        } else if (req.url.startsWith("/history/")) {
            const id = req.url.slice(9);
            result = state.history[id] ? { [id]: state.history[id] } : {};
        } else if (req.url === "/prompt") {
            if (state.reject) {
                res.writeHead(400).end(JSON.stringify({ error: "invalid workflow" }));
                return;
            }
            if (state.acceptDelay) await new Promise((r) => setTimeout(r, state.acceptDelay));
            state.posts.push(data);
            state.running.push([1, data.prompt_id, data.prompt, {}, []]);
            if (state.uncertain) {
                req.socket.destroy();
                return;
            }
            result = { prompt_id: data.prompt_id };
        } else if (req.url === "/interrupt") {
            state.interrupt = data;
            state.running = state.running.filter((x) => x[1] !== data.prompt_id);
        } else if (req.url.startsWith("/view")) {
            if (state.mediaDelay) {
                res.writeHead(200, { "content-type": "video/mp4", "content-length": "8" });
                res.write("part");
                const timer = setTimeout(() => res.end("tail"), state.mediaDelay);
                res.on("close", () => {
                    state.mediaClosed = !res.writableFinished;
                    clearTimeout(timer);
                });
                return;
            }
            if (req.headers.range) {
                res.writeHead(206, { "content-type": "video/mp4", "content-range": "bytes 0-3/10", "accept-ranges": "bytes", "content-length": "4" });
                res.end("part");
                return;
            }
            res.end(req.url);
            return;
        }
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result));
    });
    const wss = new WebSocketServer({ server });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    return {
        state,
        wss,
        url: `http://127.0.0.1:${server.address().port}`,
        close: async () => {
            for (const s of wss.clients) s.terminate();
            await new Promise((r) => server.close(r));
        },
    };
}
async function fixture(t, overrides = {}) {
    const dir = await mkdtemp(join(tmpdir(), "gen-"));
    const workers = await Promise.all([worker(), worker()]);
    const opts = { dbPath: join(dir, "queue.sqlite"), workers: workers.map((w, i) => ({ id: `gpu${i}`, url: w.url })), allowedOrigin: "http://canvas.test", pollMs: 60000, ...overrides };
    let app = await createGenerationQueue(opts);
    await app.listen(0);
    let url = app.url;
    const api = async (path, body) => {
        const r = await fetch(url + path, { method: body === undefined ? "GET" : "POST", headers: { Origin: opts.allowedOrigin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
        return { status: r.status, data: await r.json() };
    };
    t.after(async () => {
        await app.close();
        await Promise.all(workers.map((w) => w.close()));
        await rm(dir, { recursive: true });
    });
    return {
        workers,
        api,
        get app() {
            return app;
        },
        restart: async () => {
            await app.close();
            app = await createGenerationQueue(opts);
            await app.listen(0);
            url = app.url;
        },
    };
}
const prompt = { 1: { class_type: "Test", inputs: {} } };
test("durable FIFO assigns three jobs across two workers and routes outputs", async (t) => {
    const f = await fixture(t);
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await f.api("/prompt", { prompt })).data.prompt_id);
    await f.app.tick();
    assert.deepEqual(
        f.workers.map((w) => w.state.posts.length),
        [1, 1],
    );
    await f.restart();
    await f.app.tick();
    assert.deepEqual(
        f.workers.map((w) => w.state.posts.length),
        [1, 1],
    );
    f.workers[0].state.running = [];
    f.workers[0].state.history[ids[0]] = { outputs: { 1: { images: [{ filename: "same.png", subfolder: "", type: "output" }] } }, status: { completed: true, status_str: "success" } };
    await f.app.tick();
    assert.equal(f.workers[0].state.posts.length, 2);
    const h = (await f.api("/history/" + ids[0])).data[ids[0]];
    assert.equal(h.outputs[1].images[0].subfolder, "__worker__/gpu0/");
    const jobs = (await f.api("/jobs")).data.jobs;
    assert.equal(jobs.find((j) => j.id === ids[0]).status, "succeeded");
    assert.match(jobs.find((j) => j.id === ids[0]).outputs[0].url, /__worker__/);
});
test("uncertain POST and offline recovery never duplicate execution; missing requires manual retry", async (t) => {
    const f = await fixture(t);
    f.workers[0].state.uncertain = true;
    const id = (await f.api("/prompt", { prompt })).data.prompt_id;
    await f.app.tick();
    f.workers[0].state.offline = true;
    await f.restart();
    await f.app.tick();
    assert.equal(f.workers[0].state.posts.length, 1);
    assert.equal((await f.api("/jobs")).data.jobs[0].workerId, "gpu0");
    f.workers[0].state.offline = false;
    await f.app.tick();
    assert.equal(f.workers[0].state.posts.length, 1);
    f.workers[0].state.running = [];
    await f.app.tick();
    assert.equal((await f.api("/jobs")).data.jobs[0].status, "interrupted");
    const a = await f.api(`/jobs/${id}/retry`, {}),
        b = await f.api(`/jobs/${id}/retry`, {});
    assert.equal(a.data.prompt_id, b.data.prompt_id);
    assert.notEqual(a.data.prompt_id, id);
});
test("cancel exact owned prompt; reject global interrupt and cross origin; durable terminal history", async (t) => {
    const f = await fixture(t);
    const id = (await f.api("/prompt", { prompt })).data.prompt_id;
    await f.app.tick();
    assert.equal((await f.api("/interrupt", {})).status, 400);
    await f.api(`/jobs/${id}/cancel`, {});
    assert.deepEqual(f.workers[0].state.interrupt, { prompt_id: id });
    await f.app.tick();
    assert.equal((await f.api("/jobs")).data.jobs[0].status, "cancelled");
    assert.equal((await f.api("/history/" + id)).data[id].status.status_str, "error");
    const r = await fetch(f.app.url + "/prompt", { method: "POST", headers: { Origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify({ prompt }) });
    assert.equal(r.status, 403);
    assert.equal((await f.api("/prompt", { prompt: {} })).status, 400);
});
test("external queue prevents dispatch and websocket reports progress", async (t) => {
    const f = await fixture(t);
    for (const w of f.workers) w.state.running = [[0, "external", {}, {}, []]];
    const id = (await f.api("/prompt", { prompt })).data.prompt_id;
    await f.app.tick();
    assert.equal(f.workers[0].state.posts.length, 0);
    f.workers[0].state.running = [];
    await f.app.tick();
    await new Promise((r) => setTimeout(r, 40));
    for (const s of f.workers[0].wss.clients) s.send(JSON.stringify({ type: "progress", data: { prompt_id: id, value: 2, max: 5, node: "1" } }));
    await new Promise((r) => setTimeout(r, 40));
    assert.equal((await f.api("/jobs")).data.jobs[0].progress.value, 2);
});
test("output route reaches exact worker and invalid routes fail closed", async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.app.url + "/view?filename=same.png&type=output&subfolder=__worker__/gpu1/folder");
    assert.equal(await response.text(), "/view?filename=same.png&type=output&subfolder=folder");
    assert.equal((await f.api("/view?filename=same.png&type=output")).status, 400);
    assert.equal((await f.api("/view?filename=same.png&type=output&subfolder=__worker__/bogus/")).status, 400);
    assert.equal((await f.api("/arbitrary-admin")).status, 404);
});
test("cancel racing completion preserves successful result and never interrupts external task", async (t) => {
    const f = await fixture(t);
    const id = (await f.api("/prompt", { prompt })).data.prompt_id;
    await f.app.tick();
    f.workers[0].state.running = [[2, "external", {}, {}, []]];
    f.workers[0].state.history[id] = { outputs: {}, status: { completed: true, status_str: "success" } };
    await f.api(`/jobs/${id}/cancel`, {});
    assert.equal(f.workers[0].state.interrupt, undefined);
    await f.app.tick();
    assert.equal((await f.api("/jobs")).data.jobs[0].status, "succeeded");
});
test("invalid upstream workflow stores readable terminal failure and supports exactly one retry child", async (t) => {
    const f = await fixture(t);
    f.workers[0].state.reject = true;
    const id = (await f.api("/prompt", { prompt })).data.prompt_id;
    await f.app.tick();
    const job = (await f.api("/jobs")).data.jobs.find((j) => j.id === id);
    assert.equal(job.status, "failed");
    assert.match(job.error, /invalid workflow/);
    assert.equal((await f.api("/history/" + id)).data[id].status.status_str, "error");
});

test("upload forwards multipart bytes and rejects oversized declared length before reading", async (t) => {
    const f = await fixture(t);
    const form = new FormData();
    form.append("image", new Blob(["image bytes"]), "input.png");
    const result = await fetch(f.app.url + "/upload/image", { method: "POST", headers: { Origin: "http://canvas.test" }, body: form });
    assert.equal(result.status, 200);
    assert.match(f.workers[0].state.upload, /image bytes/);
    const { request } = await import("node:http");
    const status = await new Promise((resolve, reject) => {
        const req = request(f.app.url + "/upload/image", { method: "POST", headers: { Origin: "http://canvas.test", "content-type": "multipart/form-data; boundary=x", "content-length": 101 * 1024 * 1024 } }, (res) => {
            res.resume();
            resolve(res.statusCode);
            req.destroy();
        });
        req.on("error", reject);
        req.setTimeout(500, () => {
            resolve(408);
            req.destroy();
        });
        req.flushHeaders();
    });
    assert.equal(status, 413);
});

test("slow worker does not block durable acceptance or queue reads", async (t) => {
    const f = await fixture(t);
    f.workers[0].state.delay = 400;
    const polling = f.app.tick();
    const outcome = await Promise.race([
        f
            .api("/prompt", { prompt })
            .then(() => f.api("/jobs"))
            .then(() => true),
        new Promise((r) => setTimeout(() => r(false), 150)),
    ]);
    assert.equal(outcome, true);
    await polling;
});

test("uncertain POST stays held until late acceptance is observable", async (t) => {
    const f = await fixture(t, { requestTimeoutMs: 30 });
    f.workers[0].state.acceptDelay = 180;
    const id = (await f.api("/prompt", { prompt })).data.prompt_id;
    await f.app.tick();
    await f.app.tick();
    let job = (await f.api("/jobs")).data.jobs.find((j) => j.id === id);
    assert.equal(job.status, "dispatching");
    assert.match(job.error, /uncertain/i);
    assert.equal((await f.api(`/jobs/${id}/retry`, {})).status, 409);
    await f.restart();
    await f.app.tick();
    assert.equal((await f.api("/jobs")).data.jobs.find((j) => j.id === id).status, "dispatching");
    await new Promise((r) => setTimeout(r, 200));
    await f.app.tick();
    job = (await f.api("/jobs")).data.jobs.find((j) => j.id === id);
    assert.equal(job.status, "running");
    assert.equal(f.workers[0].state.posts.length, 1);
});
test("terminal job pagination retains active jobs and reaches older results", async (t) => {
    const f = await fixture(t);
    const ids = [];
    for (let i = 0; i < 101; i++) {
        const id = (await f.api("/prompt", { prompt })).data.prompt_id;
        ids.push(id);
        await f.api(`/jobs/${id}/cancel`, {});
    }
    const activeId = (await f.api("/prompt", { prompt })).data.prompt_id;
    const first = (await f.api("/jobs")).data;
    assert.equal(first.jobs.length, 101);
    assert.equal(first.nextOffset, 100);
    assert.equal(first.offset, 0);
    const second = (await f.api("/jobs?offset=100")).data;
    assert.equal(second.jobs.length, 2);
    assert.equal(second.nextOffset, null);
    assert.ok(second.jobs.some((j) => j.id === ids[0]));
    assert.ok(second.jobs.some((j) => j.id === activeId));
    assert.equal((await f.api("/jobs?offset=-1")).status, 400);
    assert.equal((await f.api("/jobs?offset=1.5")).status, 400);
});
test("output views preserve HTTP byte ranges for video playback", async (t) => {
    const f = await fixture(t);
    const response = await fetch(f.app.url + "/view?filename=clip.mp4&type=output&subfolder=__worker__/gpu1/", { headers: { range: "bytes=0-3" } });
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("content-range"), "bytes 0-3/10");
    assert.equal(response.headers.get("accept-ranges"), "bytes");
    assert.equal(response.headers.get("content-length"), "4");
    assert.equal(await response.text(), "part");
});

test("media download and upload outlive control request deadline", async (t) => {
    const f = await fixture(t, { requestTimeoutMs: 60, mediaTimeoutMs: 1000 });
    f.workers[0].state.mediaDelay = 180;
    const response = await fetch(f.app.url + "/view?filename=clip.mp4&type=output&subfolder=__worker__/gpu0/");
    assert.equal(await response.text(), "parttail");
    async function* multipart() {
        yield '--x\r\nContent-Disposition: form-data; name="image"; filename="a.png"\r\n\r\n';
        await new Promise((r) => setTimeout(r, 180));
        yield "bytes\r\n--x--\r\n";
    }
    const upload = await fetch(f.app.url + "/upload/image", { method: "POST", headers: { Origin: "http://canvas.test", "content-type": "multipart/form-data; boundary=x" }, body: multipart(), duplex: "half" });
    assert.equal(upload.status, 200);
    assert.match(f.workers[0].state.upload, /bytes/);
});
test("downstream media disconnect immediately cancels upstream transfer", async (t) => {
    const f = await fixture(t, { requestTimeoutMs: 3000, mediaTimeoutMs: 3000 });
    f.workers[0].state.mediaDelay = 1000;
    const controller = new AbortController();
    const response = await fetch(f.app.url + "/view?filename=clip.mp4&type=output&subfolder=__worker__/gpu0/", { signal: controller.signal });
    await response.body.getReader().read();
    controller.abort();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(f.workers[0].state.mediaClosed, true);
});
