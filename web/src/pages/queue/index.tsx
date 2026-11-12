import { useEffect, useRef, useState } from "react";
import { Alert, Button, Empty, Progress, Space, Tag, Typography } from "antd";
import { GENERATION_QUEUE_ENABLED } from "@/constant/runtime-config";
import { changeGenerationJob, getGenerationQueue, type GenerationJobStatus, type GenerationQueue } from "@/services/api/generation-queue";

const labels: Record<GenerationJobStatus, string> = {
    queued: "排队中", dispatching: "派发 / 状态核对中", running: "生成中", succeeded: "已完成",
    failed: "失败", interrupted: "已中断", cancelled: "已取消",
};
const active = new Set<GenerationJobStatus>(["queued", "dispatching", "running"]);
const retryable = new Set<GenerationJobStatus>(["failed", "interrupted", "cancelled"]);

export default function QueuePage() {
    const [data, setData] = useState<GenerationQueue>({ jobs: [], workers: [] });
    const [error, setError] = useState("");
    const [loading, setLoading] = useState(true);
    const [pendingAction, setPendingAction] = useState<string>();
    const [offset, setOffset] = useState(0);
    const [refresh, setRefresh] = useState(0);
    const acting = useRef(false);

    useEffect(() => {
        if (!GENERATION_QUEUE_ENABLED) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        const poll = async () => {
            try {
                const snapshot = await getGenerationQueue(AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]), offset);
                if (!controller.signal.aborted) { setData(snapshot); setError(""); }
            } catch (reason) {
                if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "无法连接生成队列");
            } finally {
                if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(poll, 2500); }
            }
        };
        void poll();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [refresh, offset]);

    async function action(id: string, kind: "cancel" | "retry") {
        if (acting.current) return;
        acting.current = true; setPendingAction(id); setError("");
        try {
            await changeGenerationJob(id, kind);
            setOffset(0);
            setRefresh(value => value + 1);
        } catch (reason) { setError(reason instanceof Error ? reason.message : "操作失败，请重试"); }
        finally { acting.current = false; setPendingAction(undefined); }
    }

    if (!GENERATION_QUEUE_ENABLED) return <div className="p-6"><Empty description="当前部署未启用服务端生成队列" /></div>;
    const queued = data.jobs.filter(job => job.status === "queued").length;
    const running = data.jobs.filter(job => job.status === "running" || job.status === "dispatching").length;
    return (
        <main className="h-full overflow-auto p-4 md:p-8">
            <div className="mx-auto max-w-5xl">
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <Typography.Title level={3}>生成队列</Typography.Title>
                        <Typography.Text type="secondary">正在处理 {running} 项 · 等待 {queued} 项。关闭浏览器后，已提交任务继续执行。</Typography.Text>
                    </div>
                    <Button onClick={() => setRefresh(value => value + 1)} loading={loading}>刷新</Button>
                </div>
                <Space wrap className="mb-4">
                    {data.workers.map(worker => <Tag key={worker.id}>{worker.id} · {!worker.online ? "离线" : worker.busy ? "忙碌" : "空闲"}</Tag>)}
                </Space>
                {error && <Alert className="mb-4" type="error" showIcon title={error} />}
                <Typography.Paragraph type="secondary">显示全部未完成任务和最近的任务记录。重试会创建新任务，原记录保留；结果也可在这里打开。画布和素材仍保存在各浏览器。</Typography.Paragraph>
                {!loading && data.jobs.length === 0 && <Empty description="暂无生成任务，请从画布或视频创作台提交" />}
                <Space className="mb-4">
                    <Button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}>较新记录</Button>
                    <span>第 {Math.floor(offset / 100) + 1} 页</span>
                    <Button disabled={data.nextOffset == null} onClick={() => setOffset(data.nextOffset!)}>更早记录</Button>
                </Space>
                <div className="space-y-4">
                    {data.jobs.map(job => {
                        const progress = job.progress;
                        const hasSteps = typeof progress?.value === "number" && typeof progress.max === "number" && progress.max > 0;
                        return <section key={job.id} className="border-b border-current/10 pb-4" aria-label={`任务 ${job.id}`}>
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <Space wrap>
                                    <Typography.Text code title={job.id}>{job.id.slice(0, 12)}</Typography.Text>
                                    <Tag>{labels[job.status]}</Tag>
                                    {job.workerId && <Typography.Text>{job.workerId}</Typography.Text>}
                                    <Typography.Text type="secondary">{new Date(job.createdAt).toLocaleString()}</Typography.Text>
                                </Space>
                                <Space>
                                    {active.has(job.status) && <Button size="small" disabled={!!pendingAction} onClick={() => void action(job.id, "cancel")}>取消</Button>}
                                    {retryable.has(job.status) && <Button size="small" disabled={!!pendingAction} onClick={() => void action(job.id, "retry")}>重试</Button>}
                                </Space>
                            </div>
                            {job.retryOf && <Typography.Text type="secondary">重试来源：{job.retryOf.slice(0, 12)}</Typography.Text>}
                            {active.has(job.status) && progress && <div className="mt-2 max-w-lg">
                                <Typography.Text type="secondary">{progress.node || "当前节点"}{hasSteps ? ` · ${progress.value} / ${progress.max}` : ""}</Typography.Text>
                                {hasSteps && <Progress percent={Math.min(99, Math.round(progress.value! / progress.max! * 100))} showInfo={false} size="small" />}
                            </div>}
                            {job.error && <Typography.Paragraph className="!mt-2 whitespace-pre-wrap break-words" type="danger">{job.error}</Typography.Paragraph>}
                            {!!job.outputs?.length && <Space wrap className="mt-2">
                                {job.outputs.map((output, index) => <a key={`${output.url}-${index}`} href={output.url} target="_blank" rel="noopener noreferrer" className="underline underline-offset-4">打开结果：{output.filename}</a>)}
                            </Space>}
                        </section>;
                    })}
                </div>
            </div>
        </main>
    );
}
