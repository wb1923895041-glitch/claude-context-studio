---
name: context-studio
description: Manage and open the Claude Context Studio right-hand auxiliary pane (sidecar://claude-context-studio/studio/) for context window monitoring, active files, artifacts, and project knowledge.
---

# Context Studio Skill

Use this skill when the user wants to inspect context usage, token consumption, active files, artifacts, project knowledge/instructions, or open the Claude-style right-hand sidebar panel.

## Quick Open Pill

To let the user open or toggle the right-hand Context Studio panel with one click, output the following markdown link on its own line (or inline where appropriate):

```markdown
[Context Studio](sidecar://claude-context-studio/studio/)
```

## Persistent Knowledge Data

The panel persists user-pinned context cards and quick prompts at:
`~/.gemini/antigravity/sidecar_data/claude-context-studio/studio/pinned_context.json`

When the user asks to save project architecture notes or reusable prompts into the right-hand knowledge base, you may read or update this JSON file (schema: `{"snippets": [{"id": string, "title": string, "tag": string, "content": string, "updatedAt": string}]}`).
