$inputPath = "c:\Users\ZBOOK\Documents\KaziOS\apps\api\src\services\aiAssistant.ts"
$lines = Get-Content $inputPath
$result = @()
$inserted = $false
foreach ($l in $lines) {
    if ($l -match 'payment_summary') {
        continue
    }
    if ($l -match 'cash_position' -and -not $inserted) {
        $result += "    [/b(summariz|total|payment|receiv\w*)\b/i, { tool: ""payment_summary"", params: { period: ""today"" } }],"
        $inserted = $true
    }
    $result += $l
}
$result | Set-Content $inputPath
