import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import VideoPage from "../index";
import { defaultConfig } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

const harness = vi.hoisted(() => ({
    enabled: true, create: vi.fn(), poll: vi.fn(), store: vi.fn(), save: vi.fn(),
    logs: new Map<string, any>(), config: {} as typeof defaultConfig,
    noop: () => {}, t: (key: string) => key,
}));
vi.mock("@/constant/runtime-config", async (original) => ({ ...await original<typeof import("@/constant/runtime-config")>(), get GENERATION_QUEUE_ENABLED() { return harness.enabled; } }));
vi.mock("@/services/api/video", () => ({ createVideoGenerationTask: harness.create, pollVideoGenerationTask: harness.poll, storeGeneratedVideo: harness.store }));
vi.mock("localforage", () => ({ default: { createInstance: () => ({ setItem: harness.save, iterate: async (visit: (value: any) => void) => { harness.logs.forEach(visit); }, getItem: async () => null }) } }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: harness.t }) }));
vi.mock("@/i18n", () => ({ default: { t: harness.t, resolvedLanguage: "en" } }));
vi.mock("@/stores/use-config-store", async (original) => ({
    ...await original<typeof import("@/stores/use-config-store")>(),
    useConfigStore: (select: (value: unknown) => unknown) => select({ config: harness.config, isAiConfigReady: () => true, updateConfig: harness.noop, openConfigDialog: harness.noop }),
    useEffectiveConfig: () => harness.config,
}));
vi.mock("antd", async (original) => ({ ...await original<typeof import("antd")>(), Drawer: () => null }));
vi.mock("@/stores/use-asset-store", () => ({ useAssetStore: (select: (value: unknown) => unknown) => select({ addAsset: harness.noop }) }));
vi.mock("@/stores/use-theme-store", () => ({ useThemeStore: (select: (value: unknown) => unknown) => select({ theme: "light" }) }));
vi.mock("@/components/model-picker", () => ({ ModelPicker: () => null }));
vi.mock("@/components/video-settings-panel", async (original) => ({ ...await original<typeof import("@/components/video-settings-panel")>(), VideoSettingsPanel: () => null }));
vi.mock("@/components/canvas/asset-picker-modal", () => ({ AssetPickerModal: () => null }));
vi.mock("@/components/prompts/prompt-select-dialog", () => ({ PromptSelectDialog: () => null }));
vi.mock("@/services/file-storage", () => ({ deleteStoredMedia: vi.fn(), resolveMediaUrl: async (_key: string, url: string) => url }));
function deferred<T = any>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => { resolve = done; });
    return { promise, resolve };
}
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    harness.enabled = true; harness.logs.clear(); harness.config = { ...defaultConfig, model: "video-model", videoModel: "video-model" };
    harness.create.mockReset().mockImplementation(async () => ({ id: `job-${harness.create.mock.calls.length}`, model: "video-model" }));
    harness.poll.mockReset().mockImplementation(() => new Promise(() => {}));
    harness.store.mockReset().mockResolvedValue({ url: "/video.mp4", storageKey: "video", bytes: 1, mimeType: "video/mp4" });
    harness.save.mockReset().mockImplementation(async (id, value) => { harness.logs.set(id, value); });
    useWorkbenchAgentStore.setState({ videoCommand: null, tasks: [] });
    host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function render() {
    await act(async () => root.render(<App><VideoPage /></App>));
    await act(async () => { useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "First video", run: false }); });
}
function submitButton() { return Array.from(host.querySelectorAll("button")).find(b => /workbench.generate|加入生成队列/.test(b.textContent || ""))!; }
async function click() { await act(async () => submitButton().click()); }
it("allows two queued submissions before either finishes, preserving job prompts and active status", async () => {
    const first = deferred(); const second = deferred();
    harness.poll.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await render(); await click();
    expect(submitButton().disabled).toBe(false);
    expect(submitButton().textContent).toContain("加入生成队列");
    harness.config = { ...harness.config, videoSeconds: "9" };
    await act(async () => { useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "Second video", run: false }); });
    await click();
    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.create.mock.calls.map(call => call[1])).toEqual(["First video", "Second video"]);
    expect(harness.logs.size).toBe(2);
    expect(harness.poll.mock.calls[0][0].videoSeconds).not.toBe("9");
    expect(harness.poll.mock.calls[1][0].videoSeconds).toBe("9");
    await act(async () => first.resolve({ status: "completed", result: {} }));
    expect(host.textContent).toContain("workbench.waiting");
    await act(async () => second.resolve({ status: "completed", result: {} }));
    expect(host.textContent).not.toContain("workbench.waiting");
    expect([...harness.logs.values()].map(log => log.status)).toEqual(["success", "success"]);
});
it("keeps static deployments blocked until generation completes", async () => {
    harness.enabled = false; await render(); await click(); await click();
    expect(submitButton().disabled).toBe(true);
    expect(harness.create).toHaveBeenCalledTimes(1);
});
it("blocks rapid clicks through task acknowledgement and local pending-log persistence", async () => {
    const acknowledgement = deferred(); const persistence = deferred();
    harness.create.mockReturnValue(acknowledgement.promise);
    harness.save.mockReturnValue(persistence.promise);
    await render();
    await act(async () => { submitButton().click(); submitButton().click(); });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(submitButton().disabled).toBe(true);
    await act(async () => acknowledgement.resolve({ id: "one", model: "video-model" }));
    await click(); expect(harness.create).toHaveBeenCalledTimes(1);
    await act(async () => persistence.resolve(undefined));
    expect(submitButton().disabled).toBe(false);
});
it("allows agent commands to enqueue while another generation is pending", async () => {
    await render(); await click();
    await act(async () => { useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "Agent video", run: true }); });
    expect(harness.create).toHaveBeenCalledTimes(2);
    expect(harness.create.mock.calls[1][1]).toBe("Agent video");
});

