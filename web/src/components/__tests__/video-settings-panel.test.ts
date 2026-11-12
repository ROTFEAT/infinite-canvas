import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CanvasVideoSettingsPopover } from "../canvas/canvas-video-settings-popover";
import { canvasThemes } from "@/lib/canvas-theme";
import { defaultConfig, encodeChannelModel } from "@/stores/use-config-store";
import {
    VideoSettingsPanel,
    type VideoSettingsPanelProps,
    extractVideoSizeTiers,
    normalizeVideoSizeValue,
    parseVideoSize,
    videoSecondsLabel,
    videoSizeLabel,
    MINIMAX_VIDEO_SIZE_TIERS,
} from "../video-settings-panel";
import {
    BUILTIN_WORKFLOW_MODELS,
    videoMinimaxH3OmniProfile,
    videoMinimaxH3FrameProfile,
} from "@/services/api/models";

describe("Video Settings Panel DSL & Sizing Helpers", () => {
    it("extractVideoSizeTiers dynamically parses discrete dimension pairs into sorted landscape tiers", () => {
        const tiers = extractVideoSizeTiers(videoMinimaxH3OmniProfile.capabilityConfig.size?.values);
        expect(tiers).toHaveLength(14);
        expect(tiers.filter((tier) => tier.landscapeW !== tier.landscapeH)).toHaveLength(12);
        expect(tiers[0]).toEqual({ landscapeW: 864, landscapeH: 480 });
        expect(tiers[tiers.length - 1]).toEqual({ landscapeW: 1920, landscapeH: 1088 });
    });

    it("extractVideoSizeTiers falls back to default tiers when no values provided", () => {
        const tiers = extractVideoSizeTiers(undefined);
        expect(tiers).toEqual(MINIMAX_VIDEO_SIZE_TIERS);
    });

    it("parseVideoSize correctly resolves 16:9 landscape dimensions and matching tier", () => {
        const result = parseVideoSize("1280x736");
        expect(result.aspect).toBe("16:9");
        expect(result.width).toBe(1280);
        expect(result.height).toBe(736);
        expect(result.tier.landscapeW).toBe(1280);
        expect(result.tier.landscapeH).toBe(736);
    });

    it("parseVideoSize correctly resolves 9:16 portrait dimensions symmetrically", () => {
        const result = parseVideoSize("736x1280");
        expect(result.aspect).toBe("9:16");
        expect(result.width).toBe(736);
        expect(result.height).toBe(1280);
        expect(result.tier.landscapeW).toBe(1280);
        expect(result.tier.landscapeH).toBe(736);
    });

    it("normalizeVideoSizeValue validates against model DSL allowed values", () => {
        // Valid 16:9 size from profile
        expect(normalizeVideoSizeValue("1280x736", videoMinimaxH3OmniProfile)).toBe("1280x736");
        // Valid 9:16 size from profile
        expect(normalizeVideoSizeValue("736x1280", videoMinimaxH3FrameProfile)).toBe("736x1280");
        // Valid 2.0 MP tier
        expect(normalizeVideoSizeValue("1920x1088", videoMinimaxH3OmniProfile)).toBe("1920x1088");
        expect(normalizeVideoSizeValue("1088x1920", videoMinimaxH3FrameProfile)).toBe("1088x1920");
        // Disallowed custom size falls back to profile default (middle tier index 6: 1344x768)
        expect(normalizeVideoSizeValue("1920x1080", videoMinimaxH3OmniProfile)).toBe("1344x768");
        // Removed 0.2 and 0.3 tiers fall back to profile default
        expect(normalizeVideoSizeValue("608x352", videoMinimaxH3OmniProfile)).toBe("1344x768");
        expect(normalizeVideoSizeValue("736x416", videoMinimaxH3OmniProfile)).toBe("1344x768");
        // Empty size falls back to profile dynamic middle default
        expect(normalizeVideoSizeValue("", videoMinimaxH3FrameProfile)).toBe("1344x768");

        // Custom profile with odd number of tiers (e.g. 3 tiers -> middle is 864x480)
        const customProfile = {
            ...videoMinimaxH3OmniProfile,
            capabilityConfig: {
                ...videoMinimaxH3OmniProfile.capabilityConfig,
                size: {
                    parameter: "size" as const,
                    values: ["608x352", "352x608", "864x480", "480x864", "1344x768", "768x1344"],
                    default: "864x480",
                    allowCustom: false,
                },
            },
        };
        expect(normalizeVideoSizeValue("invalid", customProfile)).toBe("864x480");
    });

    it("videoSizeLabel produces human-readable label with aspect ratio", () => {
        expect(videoSizeLabel("1280x736", videoMinimaxH3OmniProfile)).toBe("1280×736 (16:9)");
        expect(videoSizeLabel("736x1280", videoMinimaxH3OmniProfile)).toBe("736×1280 (9:16)");
    });

    it("videoSecondsLabel clamps duration between DSL min and max and formats with 's'", () => {
        expect(videoSecondsLabel(5, videoMinimaxH3OmniProfile)).toBe("5s");
        expect(videoSecondsLabel(15, videoMinimaxH3OmniProfile)).toBe("15s");
        // Clamps below 1 to min 1
        expect(videoSecondsLabel(0, videoMinimaxH3OmniProfile)).toBe("1s");
        // Clamps above 15 to max 15
        expect(videoSecondsLabel(20, videoMinimaxH3OmniProfile)).toBe("15s");
        // Invalid falls back to profile default 5s
        expect(videoSecondsLabel("invalid", videoMinimaxH3OmniProfile)).toBe("5s");
    });
});


