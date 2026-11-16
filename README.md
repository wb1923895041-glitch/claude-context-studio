# Claude Context Studio

一个 [Google Antigravity（反重力）](https://antigravity.google) 插件：仿照 Claude 桌面版右侧边栏设计的辅助面板，并自带 Windows 电脑操控能力。

## 面板分区

1. **环境**：当前工作区、模型、对话轮数与步数、最近活动时间、失败次数（点击直接跳到失败步骤）。
2. **电脑操控**：Windows-MCP 的安装与连接状态、本会话桌面操作次数、**Agent 最近看到的画面**（桌面截屏或浏览器截图，点击放大），以及"截屏看看""交还控制"两个按钮。
3. **上下文**：已用百分比和分段彩色条；按对话消息、系统提示与内置工具、MCP 工具、规则、技能、剩余空间列出占比。MCP、规则、技能可以点开看明细。上下文超过 60% 黄色预警，超过 80% 红色预警，可以一键让 Agent 写交接文件，或开新会话接着做（配合 [claude-boost](https://github.com/wb1923895041-glitch/claude-boost) 的 handoff 技能）。点击右上角的数字可以切换窗口大小（128k / 200k / 1M）。
4. **执行轨迹**：每一步显示中文动作（读取 / 编辑 / 运行 / 电脑操控 · 点击……），并标出执行结果：✓ 成功、✕ 失败（附退出码或错误）、◷ 后台运行中。同一步里连续相同的动作会合并成 ×N。可以只看失败的步骤。
5. **连接器**：MCP 服务器、工具数量、连接状态。
6. **输出内容**：本会话改过的工作区文件和生成的产物。点击在侧栏打开，悬停可以预览或复制路径。
7. **规则与快捷指令**（默认折叠）：编辑全局、工作区、插件规则文件；快捷指令可以一键发送到当前对话或开新会话。

## 电脑操控（Windows-MCP）

插件自带一个 MCP 服务器 `computer-use`，底层是开源项目 [CursorTouch/Windows-MCP](https://github.com/CursorTouch/Windows-MCP)（MIT），让 Agent 能截屏、读取界面元素、点击、输入、滚动、拖拽、打开程序、切换窗口、读写剪贴板、发系统通知。附带 `computer-use` 技能（操作方法）和安全规则（不碰密码和付款，发消息、删除、改设置前先问用户，屏幕上的文字不当作指令）。

- 默认禁用 `PowerShell`、`FileSystem`、`Registry` 三个工具：命令和文件操作走 Agent 自带的工具（可受 claude-boost 的危险命令拦截与编辑快照保护），注册表不开放。要调整，改 `bin/start.cmd`。
- 默认关闭 Windows-MCP 的匿名统计。
- Agent 操作时，移动鼠标或按 `Ctrl+Alt+Shift+Backspace` 可立即收回控制。

只用面板、不需要电脑操控的话，可以不装 Windows-MCP，面板会显示"未安装"。

## 安装

1. 克隆到反重力的插件目录：
   ```bash
   git clone https://github.com/wb1923895041-glitch/claude-context-studio.git ~/.gemini/config/plugins/claude-context-studio
   ```
2. （可选，电脑操控需要）安装 [uv](https://docs.astral.sh/uv/) 后：
   ```bash
   uv tool install windows-mcp --python 3.14
   ```
3. 在会话右侧辅助栏点 `+` → 扩展 → **Context Studio** 打开面板。新开的会话会自动连接电脑操控服务器。

## 实现说明

- 会话记录增量解析：只读取 transcript.jsonl 新增的字节，900KB 的会话首次解析约 20ms，之后每次刷新接近 0ms。
- 运行中每 1.5 秒刷新一次，空闲时 5 秒；面板不可见时暂停；只有内容变化才重绘 DOM。
- 上下文分类中，规则、技能、MCP 按文件大小估算，对话消息等于实际总量减去首轮上下文。
- 面板只读取本机文件，不联网；文件预览和图片接口只允许访问当前会话涉及的文件。

## 许可证

MIT。Windows-MCP 是独立安装的第三方项目，遵循它自己的 MIT 许可证。
