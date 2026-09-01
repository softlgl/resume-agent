param(
  [Parameter(Mandatory=$true)][string]$InDocx,
  [Parameter(Mandatory=$true)][string]$OutPdf,
  [int]$ForcePaperSize = 7  # 7 = wdPaperA4 (WdPaperSize)
)
$ErrorActionPreference = "Stop"
$word = $null
$doc  = $null
try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $false
  $word.DisplayAlerts = 0  # wdAlertsNone
  # 显式锁定A4纸：防止 Word 默认打印机（Letter）重分页导致 A4 内容溢出到第 2 页
  if ($ForcePaperSize -gt 0) {
    try { $word.Options.DefaultHighlightColorIndex = 0 } catch {}
  }
  $doc = $word.Documents.Open($InDocx, $false, $true)  # ConfirmConversions=false, ReadOnly=true

  # --- 强制 A4 ---
  try { $doc.PageSetup.PaperSize = $ForcePaperSize } catch {}
  # --- 同时打印调试信息 ---
  Write-Host ("PaperSize=" + $doc.PageSetup.PaperSize)
  Write-Host ("TopMargin=" + $doc.PageSetup.TopMargin + "pt  BottomMargin=" + $doc.PageSetup.BottomMargin + "pt")
  Write-Host ("PageH=" + $doc.PageSetup.PageHeight + "pt  PageW=" + $doc.PageSetup.PageWidth + "pt")
  Write-Host ("Paragraphs=" + $doc.Paragraphs.Count + "  Lines=" + $doc.ComputeStatistics(1))
  # wdStatisticPages = 2
  Write-Host ("PagesCompute=" + $doc.ComputeStatistics(2))

  # wdFormatPDF = 17
  $doc.SaveAs([ref]$OutPdf, [ref]17)
  $doc.Close($false)
  $word.Quit()
} finally {
  if ($doc -ne $null) {
    try { $doc.Close($false) } catch {}
    [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($doc)
  }
  if ($word -ne $null) {
    try { $word.Quit() } catch {}
    [void][System.Runtime.Interopservices.Marshal]::ReleaseComObject($word)
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