describe.each([true, false])("Video Settings Panel badge (showTitle=%s)", (showTitle) => {
    const customName = "H3 REF2VA · 人物多素材参考 · 20步";
    const customModel = encodeChannelModel("local-comfyui", customName);

    beforeEach(() => vi.stubGlobal("React", React));
    afterEach(() => vi.unstubAllGlobals());

    function badge(props: Partial<VideoSettingsPanelProps> = {}) {
        const host = document.createElement("div");
        host.innerHTML = renderToStaticMarkup(React.createElement(VideoSettingsPanel, {
            theme: canvasThemes.light,
            showTitle,
            ...props,
        }));
        return host.firstElementChild?.firstElementChild?.lastElementChild?.textContent;
    }

    it("shows the custom config videoModel even when videoMode supplies fallback capabilities", () => {
        expect(badge({
            videoMode: "omni",
            config: { ...defaultConfig, videoModel: customModel, model: videoMinimaxH3FrameProfile.id },
        })).toBe(customName);
    });

    it("shows an explicit custom modelId ahead of config models", () => {
        expect(badge({
            modelId: customModel,
            config: { ...defaultConfig, videoModel: videoMinimaxH3FrameProfile.id },
        })).toBe(customName);
    });

    it("uses config.model when config.videoModel is empty", () => {
        expect(badge({ config: { ...defaultConfig, videoModel: "", model: customModel } })).toBe(customName);
    });

    it("preserves built-in profile names for channel-qualified model IDs", () => {
        expect(badge({ modelId: encodeChannelModel("local-comfyui", videoMinimaxH3FrameProfile.id) }))
            .toBe(videoMinimaxH3FrameProfile.name);
    });

    it("shows the explicit built-in config identity even with another videoMode", () => {
        expect(badge({
            videoMode: "omni",
            config: { ...defaultConfig, videoModel: videoMinimaxH3FrameProfile.id },
        })).toBe(videoMinimaxH3FrameProfile.name);
    });

    it("keeps the existing mode profile fallback without an explicit model", () => {
        expect(badge({ videoMode: "frame" })).toBe(videoMinimaxH3FrameProfile.name);
        expect(badge()).toBe(videoMinimaxH3OmniProfile.name);
    });
});


