export type GenerationJobStatus = "queued" | "dispatching" | "running" | "succeeded" | "failed" | "interrupted" | "cancelled";
export interface GenerationJob {
    id: string;
    status: GenerationJobStatus;
    workerId?: string;
    createdAt: number;
    updatedAt: number;
    error?: string;
    retryOf?: string;
    progress?: { value?: number; max?: number; node?: string };
    outputs?: { url: string; type?: string; filename: string }[];
}
export interface GenerationQueue {
    offset?: number;
    nextOffset?: number | null;
    jobs: GenerationJob[];
    workers: { id: string; online: boolean; busy?: boolean }[];
}
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const response = await fetch(`/api/generation${path}`, {
        cache: "no-store",
        ...options,
        signal: options.signal ?? AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : data.error?.message || `队列请求失败 (${response.status})`);
    return data;
}
export function getGenerationQueue(signal?: AbortSignal, offset = 0): Promise<GenerationQueue> {
    return request(offset ? `/jobs?offset=${offset}` : "/jobs", { signal });
}
export function changeGenerationJob(id: string, action: "cancel" | "retry"): Promise<{ prompt_id?: string }> {
    return request(`/jobs/${encodeURIComponent(id)}/${action}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    });
}
