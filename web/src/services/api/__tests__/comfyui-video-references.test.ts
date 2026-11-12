import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { applyVideoBindings, submitComfyuiVideoJob, type ComfyuiVideoRequest, type ComfyuiWorkflowJson } from "../comfyui";
import { defaultConfig, type ModelChannel } from "@/stores/use-config-store";
import { getModelProfile } from "../models";
import fl2Graph from "@/assets/workflows/video_minimax_h3_frame_fp8_20step_api.json";
import ref2vaGraph from "../../../../../Comfy/Comfy-Api/workflows/h3-ref2va-nvfp4-20step.json";
vi.mock("localforage", () => ({ default: { createInstance: () => ({ setItem: vi.fn(), getItem: vi.fn(async () => null) }) } }));
const image = { id: "image", name: "image.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" };
const video = { id: "video", name: "video.mp4", type: "video/mp4", url: "blob:video" };
const graph = (title = "ref_image_01", key = "image"): ComfyuiWorkflowJson => ({ ref: { inputs: { [key]: "old" }, _meta: { title } }, helper: { inputs: { image: ["ref", 0] } }, generate: { inputs: { first_frame: ["helper", 0] } }, out: { inputs: { video: ["generate", 0] }, _meta: { title: "output_video" } } });
function request(json: ComfyuiWorkflowJson = { out: { inputs: {}, _meta: { title: "output_video" } } }): ComfyuiVideoRequest {
    const channel = { id: "c", name: "测试渠道", apiFormat: "comfyui", baseUrl: "", apiKey: "", models: [], comfyuiProxyUrl: "http://test:8188", workflows: [{ id: "custom", name: "custom", category: "omniVideo", json, createdAt: 0 }] } as ModelChannel;
    return { config: { ...defaultConfig, channels: [channel], channelId: "c", videoModel: "custom", size: "1280x736", videoMode: "omni" }, workflowId: "custom", prompt: "video", videoMode: "omni" };
}
let draw: ReturnType<typeof vi.fn>;
let fill: ReturnType<typeof vi.fn>;
beforeEach(() => {
    draw = vi.fn(); fill = vi.fn();
    vi.stubGlobal("Image", class { naturalWidth = 800; naturalHeight = 800; width = 800; height = 800; onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: draw, fillRect: fill } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,Zml0");
    vi.stubGlobal("fetch", vi.fn(async (input) => {
        const url = String(input);
        if (url.startsWith("data:") || url.startsWith("blob:")) return new Response(new Blob(["image"]));
        if (url.endsWith("/upload/image")) return Response.json({ name: "fitted.png" });
        if (url.endsWith("/prompt")) return Response.json({ prompt_id: "job" });
        if (url.endsWith("/system_stats")) return Response.json({ system: { os: "nt" } });
        throw new Error(`Unexpected ${url}`);
    }));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
for (const [name, patch] of [ ["images", { references: [image] }], ["videos", { referenceVideos: [video] }], ["audios", { referenceAudios: [{ ...video, type: "audio/mp3" }] }], ["frame image", { firstFrame: image, videoMode: "frame" }], ["explicit frame in omni", { firstFrame: image }] ] as const) it(`rejects unsupported ${name} before any fetch`, async () => {
    await expect(submitComfyuiVideoJob({ ...request(), ...patch })).rejects.toThrow(/槽位|首尾帧/); expect(fetch).not.toHaveBeenCalled();
});
for (const [name, json] of [ ["dangling loader", { ...graph(), out: { inputs: {}, _meta: { title: "output_video" } } }], ["missing filename input", graph("ref_image_01", "unsupported")], ["missing second slot", graph()] ] as const) it(`rejects ${name} before uploading`, async () => {
    await expect(submitComfyuiVideoJob({ ...request(json), references: name === "missing second slot" ? [image, { ...image, id: "second" }] : [image] })).rejects.toThrow(/槽位/); expect(fetch).not.toHaveBeenCalled();
});
it("rejects blank image data instead of skipping it", async () => {
    await expect(submitComfyuiVideoJob({ ...request(graph()), references: [{ ...image, dataUrl: " " }] })).rejects.toThrow(/参考图.*不可用/); expect(fetch).not.toHaveBeenCalled();
});
for (const [title, patch] of [ ["ref_video_01", { referenceVideos: [{ ...video, url: "" }] }], ["ref_audio_01", { referenceAudios: [{ ...video, url: "", type: "audio/mp3" }] }] ] as const) it(`rejects unavailable ${title} before uploading an earlier valid image`, async () => {
    const json = { ...graph(), media: { inputs: { file: "old" }, _meta: { title } }, generate: { inputs: { first_frame: ["helper", 0], [title]: ["media", 0] } } };
    await expect(submitComfyuiVideoJob({ ...request(json), references: [image], ...patch })).rejects.toThrow(/不可用/); expect(fetch).not.toHaveBeenCalled();
});
for (const title of ["ref_image_01", "first_frame"]) it(`fits the entire ${title} image and binds its value input through helper nodes`, async () => {
    const req = request(graph(title, "value"));
    if (title === "first_frame") { req.videoMode = "frame"; req.firstFrame = image; } else req.references = [image];
    await expect(submitComfyuiVideoJob(req)).resolves.toMatchObject({ jobId: "job" });
    expect(fill).toHaveBeenCalledWith(0, 0, 1280, 736); expect(draw).toHaveBeenCalledWith(expect.anything(), 272, 0, 736, 736);
    expect(fetch).toHaveBeenCalledWith("data:image/png;base64,Zml0");
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const submitted = JSON.parse(String(post[1]?.body)).prompt;
    expect(submitted.ref.inputs).toEqual({ value: "fitted.png" }); expect(submitted.generate.inputs.first_frame).toEqual(["helper", 0]);
});
it("allows prompt-only generation and prunes optional references", async () => {
    await expect(submitComfyuiVideoJob(request(graph()))).resolves.toMatchObject({ jobId: "job" });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    expect(JSON.parse(String(post[1]?.body)).prompt.ref).toBeUndefined();
});
it("rejects an unmarked graph even if a reference feeds an unrelated sink", async () => {
    const json = graph();
    delete (json.out as { _meta?: unknown })._meta;
    await expect(submitComfyuiVideoJob({ ...request(json), references: [image] })).rejects.toThrow(/output_video|槽位/);
    expect(fetch).not.toHaveBeenCalled();
});
it("rejects duplicate reference titles before any upload", async () => {
    const json = { ...graph(), duplicate: { inputs: { image: "old" }, _meta: { title: "ref_image_01" } } };
    await expect(submitComfyuiVideoJob({ ...request(json), references: [image] })).rejects.toThrow(/槽位/);
    expect(fetch).not.toHaveBeenCalled();
});
it("retains an image with the target aspect ratio without padding or re-encoding", async () => {
    vi.stubGlobal("Image", class { naturalWidth = 640; naturalHeight = 368; onload?: () => void; set src(_value: string) { queueMicrotask(() => this.onload?.()); } });
    await expect(submitComfyuiVideoJob({ ...request(graph()), references: [image] })).resolves.toMatchObject({ jobId: "job" });
    expect(draw).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(image.dataUrl);
});
it("rejects a failed image decode before uploading any image", async () => {
    vi.stubGlobal("Image", class { onerror?: () => void; set src(_value: string) { queueMicrotask(() => this.onerror?.()); } });
    await expect(submitComfyuiVideoJob({ ...request(graph()), references: [image] })).rejects.toThrow(/参考图不可用/);
    expect(fetch).not.toHaveBeenCalled();
});
it("keeps frame reference deduplication and fits both first and last images", async () => {
    const json = { ...graph("first_frame"), last: { inputs: { image: "old" }, _meta: { title: "last_frame" } }, generate: { inputs: { first_frame: ["helper", 0], last_frame: ["last", 0] } } };
    const req = { ...request(json), videoMode: "frame", firstFrame: image, references: [image, { ...image, id: "last" }] } as ComfyuiVideoRequest;
    await expect(submitComfyuiVideoJob(req)).resolves.toMatchObject({ jobId: "job" });
    expect(draw).toHaveBeenCalledTimes(2);
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const submitted = JSON.parse(String(post[1]?.body)).prompt;
    expect(submitted.ref.inputs.image).toBe("fitted.png"); expect(submitted.last.inputs.image).toBe("fitted.png");
});
it("blocks upload and prompt when a selected source responds with HTTP 404", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("missing", { status: 404 }));
    const json = graph("ref_video_01", "file");
    await expect(submitComfyuiVideoJob({ ...request(json), referenceVideos: [video] })).rejects.toThrow(/获取参考素材失败.*404/);
    expect(fetch).toHaveBeenCalledTimes(1);
});
it("preserves linked auxiliary inputs when a reference uses the value filename input", async () => {
    const json = graph("ref_image_01", "value");
    (json.ref as { inputs: Record<string, unknown> }).inputs.image = ["aux", 0];
    json.aux = { inputs: { value: "auxiliary" } };
    await expect(submitComfyuiVideoJob({ ...request(json), references: [image] })).resolves.toMatchObject({ jobId: "job" });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    expect(JSON.parse(String(post[1]?.body)).prompt.ref.inputs).toEqual({ value: "fitted.png", image: ["aux", 0] });
});
it("binds generic reference inputs on the registered model dispatcher path", async () => {
    const req = { ...request(graph("ref_image_01", "value")), model: "omni-video-minimax-h3-fp8-4step-pdmd", references: [image] };
    await expect(submitComfyuiVideoJob(req)).resolves.toMatchObject({ jobId: "job" });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    expect(JSON.parse(String(post[1]?.body)).prompt.ref.inputs).toEqual({ value: "fitted.png" });
});
it("rejects a numeric value input masquerading as an image filename slot", async () => {
    const json = graph("ref_image_01", "value");
    (json.ref as { inputs: Record<string, unknown> }).inputs.value = 1;
    await expect(submitComfyuiVideoJob({ ...request(json), references: [image] })).rejects.toThrow(/槽位/);
    expect(fetch).not.toHaveBeenCalled();
});

it("submits two REF2VA images unchanged and prunes every unused reference branch", async () => {
    const second = { ...image, id: "second", dataUrl: "data:image/png;base64,Qg==" };
    let upload = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
        const url = String(input);
        if (url.startsWith("data:")) return new Response(new Blob([url]));
        if (url.endsWith("/upload/image")) return Response.json({ name: `image-${++upload}.png` });
        if (url.endsWith("/prompt")) return Response.json({ prompt_id: "job" });
        if (url.endsWith("/system_stats")) return Response.json({ system: { os: "nt" } });
        throw Error(url);
    });
    await submitComfyuiVideoJob({ ...request(ref2vaGraph), references: [image, second] });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const graph = JSON.parse(String(post[1]?.body)).prompt;
    expect(draw).not.toHaveBeenCalled();
    expect(graph.h3_ref_image_01.inputs.image).toBe("image-1.png");
    expect(graph.h3_ref_image_02.inputs.image).toBe("image-2.png");
    expect(graph["105:104"].inputs["ref_images.ref_image_0"]).toEqual(["h3_ref_image_01", 0]);
    expect(graph["105:104"].inputs["ref_images.ref_image_1"]).toEqual(["h3_ref_image_02", 0]);
    expect(graph["105:104"].inputs.first_frame).toBeUndefined();
    expect(graph.h3_ref_image_03).toBeUndefined();
    expect(graph.h3_ref_video_01_components).toBeUndefined();
    expect(graph.h3_ref_audio_01).toBeUndefined();
    expect(Object.keys(graph["105:104"].inputs).some((key) => key.startsWith("ref_video") || key.startsWith("ref_audio"))).toBe(false);
});

