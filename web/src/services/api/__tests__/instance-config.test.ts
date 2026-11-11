import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "@/stores/use-config-store";
import { createConfigSync, mergeInstanceConfig, sharedInstanceConfig, readInstanceConfig, writeInstanceConfig, InstanceConfigError } from "../instance-config";

const config = () => structuredClone(defaultConfig);
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe("shared instance configuration", () => {
    it("removes browser credentials without mutating the original", () => {
        const local = config();
        local.apiKey = "private";
        local.channels[0].apiKey = "key";
        local.channels[0].comfyuiProxyToken = "token";
        const shared = sharedInstanceConfig(local);
        expect(shared.apiKey).toBe("");
        expect(shared.channels[0].apiKey).toBe("");
        expect(shared.channels[0].comfyuiProxyToken).toBe("");
        expect(local.channels[0].comfyuiProxyToken).toBe("token");
    });
    it("restores credentials by channel id only when endpoint is unchanged", () => {
        const local = config();
        local.channels[0].comfyuiProxyToken = "local-token";
        const shared = sharedInstanceConfig(local);
        shared.size = "1344x768";
        expect(mergeInstanceConfig(shared, local).channels[0].comfyuiProxyToken).toBe("local-token");
        shared.channels[0].comfyuiProxyUrl = "https://different.example";
        expect(mergeInstanceConfig(shared, local).channels[0].comfyuiProxyToken).toBe("");
    });
    it("fails loudly on an HTML response or malformed server envelope", async () => {
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("<html>SPA</html>")));
        await expect(readInstanceConfig()).rejects.toThrow();
        vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 2, revision: 1, config: config() }))));
        await expect(readInstanceConfig()).rejects.toThrow();
    });
    it("sends revision and nonsecret JSON using the same-origin endpoint", async () => {
        const input = config();
        input.apiKey = "private";
        const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ version: 1, revision: 2, config: sharedInstanceConfig(input) })));
        vi.stubGlobal("fetch", fetcher);
        await writeInstanceConfig(input, 1);
        const [url, options] = fetcher.mock.calls[0];
        expect(url).toBe("/api/instance-config");
        expect(options.headers["X-Instance-Config"]).toBe("1");
        expect(JSON.parse(options.body).baseRevision).toBe(1);
        expect(options.body).not.toContain("private");
    });
});

describe("configuration write queue", () => {
    it("does not write on initial load or credential-only changes", async () => {
        vi.useFakeTimers();
        const initial = config();
        const write = vi.fn();
        const sync = createConfigSync({ config: initial, revision: 1, write, onState: vi.fn() });
        const credentialsOnly = config();
        credentialsOnly.apiKey = "secret";
        sync.update(credentialsOnly);
        await vi.runAllTimersAsync();
        expect(write).not.toHaveBeenCalled();
        sync.dispose();
    });
    it("serializes edits during an in-flight write and uses the new revision", async () => {
        vi.useFakeTimers();
        let finish!: (value: any) => void;
        const write = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockImplementationOnce(async (c) => ({ version: 1, revision: 3, config: c }));
        const state = vi.fn();
        const sync = createConfigSync({ config: config(), revision: 1, write, onState: state });
        const first = config();
        first.size = "1344x768";
        sync.update(first);
        await vi.advanceTimersByTimeAsync(500);
        expect(write).toHaveBeenCalledTimes(1);
        const second = config();
        second.size = "864x480";
        second.videoSeconds = "10";
        sync.update(second);
        await vi.advanceTimersByTimeAsync(1000);
        expect(write).toHaveBeenCalledTimes(1);
        finish({ version: 1, revision: 2, config: first });
        await vi.runAllTimersAsync();
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1][1]).toBe(2);
        expect(write.mock.calls[1][0].videoSeconds).toBe("10");
        expect(state.mock.lastCall?.[0].phase).toBe("saved");
        sync.dispose();
    });
    it("stops on conflict; retry never changes the stale revision", async () => {
        vi.useFakeTimers();
        const write = vi.fn().mockRejectedValue(new InstanceConfigError("conflict", 409));
        const state = vi.fn();
        const sync = createConfigSync({ config: config(), revision: 4, write, onState: state });
        const changed = config();
        changed.size = "1344x768";
        sync.update(changed);
        await vi.runAllTimersAsync();
        expect(state.mock.lastCall?.[0].phase).toBe("conflict");
        changed.videoSeconds = "10";
        sync.update(changed);
        await vi.runAllTimersAsync();
        expect(write).toHaveBeenCalledTimes(1);
        sync.retry();
        await vi.runAllTimersAsync();
        expect(write.mock.calls[1][1]).toBe(4);
        sync.dispose();
    });
    it("retains pending changes on network failure and can retry", async () => {
        vi.useFakeTimers();
        const write = vi
            .fn()
            .mockRejectedValueOnce(new Error("offline"))
            .mockImplementationOnce(async (c) => ({ version: 1, revision: 2, config: c }));
        const state = vi.fn();
        const sync = createConfigSync({ config: config(), revision: 1, write, onState: state });
        const changed = config();
        changed.size = "1344x768";
        sync.update(changed);
        await vi.runAllTimersAsync();
        expect(state.mock.lastCall?.[0].phase).toBe("error");
        sync.retry();
        await vi.runAllTimersAsync();
        expect(write.mock.calls[1][0].size).toBe("1344x768");
        expect(state.mock.lastCall?.[0].phase).toBe("saved");
        sync.dispose();
    });
    it("does not claim saved when a committed response is lost and the user reverted locally", async () => {
        vi.useFakeTimers();
        let fail!: (reason: Error) => void;
        const write = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise((_resolve, reject) => {
                        fail = reject;
                    }),
            )
            .mockRejectedValueOnce(new InstanceConfigError("conflict", 409));
        const state = vi.fn();
        const initial = config();
        const sync = createConfigSync({ config: initial, revision: 1, write, onState: state });
        const changed = config();
        changed.size = "1344x768";
        sync.update(changed);
        await vi.advanceTimersByTimeAsync(500);
        sync.update(initial);
        fail(new Error("Response lost after server commit"));
        await vi.runAllTimersAsync();
        expect(sync.hasPendingChanges()).toBe(true);
        sync.retry();
        await vi.runAllTimersAsync();
        expect(write).toHaveBeenCalledTimes(2);
        expect(write.mock.calls[1][1]).toBe(1);
        expect(state.mock.lastCall?.[0].phase).toBe("conflict");
        sync.dispose();
    });
    it("cancels pending writes on dispose", async () => {
        vi.useFakeTimers();
        const write = vi.fn();
        const sync = createConfigSync({ config: config(), revision: 1, write, onState: vi.fn() });
        const changed = config();
        changed.size = "1344x768";
        sync.update(changed);
        sync.dispose();
        await vi.runAllTimersAsync();
        expect(write).not.toHaveBeenCalled();
    });
});
