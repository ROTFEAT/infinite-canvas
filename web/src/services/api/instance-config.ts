import { defaultConfig, type AiConfig } from "@/stores/use-config-store";

export type InstanceConfig = { version: 1; revision: number; config: AiConfig | null };
export type ConfigSyncState = { phase: "saved" | "pending" | "saving" | "error" | "conflict"; message?: string };
export class InstanceConfigError extends Error {
    constructor(
        message: string,
        public status: number,
    ) {
        super(message);
    }
}

// Only credentials with an explicit field in AiConfig are excluded. Workflow JSON is shared as authored.
export function sharedInstanceConfig(config: AiConfig): AiConfig {
    return JSON.parse(
        JSON.stringify({
            ...config,
            apiKey: "",
            channels: config.channels.map((channel) => ({ ...channel, apiKey: "", comfyuiProxyToken: "" })),
        }),
    );
}

export function mergeInstanceConfig(shared: AiConfig, local: AiConfig): AiConfig {
    const clean = sharedInstanceConfig(shared);
    return {
        ...defaultConfig,
        ...clean,
        apiKey: clean.baseUrl === local.baseUrl && clean.apiFormat === local.apiFormat ? local.apiKey : "",
        channels: clean.channels.map((channel) => {
            const old = local.channels.find((item) => item.id === channel.id);
            const sameEndpoint = old && old.apiFormat === channel.apiFormat && old.baseUrl === channel.baseUrl && old.comfyuiProxyUrl === channel.comfyuiProxyUrl;
            return { ...channel, apiKey: sameEndpoint ? old.apiKey : "", comfyuiProxyToken: sameEndpoint ? old.comfyuiProxyToken : "" };
        }),
    };
}

async function request(init: RequestInit): Promise<InstanceConfig> {
    const response = await fetch("/api/instance-config", { ...init, cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok) {
        throw new InstanceConfigError(response.status === 409 ? "其他浏览器已更新配置，请先读取服务器版本。" : `配置服务请求失败（${response.status}）`, response.status);
    }
    const value = await response.json();
    if (
        value?.version !== 1 ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        (value.config === null
            ? value.revision !== 0
            : !value.config ||
              !Array.isArray(value.config.channels) ||
              !Array.isArray(value.config.models) ||
              !value.config.channels.every((channel: any) => channel && typeof channel.id === "string" && typeof channel.name === "string" && Array.isArray(channel.models)))
    ) {
        throw new Error("服务器配置格式无效，已停止同步。");
    }
    return value;
}
export const readInstanceConfig = () => request({ method: "GET" });
export const writeInstanceConfig = (config: AiConfig, baseRevision: number) =>
    request({
        method: "PUT",
        headers: { "Content-Type": "application/json", "X-Instance-Config": "1" },
        body: JSON.stringify({ baseRevision, config: sharedInstanceConfig(config) }),
    });

type SyncOptions = {
    config: AiConfig;
    revision: number;
    onState: (state: ConfigSyncState) => void;
    write?: typeof writeInstanceConfig;
};

// A single in-flight request per browser. A newer edit replaces the pending snapshot, never the active one.
export function createConfigSync({ config, revision, onState, write = writeInstanceConfig }: SyncOptions) {
    let latest = sharedInstanceConfig(config);
    let acknowledged = JSON.stringify(latest);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inFlight = false;
    let blocked = false;
    let disposed = false;
    // A failed response may hide a committed write; equality with an old snapshot cannot prove persistence.
    let uncertain = false;
    const dirty = () => uncertain || JSON.stringify(latest) !== acknowledged;
    const schedule = () => {
        clearTimeout(timer);
        if (disposed || blocked || inFlight) return;
        if (!dirty()) {
            onState({ phase: "saved" });
            return;
        }
        onState({ phase: "pending" });
        timer = setTimeout(flush, 500);
    };
    async function flush() {
        if (disposed || blocked || inFlight || !dirty()) return;
        inFlight = true;
        const snapshot = latest;
        onState({ phase: "saving" });
        try {
            const result = await write(snapshot, revision);
            if (disposed) return;
            uncertain = false;
            revision = result.revision;
            acknowledged = JSON.stringify(snapshot);
        } catch (error) {
            if (disposed) return;
            uncertain = true;
            blocked = true;
            onState({ phase: error instanceof InstanceConfigError && error.status === 409 ? "conflict" : "error", message: error instanceof Error ? error.message : "保存失败" });
        } finally {
            inFlight = false;
            if (!disposed && !blocked) schedule();
        }
    }
    return {
        update(next: AiConfig) {
            latest = sharedInstanceConfig(next);
            schedule();
        },
        retry() {
            blocked = false;
            schedule();
        },
        hasPendingChanges: () => inFlight || dirty(),
        dispose() {
            disposed = true;
            clearTimeout(timer);
        },
    };
}
