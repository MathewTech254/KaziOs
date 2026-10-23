$inputPath = "c:\Users\ZBOOK\Documents\KaziOS\apps\api\src\services\aiAssistant.ts"
$lines = Get-Content $inputPath
$result = @()
$skipNext = $false
for ($i = 0; $i -lt $lines.Count; $i++) {
    $line = $lines[$i]
    # Skip the duplicate payment_summary pattern (second occurrence)
    if ($line -match '^\s*\[/b\(summariz') {
        if ($skipNext) {
            $skipNext = $false
            continue
        } else {
            $skipNext = $true
            continue
        }
    }
    $result += $line
}
$result | Set-Content $inputPath