it("keeps a REF2VA video's paired soundtrack and standalone audio on distinct ports", async () => {
    await submitComfyuiVideoJob({ ...request(ref2vaGraph), references: [image], referenceVideos: [video], referenceAudios: [{ ...video, id: "audio", type: "audio/mp3" }] });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const graph = JSON.parse(String(post[1]?.body)).prompt;
    const inputs = graph["105:104"].inputs;
    expect(inputs["ref_videos.ref_video_0"]).toEqual(["h3_ref_video_01_components", 0]);
    expect(inputs["ref_video_audios.ref_video_audio_0"]).toEqual(["h3_ref_video_01_components", 1]);
    expect(inputs["ref_audios.ref_audio_0"]).toEqual(["h3_ref_audio_01", 0]);
    expect(graph.h3_ref_video_02_components).toBeUndefined();
    expect(draw).not.toHaveBeenCalled();
});

it("prunes both unused video ports without removing a helper shared by a live consumer", () => {
    const json = {
        source: { inputs: { file: "shared.mp4" } },
        helper: { inputs: { video: ["source", 0] } },
        generate: { inputs: { "ref_videos.ref_video_0": ["helper", 0], "ref_video_audios.ref_video_audio_0": ["helper", 1] } },
        preview: { inputs: { audio: ["helper", 1] } },
    };
    const result = applyVideoBindings(json, { prompt: "" }) as typeof json;
    expect(result.generate.inputs).toEqual({});
    expect(result.helper).toEqual(json.helper);
    expect(result.source).toEqual(json.source);
    expect(result.preview).toEqual(json.preview);
});

