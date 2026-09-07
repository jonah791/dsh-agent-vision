# dsh-agent-vision

> 多模态视觉插件（辅助通道）：VLM 读图 / 描述 / 双图对比。
> DeepSeek Harness 自研插件 · v0.1.0

## 定位

把本地图片喂给 OpenAI 兼容 VLM（默认 qwen3.8-flash）做读图 / 描述 / 双图对比——批量审图、省主会话上下文。主会话「亲眼看图」走官方 `read_image`（原生多模态），本插件是辅助通道。

## 功能特性

- **单图问答**：`vision_ask` 读一张本地图片并用 VLM 回答（question 缺省 = 详细描述构图/色彩/风格/细节）
- **双图对比**：`vision_compare` 参照图 + 生成图一起喂给 VLM，返回异同分析（主体/构图/色彩/风格/细节）
- **省上下文**：批量审图不占主会话 token，结果结构化返回
- **模型可配**：OpenAI 兼容 VLM，默认 qwen3.8-flash

## 安装

```bash
git clone https://github.com/jonah791/dsh-agent-vision.git self-plugins/dsh-agent-vision
cd self-plugins/dsh-agent-vision && pnpm install && pnpm build
```

挂载到 web profile。组合行 id：`agent-agent-vision`。

## 使用（工具面）

| 工具 | 用途 |
|------|------|
| `vision_ask` | 读本地图片 + VLM 回答（path 必填；question 可选） |
| `vision_compare` | 双图对比（imageA 参照 + imageB 对照） |

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `model` | qwen3.8-flash | VLM 模型（OpenAI 兼容） |

## 技术要点

- 辅助通道定位：批量审图/对比用本插件，主会话亲自看图用官方 read_image
- 返回结构化 {ok, model, answer} 便于程序化处理

## License

MIT