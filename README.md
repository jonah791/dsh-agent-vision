# dsh-agent-vision

多模态视觉插件：把本地图片喂给 OpenAI 兼容 VLM（默认 DashScope qwen-vl-max）做读图/描述/双图对比，弥补当前路由无图像输入

## 工具
- `vision_ask`：读一张本地图片并用 VLM 回答（path 绝对路径；question 缺省=详细描述构图/色彩/风格/细节）。返回 {ok, model, answer}。
- `vision_compare`：双图对比：imageA（参照/原图）与 imageB（对照/生成图）一起喂给 VLM，返回异同分析（主体/构图/色彩/风格/细节）。

## 构建与挂载

```sh
pnpm build
# 挂载到 web profile（dsh plugin-manager 或 plugin_mount）
```

组合行 id：`agent-agent-vision`