it("preserves components of a live video source when its output uses a higher numbered port", () => {
    const json = {
        source: { inputs: { file: "old.mp4" }, _meta: { title: "ref_video_01" } },
        helper: { class_type: "GetVideoComponents", inputs: { video: ["source", 0] } },
        generate: { inputs: { "ref_videos.ref_video_2": ["helper", 0], "ref_video_audios.ref_video_audio_2": ["helper", 1] } },
    };
    const result = applyVideoBindings(json, { prompt: "", videoAssetIds: ["live.mp4"] }) as typeof json;
    expect(result.source.inputs.file).toBe("live.mp4");
    expect(result.helper).toEqual(json.helper);
    expect(result.generate).toEqual(json.generate);
});

it("submits the registered REF2VA model without changing its fixed native graph", async () => {
    const id = "h3-ref2va-nvfp4-community20";
    expect(getModelProfile(id)?.id).toBe(id);
    await submitComfyuiVideoJob({ ...request(ref2vaGraph), model: id, references: [image] });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const graph = JSON.parse(String(post[1]?.body)).prompt;
    expect(graph["105:104"].class_type).toBe("MiniMaxH3ReferenceToVideo");
    expect(graph["105:104"].inputs.ref_image_size).toBe("match");
    expect(graph["105:9"].inputs.steps).toBe(20);
    expect(graph["105:6"].inputs.unet_name).toBe("MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors");
    expect(graph.h3_ref_video_01_components).toBeUndefined();
    expect(graph.h3_ref_audio_01).toBeUndefined();
    expect(graph.h3_ref_image_01.inputs.image).toBe("fitted.png");
    expect(draw).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(image.dataUrl);
});

