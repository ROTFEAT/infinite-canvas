# 执行计划

1. web/src/services/api：先写视频参考输入失败用例，补上传前连通性/数量/可读性校验与等比首帧处理，运行针对性Vitest。
2. scripts/upgrade_h3_image_inputs.py：纯配置变换，所有H3文生副本添加可选 ref_image_01，连接 first_frame；单测确保原配置不变、首尾帧保持、重复升级幂等。
3. 审查实际绑定图、提交payload和原有视频工具回归，修复兼容问题。
4. 更新CHANGELOG、pending-test/todo及部署说明，提交tag推送fork分支；仅重建静态前端，服务端配置备份+CAS升级，保留队列数据。
5. 浏览器将一张图片接入现有文生模型并生成视频，核对上传文件尺寸和实际first_frame链路；没有槽位的媒体必须报错。记录证据后报告使用方式与补边限制。