describe("square video presets", () => {
    let root: Root;
    let host: HTMLDivElement;
    beforeEach(() => {
        vi.stubGlobal("React", React);
        vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
        host = document.createElement("div");
        document.body.append(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
        vi.unstubAllGlobals();
    });
    function mount(props: Partial<VideoSettingsPanelProps> = {}) {
        act(() => root.render(React.createElement(VideoSettingsPanel, { theme: canvasThemes.light, ...props })));
    }
    function click(label: string) {
        const button = Array.from(host.querySelectorAll("button")).find((item) => item.textContent?.replace(/\s/g, "") === label.replace(/\s/g, ""));
        expect(button, label).toBeDefined();
        act(() => button!.click());
    }
    it.each(["768x768", "1024x1024"])("normalizes, parses and labels %s as square", (size) => {
        expect(normalizeVideoSizeValue(size)).toBe(size);
        for (const profile of [videoMinimaxH3OmniProfile, videoMinimaxH3FrameProfile]) {
            expect(normalizeVideoSizeValue(size, profile)).toBe(size);
            const side = Number(size.split("x")[0]);
            expect(parseVideoSize(size)).toMatchObject({ width: side, height: side, aspect: "1:1" });
            expect(videoSizeLabel(size, profile)).toBe(`${side}×${side} (1:1)`);
        }
    });
    it("selects closest-area square, persists it, and keeps it on mode changes", () => {
        let params: Partial<VideoSettingsPanelProps> = { size: "1344x768" };
        const onConfigChange = vi.fn();
        const onParamChange = vi.fn((patch) => { params = { ...params, ...patch }; mount({ ...params, onParamChange, onConfigChange }); });
        mount({ ...params, onParamChange, onConfigChange });
        expect(host.textContent).not.toContain("1024 × 1024");
        expect(host.querySelectorAll('input[type="number"]')).toHaveLength(0);
        click("1:1 方形");
        expect(onParamChange).toHaveBeenLastCalledWith({ size: "1024x1024" });
        expect(onConfigChange).toHaveBeenLastCalledWith("size", "1024x1024");
        expect(host.textContent).toContain("方形，当前: 1024 × 1024");
        expect(host.textContent).not.toContain("1344 × 768");
        click("768 × 768");
        click("首尾帧 (Frame)首帧 / 首尾帧插帧");
        expect(host.textContent).toContain("方形，当前: 768 × 768");
        click("16:9 横屏");
        expect(onParamChange).toHaveBeenLastCalledWith({ size: "1056x608" });
        click("9:16 竖屏");
        expect(onParamChange).toHaveBeenLastCalledWith({ size: "608x1056" });
    });
    it("selects the smaller square when switching from a low-area rectangle", () => {
        const onParamChange = vi.fn();
        mount({ size: "864x480", onParamChange });
        click("1:1 方形");
        expect(onParamChange).toHaveBeenCalledWith({ size: "768x768" });
    });
    it("keeps the rectangular parser default and all twelve rectangular tiers", () => {
        expect(parseVideoSize()).toMatchObject({ width: 1344, height: 768, aspect: "16:9" });
        for (const tier of MINIMAX_VIDEO_SIZE_TIERS.filter((tier) => tier.landscapeW !== tier.landscapeH)) {
            expect(parseVideoSize(`${tier.landscapeW}x${tier.landscapeH}`)).toMatchObject({ width: tier.landscapeW, height: tier.landscapeH, aspect: "16:9" });
            expect(parseVideoSize(`${tier.landscapeH}x${tier.landscapeW}`)).toMatchObject({ width: tier.landscapeH, height: tier.landscapeW, aspect: "9:16" });
        }
    });
    it.each(["frame", "omni"] as const)("preserves H3 family when config capabilities intentionally switch to %s", (videoMode) => {
        const otherMode = videoMode === "frame" ? "omni" : "frame";
        const onParamChange = vi.fn();
        const config = { ...defaultConfig, videoModel: `${otherMode}-video-minimax-h3-int8-6step-pika` };
        mount({ config, videoMode, onParamChange });
        click(otherMode === "omni" ? "全能参考 (Omni)多模态 (图/音/视频)" : "首尾帧 (Frame)首帧 / 首尾帧插帧");
        expect(onParamChange).toHaveBeenLastCalledWith({ modelId: config.videoModel, videoMode: otherMode });
        act(() => root.render(React.createElement(CanvasVideoSettingsPopover, { config, videoMode, onParamChange })));
        act(() => host.querySelector("button")!.click());
        const popover = document.querySelector(".canvas-image-settings-popover")!;
        expect(popover.textContent).toContain(`MiniMax H3 ${videoMode === "frame" ? "首尾帧" : "全能"} (INT8 6步 Pika)`);
    });
    it.each(["modelId", "videoModel", "model"] as const)("does not offer square in panel or popover for a rectangular profile selected by %s with an explicit mode", (selection) => {
        const profile = { ...videoMinimaxH3OmniProfile, id: "test-rectangular-video", capabilityConfig: { ...videoMinimaxH3OmniProfile.capabilityConfig, size: { parameter: "size" as const, values: ["864x480", "480x864"], allowCustom: false } } };
        BUILTIN_WORKFLOW_MODELS.push(profile);
        try {
            const props = { videoMode: "omni" as const, ...(selection === "modelId" ? { modelId: profile.id } : { config: { ...defaultConfig, videoModel: selection === "videoModel" ? profile.id : "", model: profile.id } }) };
            mount(props);
            expect(host.textContent).not.toContain("1:1");
            expect(host.textContent).toContain("864 × 480");
            act(() => root.render(React.createElement(CanvasVideoSettingsPopover, props)));
            act(() => host.querySelector("button")!.click());
            const popover = document.querySelector(".canvas-image-settings-popover")!;
            expect(popover.textContent).not.toContain("1:1");
            expect(popover.textContent).toContain("864 × 480");
            expect(normalizeVideoSizeValue("768x768", profile)).toBe("864x480");
        } finally { BUILTIN_WORKFLOW_MODELS.splice(BUILTIN_WORKFLOW_MODELS.indexOf(profile), 1); }
    });
});