for (const includeRefWorkflow of [true, false]) for (const modelInConfig of [true, false]) it(`selects REF2VA independently of the channel default (registered=${includeRefWorkflow}, configModel=${modelInConfig})`, async () => {
    const id = "h3-ref2va-nvfp4-community20";
    const req = request(fl2Graph);
    delete req.workflowId;
    const oldDefault = req.config.channels[0].workflows![0];
    oldDefault.isDefault = true;
    const preferredGraph = structuredClone(ref2vaGraph);
    preferredGraph["92"].inputs.filename_prefix = "chosen-ref-workflow";
    if (includeRefWorkflow) req.config.channels[0].workflows!.push({ ...oldDefault, id, isDefault: false, json: preferredGraph });
    if (modelInConfig) req.config.videoModel = id;
    else req.model = id;
    await submitComfyuiVideoJob({ ...req, references: [image] });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const submitted = JSON.parse(String(post[1]?.body)).prompt;
    expect(submitted["105:104"].class_type).toBe("MiniMaxH3ReferenceToVideo");
    expect(submitted["105:6"].inputs.unet_name).toBe("MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors");
    expect(submitted["105:9"].inputs.steps).toBe(20);
    expect(submitted["92"].inputs.filename_prefix).toBe(includeRefWorkflow ? "chosen-ref-workflow" : "H3/REF2VA_Community20");
    expect(draw).not.toHaveBeenCalled();
});

for (const explicitIdInConfig of [true, false]) it(`rejects an explicit FL2 workflow for REF2VA before uploads (configId=${explicitIdInConfig})`, async () => {
    const req = { ...request(fl2Graph), model: "h3-ref2va-nvfp4-community20" };
    if (explicitIdInConfig) { req.config.workflowId = req.workflowId; delete req.workflowId; }
    await expect(submitComfyuiVideoJob(req)).rejects.toThrow(/REF2VA.*工作流/);
    expect(fetch).not.toHaveBeenCalled();
});

