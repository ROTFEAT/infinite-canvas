import { afterEach, expect, it, vi } from "vitest";
import { getGenerationQueue, changeGenerationJob } from "../generation-queue";
afterEach(() => vi.unstubAllGlobals());
it("reads the server queue without a browser task cache", async () => {
    const data = { jobs: [{ id: "one", status: "queued" }], workers: [] };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(data)));
    vi.stubGlobal("fetch", fetcher);
    expect(await getGenerationQueue()).toEqual(data);
    expect(fetcher.mock.calls[0][0]).toBe("/api/generation/jobs");
    expect(fetcher.mock.calls[0][1].cache).toBe("no-store");
});
it("cancels only the specified job and returns retry IDs", async () => {
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ prompt_id: "retry" })));
    vi.stubGlobal("fetch", fetcher);
    expect(await changeGenerationJob("one", "retry")).toEqual({ prompt_id: "retry" });
    expect(fetcher.mock.calls[0][0]).toBe("/api/generation/jobs/one/retry");
    expect(fetcher.mock.calls[0][1].method).toBe("POST");
    await changeGenerationJob("two", "cancel");
    expect(fetcher.mock.calls[1][0]).toBe("/api/generation/jobs/two/cancel");
});
it("surfaces server errors instead of showing success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: "正在核对任务状态" }), { status: 409 })));
    await expect(changeGenerationJob("one", "retry")).rejects.toThrow("正在核对任务状态");
});
