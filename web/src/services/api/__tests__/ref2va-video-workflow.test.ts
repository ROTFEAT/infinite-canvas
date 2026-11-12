import { describe, expect, it } from "vitest";
import { createDefaultNodeMetadata } from "@/lib/canvas/canvas-node-factory";
import { CanvasNodeType } from "@/types/canvas";
import { defaultConfig } from "@/stores/use-config-store";
import { BUILTIN_VIDEO_WORKFLOW_MODELS, dispatchComfyuiModelWorkflow, getModelProfile, resolveModelIdFromWorkflowId, resolveVideoModelIdFromWorkflowId, resolveVideoModelIdForMode } from "../models";
import { getWorkflowForModelProfile } from "../comfyui-default-workflows";
import ref2vaJson from "../../../../../Comfy/Comfy-Api/workflows/h3-ref2va-nvfp4-20step.json";

const id = "h3-ref2va-nvfp4-community20";
const name = "H3 REF2VA · 人物多素材参考 · 20步";

describe("REF2VA NVFP4 20-step registration", () => {
    it("resolves the deployed identity and exposes it in the video selector", () => {
        const profile = getModelProfile(id);
        expect(profile).toMatchObject({ id, name, category: "omniVideo", steps: 20 });
        expect(resolveModelIdFromWorkflowId(id)).toBe(id);
        expect(resolveVideoModelIdFromWorkflowId(id)).toBe(id);
        expect(BUILTIN_VIDEO_WORKFLOW_MODELS.find((model) => model.id === id)).toBe(profile);
        expect(profile?.capabilityConfig.references).toMatchObject({ maxImages: 9, maxVideos: 3, maxAudios: 3 });
        expect(profile?.capabilityConfig.size?.values).toHaveLength(24);
    });

    it("preserves REF2VA when choosing its existing omni mode", () => {
        expect(resolveVideoModelIdForMode(id, "omni")).toBe(id);
    });

    it("keeps new canvas video metadata on the selected REF2VA workflow", () => {
        const metadata = createDefaultNodeMetadata(CanvasNodeType.Video, {
            ...defaultConfig,
            channelId: "native",
            channels: [{ id: "native", name: "Native", baseUrl: "http://localhost:8188", apiKey: "", apiFormat: "comfyui", models: [], workflows: [{ id, name, category: "omniVideo", isDefault: true, json: ref2vaJson, createdAt: 0 }] }],
        });
        expect(metadata).toMatchObject({ modelId: id, workflowId: id, videoMode: "omni", size: "1344x768" });
    });

    it("dispatches the fixed REF2VA template with 20 steps and reference sizing", () => {
        const workflow = getWorkflowForModelProfile(id);
        expect(workflow?.json).toEqual(ref2vaJson);
        const dispatched = dispatchComfyuiModelWorkflow(getModelProfile(id)!, workflow!.json, {
            prompt: "人物参考测试", width: 1344, height: 768, duration: 5, seed: 123,
            assetIds: ["person.png"],
        });
        const nodes = Object.values(dispatched) as { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }[];
        expect(nodes.find((node) => node.class_type === "MiniMaxH3ReferenceToVideo")?.inputs.ref_image_size).toBe("match");
        expect(nodes.find((node) => node.class_type === "BasicScheduler")?.inputs.steps).toBe(20);
        expect(nodes.find((node) => node._meta?.title === "ref_image_01")?.inputs.image).toBe("person.png");
        expect(nodes.some((node) => /Lora/i.test(node.class_type))).toBe(false);
        expect(JSON.stringify(dispatched)).toContain("MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors");
    });
});
