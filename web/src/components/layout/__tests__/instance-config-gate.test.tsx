import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "antd";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultConfig, useConfigStore } from "@/stores/use-config-store";
import { InstanceConfigGate } from "../instance-config-gate";
const control = vi.hoisted(() => ({ enabled: true, read: vi.fn(), write: vi.fn() }));
vi.mock("@/constant/runtime-config", () => ({
    get SERVER_CONFIG_ENABLED() {
        return control.enabled;
    },
}));
vi.mock("@/services/api/instance-config", async (importOriginal) => ({ ...(await importOriginal<object>()), readInstanceConfig: control.read, writeInstanceConfig: control.write }));
let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    control.enabled = true;
    control.read.mockReset();
    control.write.mockReset();
    vi.spyOn(useConfigStore.persist, "hasHydrated").mockReturnValue(true);
    useConfigStore.setState({ config: structuredClone(defaultConfig) });
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
});
async function render() {
    await act(async () =>
        root.render(
            <App>
                <InstanceConfigGate>
                    <div>APP CONTENT</div>
                </InstanceConfigGate>
            </App>,
        ),
    );
}
it("keeps static deployments independent of the service", async () => {
    control.enabled = false;
    await render();
    expect(host.textContent).toContain("APP CONTENT");
    expect(control.read).not.toHaveBeenCalled();
});
it("waits for server configuration before rendering the application", async () => {
    let finish!: (value: any) => void;
    control.read.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    await render();
    expect(host.textContent).not.toContain("APP CONTENT");
    const remote = structuredClone(defaultConfig);
    remote.size = "1344x768";
    await act(async () => finish({ version: 1, revision: 7, config: remote }));
    expect(host.textContent).toContain("APP CONTENT");
    expect(useConfigStore.getState().config.size).toBe("1344x768");
    expect(control.write).not.toHaveBeenCalled();
});
it("does not initialize an empty server implicitly", async () => {
    control.read.mockResolvedValue({ version: 1, revision: 0, config: null });
    await render();
    expect(host.textContent).toContain("使用当前浏览器配置初始化");
    expect(control.write).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("APP CONTENT");
});
it("does not silently fall back or overwrite when server reading fails", async () => {
    control.read.mockRejectedValue(new Error("offline"));
    await render();
    expect(host.textContent).toContain("offline");
    expect(host.textContent).not.toContain("APP CONTENT");
    expect(control.write).not.toHaveBeenCalled();
});

it("restarts failed local hydration on explicit retry", async () => {
    vi.useFakeTimers();
    let hydrated = false;
    vi.mocked(useConfigStore.persist.hasHydrated).mockImplementation(() => hydrated);
    vi.spyOn(useConfigStore.persist, "onFinishHydration").mockReturnValue(() => {});
    const rehydrate = vi.spyOn(useConfigStore.persist, "rehydrate").mockImplementation(async () => {
        hydrated = true;
    });
    control.read.mockResolvedValue({ version: 1, revision: 1, config: structuredClone(defaultConfig) });
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(host.textContent).toContain("浏览器配置读取超时");
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("重新读取"))!;
    await act(async () => retry.click());
    expect(rehydrate).toHaveBeenCalledOnce();
    expect(host.textContent).toContain("APP CONTENT");
});

it("keeps the timeout active when retry hydration hangs", async () => {
    vi.useFakeTimers();
    vi.mocked(useConfigStore.persist.hasHydrated).mockReturnValue(false);
    vi.spyOn(useConfigStore.persist, "onFinishHydration").mockReturnValue(() => {});
    vi.spyOn(useConfigStore.persist, "rehydrate").mockReturnValue(new Promise(() => {}));
    await render();
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    const retry = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes("重新读取"))!;
    await act(async () => retry.click());
    await act(async () => vi.advanceTimersByTimeAsync(15000));
    expect(host.textContent).toContain("浏览器配置读取超时");
    expect(control.read).not.toHaveBeenCalled();
});
