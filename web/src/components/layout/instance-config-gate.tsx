import { useEffect, useRef, useState, type ReactNode } from "react";
import { Alert, App, Button, Space, Spin } from "antd";
import { SERVER_CONFIG_ENABLED } from "@/constant/runtime-config";
import { useConfigStore } from "@/stores/use-config-store";
import { createConfigSync, mergeInstanceConfig, readInstanceConfig, writeInstanceConfig, type ConfigSyncState } from "@/services/api/instance-config";

function waitForConfigHydration(retry: boolean) {
    if (useConfigStore.persist.hasHydrated()) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        let unsubscribe = () => {};
        const finish = (error?: unknown) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            unsubscribe();
            if (error) reject(error);
            else resolve();
        };
        const timeout = setTimeout(() => finish(new Error("浏览器配置读取超时，请重试。")), 15000);
        unsubscribe = useConfigStore.persist.onFinishHydration(() => finish());
        if (retry) {
            // Do not await before arming the timeout: a blocked storage backend may never settle.
            try {
                Promise.resolve(useConfigStore.persist.rehydrate()).then(() => {
                    if (useConfigStore.persist.hasHydrated()) finish();
                }, finish);
            } catch (error) {
                finish(error);
            }
        }
    });
}

export function InstanceConfigGate({ children }: { children: ReactNode }) {
    const { modal } = App.useApp();
    const [attempt, setAttempt] = useState(0);
    const [boot, setBoot] = useState<"loading" | "ready" | "empty" | "error">("loading");
    const [error, setError] = useState("");
    const [syncState, setSyncState] = useState<ConfigSyncState>({ phase: "saved" });
    const sync = useRef<ReturnType<typeof createConfigSync> | null>(null);

    useEffect(() => {
        if (!SERVER_CONFIG_ENABLED) return;
        let active = true;
        let unsubscribe = () => {};
        setBoot("loading");
        setError("");
        async function load() {
            try {
                await waitForConfigHydration(attempt > 0);
                if (!active) return;
                const remote = await readInstanceConfig();
                if (!active) return;
                if (!remote.config) {
                    setBoot("empty");
                    return;
                }
                const local = useConfigStore.getState().config;
                const config = mergeInstanceConfig(remote.config, local);
                useConfigStore.getState().setConfig(config);
                setSyncState({ phase: "saved" });
                sync.current = createConfigSync({ config, revision: remote.revision, onState: setSyncState });
                unsubscribe = useConfigStore.subscribe((state, previous) => {
                    if (state.config !== previous.config) sync.current?.update(state.config);
                });
                setBoot("ready");
            } catch (reason) {
                if (active) {
                    setError(reason instanceof Error ? reason.message : "读取服务器配置失败");
                    setBoot("error");
                }
            }
        }
        void load();
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (sync.current?.hasPendingChanges()) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("beforeunload", beforeUnload);
        return () => {
            active = false;
            unsubscribe();
            sync.current?.dispose();
            sync.current = null;
            window.removeEventListener("beforeunload", beforeUnload);
        };
    }, [attempt]);

    async function initialize() {
        setBoot("loading");
        setError("");
        try {
            await writeInstanceConfig(useConfigStore.getState().config, 0);
            setAttempt((value) => value + 1);
        } catch (reason) {
            setError(reason instanceof Error ? reason.message : "初始化失败");
            setBoot("error");
        }
    }
    function reload() {
        modal.confirm({
            title: "读取服务器配置？",
            content: "当前浏览器尚未保存的配置修改将被服务器版本替换。画布和素材不会受到影响。",
            okText: "读取服务器配置",
            cancelText: "取消",
            onOk: () => setAttempt((value) => value + 1),
        });
    }

    if (!SERVER_CONFIG_ENABLED) return <>{children}</>;
    if (boot !== "ready")
        return (
            <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center gap-4 p-6">
                <h1 className="text-xl font-semibold">共享服务器配置</h1>
                {boot === "loading" ? (
                    <Spin description="正在读取配置…" />
                ) : (
                    <>
                        <Alert
                            showIcon
                            type={boot === "empty" ? "info" : "error"}
                            title={boot === "empty" ? "服务器尚未保存配置" : "无法读取服务器配置"}
                            description={boot === "empty" ? "初始化将共享当前浏览器的渠道、工作流和默认参数。认证凭据、画布和素材仍保留在本地。" : error}
                        />
                        {boot === "empty" && (
                            <Button type="primary" onClick={initialize}>
                                使用当前浏览器配置初始化
                            </Button>
                        )}
                        <Button onClick={() => setAttempt((value) => value + 1)}>重新读取服务器配置</Button>
                    </>
                )}
            </main>
        );
    const failed = syncState.phase === "error" || syncState.phase === "conflict";
    const statusText = failed ? "配置未保存到服务器" : syncState.phase === "saved" ? "配置已保存到服务器" : "正在保存配置…";
    return (
        <>
            <div className="fixed bottom-3 left-3 z-[1100] max-w-[calc(100vw-1.5rem)]" role="status" aria-live="polite">
                {failed ? (
                    <Alert
                        showIcon
                        type="error"
                        title={statusText}
                        description={syncState.message}
                        action={
                            <Space wrap>
                                {syncState.phase === "error" && (
                                    <Button size="small" onClick={() => sync.current?.retry()}>
                                        重试保存
                                    </Button>
                                )}
                                <Button size="small" onClick={reload}>
                                    读取服务器配置
                                </Button>
                            </Space>
                        }
                    />
                ) : (
                    <span className="rounded border border-current/10 bg-[var(--ant-color-bg-container)] px-3 py-1 text-xs opacity-80">{statusText}</span>
                )}
            </div>
            {children}
        </>
    );
}
