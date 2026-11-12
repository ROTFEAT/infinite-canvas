import type { ComfyuiWorkflowJson } from "./comfyui";

type Node = { inputs?: Record<string, unknown>; _meta?: { title?: string } };
export type VideoReferenceSlot = { id: string; input: string; title: string; frame: boolean };
const candidates = { image: ["image", "file", "value"], video: ["file", "video", "value"], audio: ["audio", "file", "value"] };

/** Validate the selected slots against the graph that actually produces the output. */
export function getVideoReferenceSlots(workflow: ComfyuiWorkflowJson, titles: string[]): VideoReferenceSlot[] {
    const nodes = workflow as Record<string, Node>;
    const entries = Object.entries(nodes).filter(([, node]) => node && typeof node === "object");
    const consumers = new Map<string, Array<{ id: string; input: string }>>();
    for (const [id, node] of entries) for (const [input, value] of Object.entries(node.inputs || {})) {
        if (!Array.isArray(value) || value.length !== 2 || !nodes[String(value[0])]) continue;
        const source = String(value[0]);
        consumers.set(source, [...(consumers.get(source) || []), { id, input }]);
    }
    const outputs = new Set(entries.filter(([, node]) => node._meta?.title?.trim().toLowerCase() === "output_video").map(([id]) => id));
    if (titles.length && !outputs.size) throw new Error("当前视频工作流缺少 output_video 输出槽位，请为视频保存节点标记 _meta.title = output_video 并连接参考资源后重试");
    const reachesOutput = (id: string, seen = new Set<string>()): boolean => {
        if (seen.has(id)) return false;
        seen.add(id);
        return outputs.has(id) || (consumers.get(id) || []).some((consumer) => reachesOutput(consumer.id, seen));
    };
    const feedsFrame = (id: string, seen = new Set<string>()): boolean => {
        if (seen.has(id)) return false;
        seen.add(id);
        return (consumers.get(id) || []).some((consumer) => reachesOutput(consumer.id) && (["first_frame", "last_frame"].includes(consumer.input) || feedsFrame(consumer.id, seen)));
    };
    return titles.map((title) => {
        const matches = entries.filter(([, node]) => node._meta?.title?.trim().toLowerCase() === title);
        const kind = title.startsWith("ref_video") ? "video" : title.startsWith("ref_audio") ? "audio" : "image";
        const [id, node] = matches[0] || [];
        const input = candidates[kind].find((key) => node?.inputs && typeof node.inputs[key] === "string");
        if (matches.length !== 1 || !input || !consumers.has(id) || !reachesOutput(id)) {
            throw new Error(`当前视频工作流的「${title}」参考槽位缺失、重复、输入不兼容或未连接到输出，请移除对应参考资源，或在工作流中添加该 _meta.title 槽位并连接到视频输出后重试`);
        }
        return { id, input, title, frame: title === "first_frame" || title === "last_frame" || feedsFrame(id) };
    });
}

/** Both legacy dispatchers bind image unconditionally; preserve the workflow's actual input contract. */
export function bindVideoReferenceSlots(workflow: ComfyuiWorkflowJson, original: ComfyuiWorkflowJson, slots: VideoReferenceSlot[], assets: string[]) {
    slots.forEach((slot, index) => {
        const node = workflow[slot.id] as Node | undefined;
        const source = original[slot.id] as Node;
        if (!node?.inputs) throw new Error(`参考槽位「${slot.title}」在绑定时丢失，请检查工作流连线`);
        for (const key of ["image", "file", "video", "audio"]) {
            if (key === slot.input) continue;
            if (key in (source.inputs || {})) node.inputs[key] = structuredClone(source.inputs![key]);
            else delete node.inputs[key];
        }
        node.inputs[slot.input] = assets[index];
    });
}
