@echo off
rem 启动 Windows-MCP（stdio 模式）。优先使用 uv tool 安装的位置，找不到再用 PATH 里的 windows-mcp。
rem 默认禁用 PowerShell / FileSystem / Registry：命令和文件操作走 Agent 自带的工具，注册表不开放。
setlocal
set "ANONYMIZED_TELEMETRY=false"
set "EXE=%USERPROFILE%\.local\bin\windows-mcp.exe"
if not exist "%EXE%" set "EXE=windows-mcp"
"%EXE%" serve --exclude-tools PowerShell,Registry,FileSystem
