---
name: context-studio
description: Manage and open the Claude Context Studio right-hand auxiliary pane (sidecar://claude-context-studio/studio/) for context window monitoring, active files, artifacts, project knowledge, and previewing Word / Excel / PowerPoint files (docx/xlsx/pptx), which Antigravity's own file view cannot preview. Use when the user wants to see or check an Office document.
---

# Context Studio Skill

Use this skill when the user wants to inspect context usage, token consumption, active files, artifacts, project knowledge/instructions, or open the Claude-style right-hand sidebar panel.

## Quick Open Pill

To let the user open or toggle the right-hand Context Studio panel with one click, output the following markdown link on its own line (or inline where appropriate):

```markdown
[Context Studio](sidecar://claude-context-studio/studio/)
```

## Office 文档预览（docx / xlsx / pptx）

反重力自带的文件视图不能预览 Office 文件。要让用户在右侧看文档时，把文件绝对路径做 URL 编码后放进 `preview` 参数：

```markdown
[在右侧预览：报告.docx](sidecar://claude-context-studio/studio/?preview=<URL 编码后的绝对路径>)
```

可以用这条命令生成编码后的路径：`[uri]::EscapeDataString('C:\path\to\报告.docx')`（PowerShell）。
面板提供"快速"（内置解析，瞬间打开）和"高保真"（本机 Word 渲染，首次约 5～15 秒）两种模式，以及"打开"（默认程序）。

## Persistent Knowledge Data

The panel persists user-pinned context cards and quick prompts at:
`~/.gemini/antigravity/sidecar_data/claude-context-studio/studio/pinned_context.json`

When the user asks to save project architecture notes or reusable prompts into the right-hand knowledge base, you may read or update this JSON file (schema: `{"snippets": [{"id": string, "title": string, "tag": string, "content": string, "updatedAt": string}]}`).
