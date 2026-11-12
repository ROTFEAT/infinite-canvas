import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import QueuePage from "../index";
const control = vi.hoisted(() => ({ enabled: true, get: vi.fn(), change: vi.fn() }));
vi.mock("@/constant/runtime-config", () => ({ get GENERATION_QUEUE_ENABLED() { return control.enabled; } }));
vi.mock("@/services/api/generation-queue", () => ({ getGenerationQueue: control.get, changeGenerationJob: control.change }));
let root: Root;
let host: HTMLDivElement;
const data = { workers: [{ id: "gpu0", online: true, busy: true }, { id: "gpu1", online: false }], jobs: [
    { id: "running-one", status: "running", workerId: "gpu0", createdAt: 1, updatedAt: 1, progress: { node: "Sampler", value: 4, max: 20 } },
    { id: "queued-two", status: "queued", createdAt: 2, updatedAt: 2 },
    { id: "failed-three", status: "failed", createdAt: 3, updatedAt: 3, error: "CUDA out of memory" },
    { id: "done-four", status: "succeeded", createdAt: 4, updatedAt: 4, outputs: [{ url: "/api/generation/view?filename=one.mp4", filename: "one.mp4" }] },
] };
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    control.enabled = true; control.get.mockReset().mockResolvedValue(data); control.change.mockReset().mockResolvedValue({ prompt_id: "retry-id" });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); });
async function render() { await act(async () => root.render(<App><QueuePage /></App>)); }
it("shows durable jobs, worker availability, node progress and downloadable output", async () => {
    await render();
    expect(host.textContent).toContain("gpu0"); expect(host.textContent).toContain("离线");
    expect(host.textContent).toContain("4 / 20"); expect(host.textContent).toContain("CUDA out of memory");
    expect(host.querySelector('a[href="/api/generation/view?filename=one.mp4"]')).not.toBeNull();
});
it("retries a failed job without resubmitting running jobs", async () => {
    await render();
    const buttons = Array.from(host.querySelectorAll("button"));
    await act(async () => buttons.find(b => b.textContent?.replace(/\s/g, "") === "重试")!.click());
    expect(control.change).toHaveBeenCalledWith("failed-three", "retry");
    expect(control.get).toHaveBeenCalledTimes(2);
});
it("reports action failures visibly", async () => {
    control.change.mockRejectedValue(new Error("任务状态尚未确认")); await render();
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.replace(/\s/g, "") === "重试")!.click());
    expect(host.textContent).toContain("任务状态尚未确认");
});
it("does not request a backend in static deployments", async () => {
    control.enabled = false; await render();
    expect(control.get).not.toHaveBeenCalled(); expect(host.textContent).toContain("未启用");
});
it("pages through older persisted results", async () => {
    control.get.mockResolvedValue({ ...data, offset: 0, nextOffset: 100 });
    await render();
    await act(async () => Array.from(host.querySelectorAll("button")).find(b => b.textContent?.replace(/\s/g, "") === "更早记录")!.click());
    expect(control.get).toHaveBeenLastCalledWith(expect.any(AbortSignal), 100);
});