it("keeps monitoring an earlier job when the next submission fails and permits retry", async () => {
    await render(); await click();
    harness.create.mockRejectedValueOnce(new Error("Submission failed"));
    await click();
    expect(host.textContent).toContain("workbench.waiting");
    expect(submitButton().disabled).toBe(false);
    expect([...harness.logs.values()].map(log => log.status)).toEqual(["pending", "failed"]);
    await click();
    expect(harness.create).toHaveBeenCalledTimes(3);
});
it("keeps the running indicator when an earlier job finishes during a new submission", async () => {
    const first = deferred(); const acknowledgement = deferred();
    harness.poll.mockImplementationOnce(() => first.promise);
    await render(); await click();
    harness.create.mockReturnValueOnce(acknowledgement.promise);
    await click();
    await act(async () => first.resolve({ status: "completed", result: {} }));
    expect(host.textContent).toContain("workbench.waiting");
    expect(submitButton().disabled).toBe(true);
    await act(async () => acknowledgement.resolve({ id: "second", model: "video-model" }));
    expect(host.textContent).toContain("workbench.waiting");
    expect(submitButton().disabled).toBe(false);
});
it("rejects agent submissions while acknowledgement is pending", async () => {
    harness.create.mockReturnValue(new Promise(() => {}));
    await render(); await click();
    let taskId: string | undefined;
    await act(async () => { taskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "Another", run: true }); });
    expect(harness.create).toHaveBeenCalledTimes(1);
    expect(useWorkbenchAgentStore.getState().tasks.find(task => task.id === taskId)?.status).toBe("failed");
});
it("preserves agent ownership when another completion refreshes a newly persisted pending job", async () => {
    const first = deferred(); const second = deferred(); const persistence = deferred();
    harness.poll.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    await render(); await click();
    harness.save.mockImplementation(async (id, value) => {
        harness.logs.set(id, value);
        if (value.prompt === "Agent race" && value.status === "pending") await persistence.promise;
    });
    let taskId: string | undefined;
    await act(async () => { taskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt: "Agent race", run: true }); });
    await act(async () => first.resolve({ status: "completed", result: {} }));
    await act(async () => persistence.resolve(undefined));
    await act(async () => second.resolve({ status: "completed", result: {} }));
    expect(useWorkbenchAgentStore.getState().tasks.find(task => task.id === taskId)?.status).toBe("succeeded");
    expect(harness.poll).toHaveBeenCalledTimes(2);
});
