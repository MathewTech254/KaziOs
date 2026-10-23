$inputPath = "c:\Users\ZBOOK\Documents\KaziOS\apps\api\src\services\aiAssistant.ts"
$lines = Get-Content $inputPath
$result = @()
$inserted = $false
foreach ($line in $lines) {
    if ($line -match "payment_summary" -and -not $inserted -and $line -match "cash_position") {
        $result += "    [/b(summariz|total|payment|receiv\w*)\b/i, { tool: `"payment_summary`", params: { period: `"today`" } }],"
        $inserted = $true
    }
    $result += $line
}
$result | Set-Content $inputPath