it("honors an explicit custom REF2VA workflow ID instead of replacing it", async () => {
    const json = structuredClone(ref2vaGraph);
    json["92"].inputs.filename_prefix = "custom-reference-workflow";
    await submitComfyuiVideoJob({ ...request(json), model: "h3-ref2va-nvfp4-community20", references: [image] });
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    expect(JSON.parse(String(post[1]?.body)).prompt["92"].inputs.filename_prefix).toBe("custom-reference-workflow");
});

it("rejects a non-NVFP4 checkpoint even with a REF2VA conditioner", async () => {
    const json = structuredClone(ref2vaGraph);
    json["105:6"].inputs.unet_name = "minimax_h3_fl2va_fp8.safetensors";
    await expect(submitComfyuiVideoJob({ ...request(json), model: "h3-ref2va-nvfp4-community20" })).rejects.toThrow(/REF2VA.*工作流/);
    expect(fetch).not.toHaveBeenCalled();
});

it("rejects REF2VA requested in frame mode even without frame inputs", async () => {
    const req = { ...request(ref2vaGraph), model: "h3-ref2va-nvfp4-community20", videoMode: "frame" as const };
    await expect(submitComfyuiVideoJob(req)).rejects.toThrow(/REF2VA.*FL2VA/);
    expect(fetch).not.toHaveBeenCalled();
});

for (const selection of ["model", "workflow", "default"] as const) it(`preserves a shared helper on REF2VA submission selected by ${selection}`, async () => {
    const json = {
        ...structuredClone(ref2vaGraph),
        shared_source: { inputs: { file: "shared.mp4" } },
        shared_helper: { inputs: { video: ["shared_source", 0] } },
        preview: { inputs: { audio: ["shared_helper", 1] } },
    };
    const inputs = json["105:104"].inputs;
    inputs["ref_videos.ref_video_0"] = ["shared_helper", 0];
    inputs["ref_video_audios.ref_video_audio_0"] = ["shared_helper", 1];
    const req = request(json);
    if (selection === "model") req.model = "h3-ref2va-nvfp4-community20";
    else {
        req.config.channels[0].workflows![0].id = "h3-ref2va-nvfp4-community20";
        req.workflowId = selection === "workflow" ? "h3-ref2va-nvfp4-community20" : undefined;
    }
    await submitComfyuiVideoJob(req);
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const submitted = JSON.parse(String(post[1]?.body)).prompt;
    expect(submitted.shared_helper).toEqual(json.shared_helper);
    expect(submitted.shared_source).toEqual(json.shared_source);
    expect(submitted.preview.inputs.audio).toEqual(["shared_helper", 1]);
    expect(submitted["105:104"].inputs["ref_videos.ref_video_0"]).toBeUndefined();
    expect(submitted["105:104"].inputs["ref_video_audios.ref_video_audio_0"]).toBeUndefined();
});

for (const selection of ["model", "workflow", "default"] as const) it(`preserves higher numbered video ports on REF2VA submission selected by ${selection}`, async () => {
    const json = structuredClone(ref2vaGraph);
    const inputs = json["105:104"].inputs as Record<string, unknown>;
    delete inputs["ref_videos.ref_video_0"];
    delete inputs["ref_video_audios.ref_video_audio_0"];
    inputs["ref_videos.ref_video_2"] = ["h3_ref_video_01_components", 0];
    inputs["ref_video_audios.ref_video_audio_2"] = ["h3_ref_video_01_components", 1];
    const req = { ...request(json), referenceVideos: [video] };
    if (selection === "model") req.model = "h3-ref2va-nvfp4-community20";
    else {
        req.config.channels[0].workflows![0].id = "h3-ref2va-nvfp4-community20";
        req.workflowId = selection === "workflow" ? "h3-ref2va-nvfp4-community20" : undefined;
    }
    await submitComfyuiVideoJob(req);
    const post = vi.mocked(fetch).mock.calls.find(([url]) => String(url).endsWith("/prompt"))!;
    const submitted = JSON.parse(String(post[1]?.body)).prompt;
    expect(submitted.h3_ref_video_01_components).toEqual(json.h3_ref_video_01_components);
    expect(submitted["105:104"].inputs["ref_videos.ref_video_2"]).toEqual(["h3_ref_video_01_components", 0]);
    expect(submitted["105:104"].inputs["ref_video_audios.ref_video_audio_2"]).toEqual(["h3_ref_video_01_components", 1]);
});
