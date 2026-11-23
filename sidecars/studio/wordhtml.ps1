param([string]$In, [string]$Out)
# 用本机 Word（或 WPS）把文档另存为网页，作为"高保真"预览。
# $In 是临时副本（不碰用户正在打开的原文件）；只有 Word 里没有别的文档时才退出 Word，避免关掉用户的窗口。
$ErrorActionPreference = 'Stop'
$app = $null
$doc = $null
try {
    try { $app = New-Object -ComObject Word.Application } catch { $app = New-Object -ComObject KWPS.Application }
    try { $app.DisplayAlerts = 0 } catch {}
    try { $app.AutomationSecurity = 3 } catch {}   # 禁用宏
    $doc = $app.Documents.Open($In, $false, $true, $false)
    try { $doc.WebOptions.Encoding = 65001 } catch {}  # UTF-8
    $doc.SaveAs2($Out, 10)                             # wdFormatFilteredHTML
    $doc.Close($false)
    $doc = $null
    'OK'
} finally {
    if ($doc) { try { $doc.Close($false) } catch {} }
    if ($app) {
        try { if ($app.Documents.Count -eq 0) { $app.Quit() } } catch {}
        [void][Runtime.InteropServices.Marshal]::ReleaseComObject($app)
    }
}
