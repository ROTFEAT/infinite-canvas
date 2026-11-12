# 108 的 H3 REF2VA 预设

该预设使用 `MiniMaxH3ReferenceToVideo`：素材用于人物、场景、动作或声音参考，图片不会作为固定首帧。首尾帧任务继续显式选择原 FL2VA 工作流。工作流不会根据输入偷偷切换模型。

## 社区方案与固定依赖

- 权重：[Abiray 的 NVFP4 量化集合](https://huggingface.co/Abiray/Minimax-H3-nvfp4-INT4-INT8-Convrot)，revision `908eccad7e68751190d04c171956f163bfeed741`。
- 文件：`MiniMax_H3_Ref2VA_pruned_nvfp4.safetensors`，12,528,636,866 字节，SHA256 `3e1be702c95bc057c05a7d1867e8aeea33073dcf5743835f2f27f06a2f34c596`。
- 参考连接方式来自 [ComfyUI 官方 R2V 模板](https://github.com/Comfy-Org/workflow_templates/blob/main/templates/video_minimax_h3_r2v.json)。复用已部署的 NVFP4 AWQ 文本编码器、视频 FP16 VAE、音频 FP32 VAE。
- 使用现有 CUDA 13 / Blackwell 原生 NVFP4、CK attention，以及 [Optimization Suite](https://github.com/ByronLeeeee/ComfyUI-MiniMax-H3-Optimization-Suite) 的精确 Fused MLP；不启用常驻显存。20 步 `res_multistep`，不加载蒸馏 LoRA。
- 权重文件大小不是运行显存需求；实际容量由分辨率、时长、参考素材数量和大小共同决定。每个 worker 使用一张 16GB GPU，两张卡分别处理任务。

## 使用

画布视频节点与视频创作台均可选择本预设。新画布视频节点会保留默认 REF2VA 的模型和工作流 ID；已有节点保留旧选择，需要手动切换。

在全能视频模式选择「H3 REF2VA · 人物多素材参考 · 20步」。连接素材并在提示词中指定用途，例如：

> 保留 `<Picture 1>` 中成年人物的脸型、发型和服装。新场景为阳光下的花园，人物站在石凳旁，轻轻挥手并微笑，固定摄影机，中景。不要复制参考图片中的房间和姿势。

多图按连接次序使用 `<Picture 1>`、`<Picture 2>`；视频为 `<Video 1>`，音频为 `<Audio 1>`。有声音的视频会占用一个音频序号，并排在独立参考音频之前。默认参考尺寸 `match` 保持图片比例，不添加首帧补边；更大的参考会增加每一步的计算量。

模板提供 9 图、3 视频、3 音频的原生端口，这些是端口上限，不是 16GB 下任意组合的容量承诺。参考视频应预先转换为 **24fps、2–15 秒**；本模板不转换帧率。音频应搭配图片或视频。建议先用单图、5 秒、768p 验证，再逐步增加素材。质量和人物一致性仍需人工判断。

## 配置迁移与回退

`scripts/upgrade_h3_ref2va.py` 只读入和输出实例配置 envelope，不执行网络写入。它增加独立模型/工作流，保留原工作流 ID 和 JSON。部署者先在服务器完成权重下载与哈希验证，备份当前配置；对最新 GET 返回的 revision 计算迁移结果，再通过 `baseRevision` CAS 提交。冲突时重新读取并审查，不能覆盖旧快照。迁移不设置跨类别的全局 `workflowId`；仅清除旧版激活时强加的 REF 全局值，保留无关的用户选择，节点自身仍固定绑定所选工作流。

模板位于 `Comfy/Comfy-Api/workflows/h3-ref2va-nvfp4-20step.json`。其中 `__upload_required__` 是待上传槽位；必须通过画布绑定并清理未使用分支后提交，不可直接运行未绑定模板。前端实际提交测试覆盖多图保持比例、视频伴音配对、独立音频和空分支清理。

回退时可直接选择保留的 FL2VA 模型。恢复整个实例配置前，应先备份并审查后来用户修改，按最新 revision 提交。容器和配置卷无需删除。

## 已测运行范围

108 的两张 RTX 5070 Ti 上已跑通 20 步、124 帧输出：单图参考 1344×768 约 305 秒，双图参考 864×480 约 104 秒，图片＋24fps 视频伴音＋独立音频参考 864×480 约 117 秒。前两项曾分别在两张卡上并发，采样观测每卡显存峰值约 14.6GiB。音视频完整解码验证通过；这些是小样本运行结果，不能推导任意素材数量、时长或画质保证。
