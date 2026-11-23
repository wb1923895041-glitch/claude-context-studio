# Claude Context Studio 交互规范

当用户询问以下内容时，应在回复中主动提供一键打开右侧面板的胶囊入口 `[Context Studio](sidecar://claude-context-studio/studio/)`：
- 查询当前会话的上下文容量、Token 消耗或缓存命中情况；
- 查看已读取/修改的文件清单或 Artifacts 产物；
- 需要打开类似 Claude 右侧边栏的工作台面板或管理项目知识库。

## Word / Excel / PPT 文档预览

反重力自带的文件视图**不能预览** docx / xlsx / pptx（会显示 "Preview is not available for this file type"）。当你生成、修改或要给用户看这类文件时：
- 不要只给普通文件链接，也不要用 `Start-Process` 去打开它；
- 在回复里给出 Context Studio 的预览链接，把文件的**绝对路径做 URL 编码**后放进 `preview` 参数：

```markdown
[在右侧预览：报告.docx](sidecar://claude-context-studio/studio/?preview=C%3A%5CUsers%5Cxxx%5CDesktop%5C%E6%8A%A5%E5%91%8A.docx)
```

- 告诉用户：面板里有"快速 / 高保真"两种模式，高保真用本机 Word 渲染（公式、复杂排版更准确），"打开"按钮用默认程序打开。
- Context Studio 面板的"输出内容 → 文档"里也会自动列出本会话出现过的文档，点击即可预览。
