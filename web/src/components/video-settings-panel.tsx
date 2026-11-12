import { Slider } from "antd";
import { type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { ImageSettingsTheme } from "@/components/image-settings-panel";
import { type CanvasTheme } from "@/lib/canvas-theme";
import { modelOptionName, type AiConfig } from "@/stores/use-config-store";
import {
    getModelProfile,
    resolveVideoModelIdForMode,
    type WorkflowModelProfile,
    videoMinimaxH3OmniProfile,
    getDslMiddleSize,
} from "@/services/api/models";

export type VideoAspect = "16:9" | "9:16" | "1:1";

export type MiniMaxVideoTier = {
    landscapeW: number;
    landscapeH: number;
};

/**
 * MiniMax H3 官方支持的 32 整数倍尺寸档位（12 档横竖屏及 2 档方形预设）
 */
export const MINIMAX_VIDEO_SIZE_TIERS: MiniMaxVideoTier[] = [
    { landscapeW: 864, landscapeH: 480 },
    { landscapeW: 960, landscapeH: 544 },
    { landscapeW: 1056, landscapeH: 608 },
    { landscapeW: 1152, landscapeH: 640 },
    { landscapeW: 1216, landscapeH: 672 },
    { landscapeW: 1280, landscapeH: 736 },
    { landscapeW: 1344, landscapeH: 768 },
    { landscapeW: 1376, landscapeH: 768 },
    { landscapeW: 1504, landscapeH: 832 },
    { landscapeW: 1664, landscapeH: 928 },
    { landscapeW: 1824, landscapeH: 1024 },
    { landscapeW: 1920, landscapeH: 1088 },
    { landscapeW: 768, landscapeH: 768 },
    { landscapeW: 1024, landscapeH: 1024 },
];

export const quickSecondOptions = [5, 10, 15];

export const videoSecondOptions = quickSecondOptions.map((value) => String(value));
export const videoResolutionOptions = [{ value: "720", label: "720p" }];
export const videoSizeOptions = MINIMAX_VIDEO_SIZE_TIERS.flatMap((tier) => tier.landscapeW === tier.landscapeH ? [
    { value: `${tier.landscapeW}x${tier.landscapeH}`, label: `1:1 · ${tier.landscapeW}×${tier.landscapeH}`, width: tier.landscapeW, height: tier.landscapeH },
] : [
    { value: `${tier.landscapeW}x${tier.landscapeH}`, label: `16:9 · ${tier.landscapeW}×${tier.landscapeH}`, width: tier.landscapeW, height: tier.landscapeH },
    { value: `${tier.landscapeH}x${tier.landscapeW}`, label: `9:16 · ${tier.landscapeH}×${tier.landscapeW}`, width: tier.landscapeH, height: tier.landscapeW },
]);

export type VideoSettingsPanelProps = {
    modelId?: string;
    size?: string;
    duration?: number | string;
    videoMode?: "omni" | "frame";
    onParamChange?: (patch: {
        modelId?: string;
        videoMode?: "omni" | "frame";
        size?: string;
        seconds?: string;
        duration?: number;
    }) => void;
    config?: AiConfig;
    onConfigChange?: (key: "vquality" | "size" | "videoSeconds" | "videoGenerateAudio" | "videoWatermark" | "videoMode", value: string) => void;
    theme: CanvasTheme;
    showTitle?: boolean;
    className?: string;
};

export function VideoSettingsPanel({
    modelId,
    size,
    duration,
    videoMode,
    onParamChange,
    config,
    onConfigChange,
    theme,
    showTitle = true,
    className = "w-[320px] space-y-4 rounded-2xl px-1 py-0.5",
}: VideoSettingsPanelProps) {
    const { t } = useTranslation();

    // 动态解析绑定的工作流模型 Profile
    const effectiveModelId = modelId || (videoMode === "frame" ? "frame-video-minimax-h3-fp8-4step-pdmd" : videoMode === "omni" ? "omni-video-minimax-h3-fp8-4step-pdmd" : undefined) || config?.videoModel || config?.model;
    const profile = getModelProfile(effectiveModelId) || videoMinimaxH3OmniProfile;
    const selectedModelId = modelId || config?.videoModel || config?.model;
    const modelLabel = selectedModelId ? (getModelProfile(selectedModelId)?.name || modelOptionName(selectedModelId)) : profile.name;

    const currentMode: "omni" | "frame" = videoMode || (profile.category === "frameVideo" ? "frame" : (config?.videoMode === "frame" ? "frame" : "omni"));

    // 动态尺寸能力配置
    const sizeConfig = profile.capabilityConfig.size;
    const sizeTiers = extractVideoSizeTiers(sizeConfig?.values);
    const rawSize = size || config?.size;
    const currentSize = normalizeVideoSizeValue(rawSize, profile);
    const { width: currentW, height: currentH, aspect, tier: selectedTier } = parseVideoSize(currentSize, sizeTiers);

    const visibleTiers = sizeTiers.filter((tier) => (tier.landscapeW === tier.landscapeH) === (aspect === "1:1"));
    const aspects: VideoAspect[] = sizeTiers.some((tier) => tier.landscapeW === tier.landscapeH) ? ["16:9", "9:16", "1:1"] : ["16:9", "9:16"];
    const aspectLabels = { "16:9": "横屏", "9:16": "竖屏", "1:1": "方形" };

    // 动态时长能力配置
    const durationConfig = profile.capabilityConfig.duration;
    const minDuration = durationConfig?.min ?? 1;
    const maxDuration = durationConfig?.max ?? 15;
    const stepDuration = durationConfig?.step ?? 1;
    const quickTags = durationConfig?.tags ?? [5, 10, 15];
    const defaultDuration = durationConfig?.default ?? 5;
    const rawSeconds = duration !== undefined ? Number(duration) : Number(config?.videoSeconds);
    const secondsNum = Math.min(maxDuration, Math.max(minDuration, Number.isFinite(rawSeconds) && rawSeconds > 0 ? rawSeconds : defaultDuration));

    const handleSelectMode = (nextMode: "omni" | "frame") => {
        onParamChange?.({
            modelId: resolveVideoModelIdForMode(profile.id, nextMode),
            videoMode: nextMode,
        });
        onConfigChange?.("videoMode", nextMode);
    };

    const handleSelectTier = (tier: MiniMaxVideoTier) => {
        const nextW = aspect === "16:9" ? tier.landscapeW : tier.landscapeH;
        const nextH = aspect === "16:9" ? tier.landscapeH : tier.landscapeW;
        const nextSize = `${nextW}x${nextH}`;
        onParamChange?.({ size: nextSize });
        onConfigChange?.("size", nextSize);
    };

    const handleSwitchAspect = (nextAspect: VideoAspect) => {
        if (nextAspect === aspect) return;
        const candidates = sizeTiers.filter((tier) => (tier.landscapeW === tier.landscapeH) === (nextAspect === "1:1"));
        if (!candidates.length) return;
        const area = currentW * currentH;
        const nextTier = candidates.reduce((closest, tier) =>
            Math.abs(tier.landscapeW * tier.landscapeH - area) < Math.abs(closest.landscapeW * closest.landscapeH - area) ? tier : closest);
        const nextW = nextAspect === "9:16" ? nextTier.landscapeH : nextTier.landscapeW;
        const nextH = nextAspect === "9:16" ? nextTier.landscapeW : nextTier.landscapeH;
        const nextSize = `${nextW}x${nextH}`;
        onParamChange?.({ size: nextSize });
        onConfigChange?.("size", nextSize);
    };

    const handleDurationChange = (val: number) => {
        onParamChange?.({ seconds: String(val), duration: val });
        onConfigChange?.("videoSeconds", String(val));
    };

    return (
        <ImageSettingsTheme theme={theme}>
            <div className={className} style={{ color: theme.node.text }} onMouseDown={(event) => event.stopPropagation()}>
                {showTitle ? (
                    <div className="flex items-center justify-between">
                        <span className="text-base font-semibold">{t("settingsPanels.video.title")}</span>
                        <span className="rounded bg-black/5 dark:bg-white/10 px-1.5 py-0.5 text-[11px] font-medium opacity-70">
                            {modelLabel}
                        </span>
                    </div>
                ) : (
                    <div className="flex items-center justify-between px-0.5 text-[11px] font-medium opacity-70">
                        <span>{modelLabel}</span>
                    </div>
                )}

                {/* 0. 生成模式切换：全能参考 vs 首尾帧 */}
                <SettingGroup title="生成模式" color={theme.node.muted}>
                    <div className="grid grid-cols-2 gap-2">
                        <button
                            type="button"
                            className="flex h-10 cursor-pointer flex-col items-center justify-center rounded-xl border text-xs font-medium transition hover:opacity-85"
                            style={{
                                borderColor: currentMode === "omni" ? theme.node.text : theme.node.stroke,
                                background: currentMode === "omni" ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                color: theme.node.text,
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => handleSelectMode("omni")}
                        >
                            <span className="font-semibold">全能参考 (Omni)</span>
                            <span className="text-[10px] leading-none opacity-55">多模态 (图/音/视频)</span>
                        </button>
                        <button
                            type="button"
                            className="flex h-10 cursor-pointer flex-col items-center justify-center rounded-xl border text-xs font-medium transition hover:opacity-85"
                            style={{
                                borderColor: currentMode === "frame" ? theme.node.text : theme.node.stroke,
                                background: currentMode === "frame" ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                color: theme.node.text,
                            }}
                            onMouseDown={(event) => event.stopPropagation()}
                            onClick={() => handleSelectMode("frame")}
                        >
                            <span className="font-semibold">首尾帧 (Frame)</span>
                            <span className="text-[10px] leading-none opacity-55">首帧 / 首尾帧插帧</span>
                        </button>
                    </div>
                </SettingGroup>

                {/* 1. 比例切换：由工作流支持的尺寸决定 */}
                <SettingGroup title="视频宽高比" color={theme.node.muted}>
                    <div className={`grid ${aspects.length === 3 ? "grid-cols-3" : "grid-cols-2"} gap-2`}>
                        {aspects.map((value) => (
                            <button
                                key={value}
                                type="button"
                                className="flex h-9 cursor-pointer items-center justify-center gap-2 rounded-xl border text-xs font-medium transition hover:opacity-85"
                                style={{
                                    borderColor: aspect === value ? theme.node.text : theme.node.stroke,
                                    background: aspect === value ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                    color: theme.node.text,
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onClick={() => handleSwitchAspect(value)}
                            >
                                <span className={`inline-block rounded-sm border-2 ${value === "16:9" ? "h-2.5 w-4" : value === "9:16" ? "h-4 w-2.5" : "h-3 w-3"}`} style={{ borderColor: theme.node.text }} />
                                <span>{value} {aspectLabels[value]}</span>
                            </button>
                        ))}
                    </div>
                </SettingGroup>

                {/* 2. 尺寸清晰度档位：动态呈现硬件对齐规格 */}
                <SettingGroup title={`生成尺寸规格 (${aspectLabels[aspect]}，当前: ${currentW} × ${currentH})`} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">
                        {visibleTiers.map((tier) => {
                            const itemW = aspect === "16:9" ? tier.landscapeW : tier.landscapeH;
                            const itemH = aspect === "16:9" ? tier.landscapeH : tier.landscapeW;
                            const isSelected = selectedTier.landscapeW === tier.landscapeW && selectedTier.landscapeH === tier.landscapeH;

                            return (
                                <button
                                    key={`${tier.landscapeW}x${tier.landscapeH}`}
                                    type="button"
                                    className="flex h-10 cursor-pointer items-center justify-center rounded-xl border transition hover:opacity-80"
                                    style={{
                                        borderColor: isSelected ? theme.node.text : theme.node.stroke,
                                        background: isSelected ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                                        color: theme.node.text,
                                    }}
                                    onMouseDown={(event) => event.stopPropagation()}
                                    onClick={() => handleSelectTier(tier)}
                                >
                                    <span className="text-xs font-semibold leading-tight tracking-tight">
                                        {itemW} × {itemH}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </SettingGroup>

                {/* 3. 视频时长 */}
                <SettingGroup title={`视频时长: ${secondsNum} 秒`} color={theme.node.muted}>
                    <div className="grid grid-cols-3 gap-2">
                        {quickTags.map((value) => (
                            <OptionPill
                                key={value}
                                selected={secondsNum === value}
                                theme={theme}
                                onClick={() => handleDurationChange(value)}
                            >
                                {value} 秒
                            </OptionPill>
                        ))}
                    </div>
                    <div className="px-1 pt-1">
                        <Slider
                            min={minDuration}
                            max={maxDuration}
                            step={stepDuration}
                            value={secondsNum}
                            tooltip={{ formatter: (v) => `${v} 秒` }}
                            onChange={(val) => handleDurationChange(val)}
                        />
                    </div>
                </SettingGroup>
            </div>
        </ImageSettingsTheme>
    );
}

export function videoResolutionLabel(_value: string) {
    return "720p";
}

export function extractVideoSizeTiers(values?: string[]): MiniMaxVideoTier[] {
    if (!values || values.length === 0) return MINIMAX_VIDEO_SIZE_TIERS;
    const tierMap = new Map<string, MiniMaxVideoTier>();
    for (const val of values) {
        const match = val.match(/^(\d+)\s*[x×]\s*(\d+)$/i);
        if (!match) continue;
        const w = Number(match[1]);
        const h = Number(match[2]);
        const landscapeW = Math.max(w, h);
        const landscapeH = Math.min(w, h);
        const key = `${landscapeW}x${landscapeH}`;
        if (!tierMap.has(key)) {
            tierMap.set(key, { landscapeW, landscapeH });
        }
    }
    return Array.from(tierMap.values()).sort((a, b) => (a.landscapeW * a.landscapeH) - (b.landscapeW * b.landscapeH));
}

export function videoSizeLabel(value?: string, profile?: WorkflowModelProfile) {
    const tiers = extractVideoSizeTiers(profile?.capabilityConfig.size?.values);
    const size = normalizeVideoSizeValue(value, profile);
    const { width, height, aspect } = parseVideoSize(size, tiers);
    return `${width}×${height} (${aspect})`;
}

export function videoSecondsLabel(value?: string | number, profile?: WorkflowModelProfile) {
    const durationConfig = profile?.capabilityConfig.duration;
    const min = durationConfig?.min ?? 1;
    const max = durationConfig?.max ?? 15;
    const def = durationConfig?.default ?? 5;
    const raw = Number(value);
    const s = Number.isFinite(raw) ? Math.min(max, Math.max(min, raw)) : def;
    return `${s}s`;
}

export function normalizeVideoSizeValue(value?: string, profile?: WorkflowModelProfile) {
    const allowed = profile?.capabilityConfig.size?.values;
    const defaultVal =
        profile?.capabilityConfig.size?.default ||
        (allowed ? getDslMiddleSize(allowed, "16:9") : "1344x768");
    if (!value) return defaultVal;
    if (allowed && allowed.length > 0) {
        const clean = value.toLowerCase().replace(/\s+/g, "");
        const matched = allowed.find((v) => v.toLowerCase().replace(/\s+/g, "") === clean);
        return matched || defaultVal;
    }
    const isValid = videoSizeOptions.some((option) => option.value === value);
    return isValid ? value : defaultVal;
}

export function normalizeVideoResolutionValue(_value?: string) {
    return "720";
}

export function parseVideoSize(
    sizeStr?: string,
    tiers: MiniMaxVideoTier[] = MINIMAX_VIDEO_SIZE_TIERS,
): { width: number; height: number; aspect: VideoAspect; tier: MiniMaxVideoTier } {
    const availableTiers = tiers.length > 0 ? tiers : MINIMAX_VIDEO_SIZE_TIERS;
    const rectangularTiers = availableTiers.filter((tier) => tier.landscapeW !== tier.landscapeH);
    const defaultTiers = rectangularTiers.length ? rectangularTiers : availableTiers;
    const fallbackTier = defaultTiers[Math.floor(defaultTiers.length / 2)];
    const raw = (sizeStr || "").trim().toLowerCase();
    const match = raw.match(/^(\d+)\s*[x×]\s*(\d+)$/);
    const w = Number(match?.[1]) || fallbackTier.landscapeW;
    const h = Number(match?.[2]) || fallbackTier.landscapeH;

    const hasSquares = availableTiers.some((tier) => tier.landscapeW === tier.landscapeH);
    const aspect: VideoAspect = w === h && hasSquares ? "1:1" : w >= h ? "16:9" : "9:16";
    const longSide = Math.max(w, h);
    const shortSide = Math.min(w, h);

    let matchedTier = fallbackTier;
    let minDiff = Infinity;
    for (const t of availableTiers) {
        if ((t.landscapeW === t.landscapeH) !== (aspect === "1:1")) continue;
        const diff = Math.abs(t.landscapeW - longSide) + Math.abs(t.landscapeH - shortSide);
        if (diff < minDiff) {
            minDiff = diff;
            matchedTier = t;
        }
    }

    const finalW = aspect === "16:9" ? matchedTier.landscapeW : matchedTier.landscapeH;
    const finalH = aspect === "16:9" ? matchedTier.landscapeH : matchedTier.landscapeW;

    return { width: finalW, height: finalH, aspect, tier: matchedTier };
}

function OptionPill({ selected, disabled = false, theme, onClick, children }: { selected: boolean; disabled?: boolean; theme: CanvasTheme; onClick: () => void; children: ReactNode }) {
    return (
        <button
            type="button"
            disabled={disabled}
            className="h-9 cursor-pointer rounded-xl border px-2 text-xs font-medium transition hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-35"
            style={{
                background: selected ? (theme.mode === "dark" ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.05)") : "transparent",
                borderColor: selected ? theme.node.text : theme.node.stroke,
                color: theme.node.text,
            }}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={onClick}
        >
            {children}
        </button>
    );
}

function SettingGroup({ title, color, children }: { title: string; color: string; children: ReactNode }) {
    return (
        <div className="space-y-2">
            <div className="text-xs font-medium" style={{ color }}>
                {title}
            </div>
            {children}
        </div>
    );
}
