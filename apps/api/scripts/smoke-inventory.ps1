# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). It exercises the live HTTP API exactly as the
# browser does, including tenant isolation and permission checks.
#
#   powershell -File apps/api/scripts/smoke-inventory.ps1
#
# Optional overrides:
#   KAZIOS_API_URL        default http://localhost:4000/api/v1
#   KAZIOS_SMOKE_EMAIL    default admin@kazios.dev (the public demo seed account)
#   KAZIOS_SMOKE_PASSWORD default admin123

$base = if ($env:KAZIOS_API_URL) { $env:KAZIOS_API_URL } else { 'http://localhost:4000/api/v1' }
$healthUrl = $base -replace '/api/v\d+$', '/health'
try { Invoke-RestMethod $healthUrl -TimeoutSec 5 | Out-Null }
catch { Write-Host "API not reachable at $healthUrl - start it with 'npm run dev:api' first." -ForegroundColor Red; exit 1 }
$email = if ($env:KAZIOS_SMOKE_EMAIL) { $env:KAZIOS_SMOKE_EMAIL } else { 'admin@kazios.dev' }
$password = if ($env:KAZIOS_SMOKE_PASSWORD) { $env:KAZIOS_SMOKE_PASSWORD } else { 'admin123' }
$ErrorActionPreference = 'Stop'
$script:pass = 0
$script:fail = 0

function Check([string]$name, [bool]$ok, [string]$detail = '') {
  if ($ok) { $script:pass++; Write-Host "  PASS  $name" -ForegroundColor Green }
  else { $script:fail++; Write-Host "  FAIL  $name   $detail" -ForegroundColor Red }
}

function PostJson([string]$uri, $body, $headers) {
  Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json'
}
function GetJson([string]$uri, $headers) {
  Invoke-RestMethod -Uri $uri -Method Get -Headers $headers
}
function ExpectError([string]$method, [string]$uri, $body, $headers) {
  try {
    if ($method -eq 'GET') { Invoke-RestMethod -Uri $uri -Method Get -Headers $headers | Out-Null }
    else { Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json' | Out-Null }
    return @{ status = 200; body = '' }
  } catch {
    $status = 0
    if ($_.Exception.Response -ne $null) { $status = [int]$_.Exception.Response.StatusCode }
    $message = ''
    if ($_.ErrorDetails -ne $null) { $message = [string]$_.ErrorDetails.Message }
    return @{ status = $status; body = $message }
  }
}

Write-Host "`n=== KaziOS inventory smoke test ===" -ForegroundColor Cyan

$login = PostJson "$base/auth/login" @{ email = $email; password = $password } $null
$token = $login.data.token
Check 'login returns a session token' ($null -ne $token -and $token.Length -gt 10)
$H = @{ Authorization = "Bearer $token" }

$warehouses = @((GetJson "$base/org/warehouses" $H).data)
if ($warehouses.Count -lt 2) {
  $created = PostJson "$base/org/warehouses" @{ name = 'Annex Warehouse'; code = 'WH-02' } $H
  $warehouses += $created.data
}
Check 'two warehouses are available for transfers' ($warehouses.Count -ge 2) "count=$($warehouses.Count)"
$wh1 = $warehouses[0].id
$wh2 = $warehouses[1].id

$productList = (GetJson "$base/products?limit=100" $H).data
$tracked = $productList | Where-Object { $_.trackStock -eq $true -and $_.productType -ne 'SERVICE' -and $_.productType -ne 'DIGITAL' } | Select-Object -First 1
Check 'a stock-tracked product exists' ($null -ne $tracked)
$product = $tracked.id

Write-Host "`n-- summary and levels" -ForegroundColor Cyan
$summary = (GetJson "$base/inventory/summary" $H).data
Check 'summary exposes totals' ($null -ne $summary.totals)
Check 'summary exposes the organization currency' ([bool]$summary.currency) "currency=$($summary.currency)"
Check 'summary lists the visible warehouses' ($summary.warehouses.Count -ge 2)

$levels = GetJson "$base/inventory?limit=5&status=ALL" $H
Check 'levels endpoint returns rows' ($levels.data.Count -ge 1)
Check 'levels default to organization scope' ($levels.meta.scope -eq 'ORGANIZATION')
$firstRow = $levels.data | Select-Object -First 1
Check 'available equals quantity minus reserved' ([math]::Abs($firstRow.available - ($firstRow.quantity - $firstRow.reserved)) -lt 0.0001)
Check 'status uses canonical values' (@('IN_STOCK', 'LOW_STOCK', 'OUT_OF_STOCK') -contains $firstRow.status)

$whLevels = GetJson "$base/inventory?warehouseId=$wh1&limit=200&status=ALL" $H
Check 'levels scope switches to a single warehouse' ($whLevels.meta.scope -eq 'WAREHOUSE')
Check 'warehouse rows are tagged with the warehouse id' (($whLevels.data | Where-Object { $_.warehouseId -ne $wh1 }).Count -eq 0)
$startRow = $whLevels.data | Where-Object { $_.productId -eq $product } | Select-Object -First 1
$before = 0
if ($null -ne $startRow) { $before = [double]$startRow.quantity }

$filtered = GetJson "$base/inventory?warehouseId=$wh1&status=OUT_OF_STOCK&limit=200" $H
Check 'status filter returns only out of stock rows' (($filtered.data | Where-Object { $_.status -ne 'OUT_OF_STOCK' }).Count -eq 0)

Write-Host "`n-- stock adjustments" -ForegroundColor Cyan
$inc = (PostJson "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 20; reason = 'Smoke test opening balance'; adjustmentType = 'INCREASE' } $H).data
Check 'increase adjustment returns the new level' ($inc.level.quantity -eq ($before + 20)) "before=$before after=$($inc.level.quantity)"
Check 'increase writes a positive ADJUSTMENT movement' ($inc.movement.type -eq 'ADJUSTMENT' -and $inc.movement.quantity -eq 20)
Check 'adjustment reference is auto-generated' ($inc.movement.reference -like 'ADJ-*') "reference=$($inc.movement.reference)"

$dec = (PostJson "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 3; reason = 'Smoke test write-off'; adjustmentType = 'DECREASE' } $H).data
Check 'decrease applies a negative delta' ($dec.movement.quantity -eq -3 -and $dec.level.quantity -eq ($before + 17)) "level=$($dec.level.quantity)"
$sourceAfterAdjust = $dec.level.quantity

$overIssue = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 999999; reason = 'Over-issue attempt'; adjustmentType = 'DECREASE' } $H
Check 'over-issue is rejected with 409' ($overIssue.status -eq 409) "status=$($overIssue.status) body=$($overIssue.body)"
$zero = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 0; reason = 'Zero attempt'; adjustmentType = 'INCREASE' } $H
Check 'zero quantity is rejected with 400' ($zero.status -eq 400) "status=$($zero.status)"
$noReason = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 1; adjustmentType = 'INCREASE' } $H
Check 'missing reason is rejected with 400' ($noReason.status -eq 400) "status=$($noReason.status)"
$unknownId = [guid]::NewGuid().ToString()
$badWarehouse = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $product; warehouseId = $unknownId; quantity = 1; reason = 'Unknown warehouse'; adjustmentType = 'INCREASE' } $H
Check 'unknown warehouse is rejected with 400' ($badWarehouse.status -eq 400) "status=$($badWarehouse.status)"
$badProduct = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $unknownId; warehouseId = $wh1; quantity = 1; reason = 'Unknown product'; adjustmentType = 'INCREASE' } $H
Check 'unknown product is rejected with 400' ($badProduct.status -eq 400) "status=$($badProduct.status)"

Write-Host "`n-- movement ledger" -ForegroundColor Cyan
$movements = GetJson "$base/inventory/movements?productId=$product&limit=20" $H
$adjustmentRows = @($movements.data | Where-Object { $_.type -eq 'ADJUSTMENT' })
Check 'ledger records both adjustments' ($adjustmentRows.Count -ge 2) "rows=$($adjustmentRows.Count)"
Check 'ledger exposes canonical movement types' ($movements.meta.types -contains 'TRANSFER_IN')
$saleFilter = GetJson "$base/inventory/movements?type=SALE&limit=5" $H
Check 'ledger accepts a movement type filter' (($saleFilter.data | Where-Object { $_.type -ne 'SALE' }).Count -eq 0)

Write-Host "`n-- transfers" -ForegroundColor Cyan
$destLevels = GetJson "$base/inventory?warehouseId=$wh2&limit=200&status=ALL" $H
$destRow = $destLevels.data | Where-Object { $_.productId -eq $product } | Select-Object -First 1
$destBefore = 0
if ($null -ne $destRow) { $destBefore = [double]$destRow.quantity }

$transfer = (PostJson "$base/inventory/transfers" @{ sourceWarehouseId = $wh1; destinationWarehouseId = $wh2; productId = $product; quantity = 4; notes = 'Smoke test transfer' } $H).data
Check 'transfer is created PENDING' ($transfer.status -eq 'PENDING')
Check 'transfer reference is auto-generated' ($transfer.reference -like 'TRF-*') "reference=$($transfer.reference)"
Check 'transfer records the creating user' ($null -ne $transfer.createdBy)
$midRow = (GetJson "$base/inventory?warehouseId=$wh1&limit=200&status=ALL" $H).data | Where-Object { $_.productId -eq $product } | Select-Object -First 1
Check 'raising a transfer does not move stock yet' ([double]$midRow.quantity -eq [double]$sourceAfterAdjust) "now=$($midRow.quantity) expected=$sourceAfterAdjust"

$sameWarehouse = ExpectError 'POST' "$base/inventory/transfers" @{ sourceWarehouseId = $wh1; destinationWarehouseId = $wh1; productId = $product; quantity = 1 } $H
Check 'same source and destination is rejected with 400' ($sameWarehouse.status -eq 400) "status=$($sameWarehouse.status)"
$overTransfer = ExpectError 'POST' "$base/inventory/transfers" @{ sourceWarehouseId = $wh1; destinationWarehouseId = $wh2; productId = $product; quantity = 999999 } $H
Check 'transfer above available stock is rejected with 409' ($overTransfer.status -eq 409) "status=$($overTransfer.status) body=$($overTransfer.body)"

$completed = (PostJson "$base/inventory/transfers/$($transfer.id)/complete" @{} $H).data
Check 'complete issues stock from the source' ([double]$completed.source.quantity -eq ([double]$sourceAfterAdjust - 4)) "source=$($completed.source.quantity)"
Check 'complete receives stock at the destination' ([double]$completed.destination.quantity -eq ($destBefore + 4)) "destination=$($completed.destination.quantity)"
Check 'completed transfer is stamped' ($completed.transfer.status -eq 'COMPLETED' -and $null -ne $completed.transfer.completedAt)
$double = ExpectError 'POST' "$base/inventory/transfers/$($transfer.id)/complete" @{} $H
Check 'double completion is rejected with 409' ($double.status -eq 409) "status=$($double.status)"

$pendingTwo = (PostJson "$base/inventory/transfers" @{ sourceWarehouseId = $wh1; destinationWarehouseId = $wh2; productId = $product; quantity = 2 } $H).data
$cancelled = (PostJson "$base/inventory/transfers/$($pendingTwo.id)/cancel" @{} $H).data
Check 'pending transfer can be cancelled' ($cancelled.status -eq 'CANCELLED')
$cancelTwice = ExpectError 'POST' "$base/inventory/transfers/$($pendingTwo.id)/cancel" @{} $H
Check 'cancelling twice is rejected with 409' ($cancelTwice.status -eq 409) "status=$($cancelTwice.status)"
$completeCancelled = ExpectError 'POST' "$base/inventory/transfers/$($pendingTwo.id)/complete" @{} $H
Check 'cancelled transfer cannot be completed' ($completeCancelled.status -eq 409) "status=$($completeCancelled.status)"

$transferList = GetJson "$base/inventory/transfers?status=COMPLETED&limit=20" $H
Check 'transfer list filters by status' (($transferList.data | Where-Object { $_.status -ne 'COMPLETED' }).Count -eq 0)
Check 'transfer list reports the pending count' ($null -ne $transferList.meta.pending) "pending=$($transferList.meta.pending)"
Check 'transfer list filters by warehouse' ((GetJson "$base/inventory/transfers?warehouseId=$wh1&limit=20" $H).data.Count -ge 1)

Write-Host "`n-- permissions" -ForegroundColor Cyan
$anon = ExpectError 'GET' "$base/inventory" $null $null
Check 'unauthenticated requests are rejected with 401' ($anon.status -eq 401) "status=$($anon.status)"

$existingRoles = @((GetJson "$base/roles" $H).data)
$viewerRole = $existingRoles | Where-Object { $_.name -eq 'Stock Viewer Smoke' } | Select-Object -First 1
if ($null -eq $viewerRole) {
  $viewerRole = (PostJson "$base/roles" @{ name = 'Stock Viewer Smoke'; type = 'CUSTOM'; permissions = @('inventory.view') } $H).data
}
$viewerEmail = 'smoke.viewer@kazios.dev'
$existingUsers = @((GetJson "$base/users" $H).data)
if (($existingUsers | Where-Object { $_.email -eq $viewerEmail }).Count -eq 0) {
  PostJson "$base/users" @{ name = 'Smoke Viewer'; email = $viewerEmail; password = 'viewer123'; roleId = $viewerRole.id } $H | Out-Null
}
$viewerLogin = PostJson "$base/auth/login" @{ email = $viewerEmail; password = 'viewer123' } $null
$VH = @{ Authorization = "Bearer $($viewerLogin.data.token)" }
Check 'inventory.view can read stock levels' ($null -ne (GetJson "$base/inventory?limit=5" $VH).data)
Check 'inventory.view can read the summary' ($null -ne (GetJson "$base/inventory/summary" $VH).data.totals)
Check 'inventory.view can read movements' ($null -ne (GetJson "$base/inventory/movements?limit=5" $VH).data)
Check 'inventory.view can read transfers' ($null -ne (GetJson "$base/inventory/transfers?limit=5" $VH).data)
$deniedAdjust = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 1; reason = 'not allowed'; adjustmentType = 'INCREASE' } $VH
Check 'adjusting stock needs inventory.manage (403)' ($deniedAdjust.status -eq 403) "status=$($deniedAdjust.status)"
$deniedTransfer = ExpectError 'POST' "$base/inventory/transfers" @{ sourceWarehouseId = $wh1; destinationWarehouseId = $wh2; productId = $product; quantity = 1 } $VH
Check 'raising a transfer needs inventory.manage (403)' ($deniedTransfer.status -eq 403) "status=$($deniedTransfer.status)"

Write-Host "`n-- tenant isolation" -ForegroundColor Cyan
$tenantPassword = 'tenantB123'
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)
$tenantB = PostJson "$base/auth/register" @{ name = 'Tenant B Owner'; email = "tenant.b.$slug@kazios.dev"; password = $tenantPassword; organizationName = "Tenant B $slug"; country = 'KE'; currency = 'KES'; timezone = 'Africa/Nairobi' } $null
$TH = @{ Authorization = "Bearer $($tenantB.data.token)" }
$tenantLevels = GetJson "$base/inventory?limit=5" $TH
Check 'a new tenant sees an empty stock list' ($tenantLevels.data.Count -eq 0) "rows=$($tenantLevels.data.Count)"
Check 'a new tenant summary has zero units' ((GetJson "$base/inventory/summary" $TH).data.totals.totalUnits -eq 0)
$crossTenant = ExpectError 'POST' "$base/inventory/adjustments" @{ productId = $product; warehouseId = $wh1; quantity = 1; reason = 'cross tenant attempt'; adjustmentType = 'INCREASE' } $TH
Check 'cross-tenant adjustment is rejected with 400' ($crossTenant.status -eq 400) "status=$($crossTenant.status)"
$crossTransfer = ExpectError 'POST' "$base/inventory/transfers" @{ sourceWarehouseId = $wh1; destinationWarehouseId = $wh2; productId = $product; quantity = 1 } $TH
Check 'cross-tenant transfer is rejected with 400' ($crossTransfer.status -eq 400) "status=$($crossTransfer.status)"
$crossComplete = ExpectError 'POST' "$base/inventory/transfers/$($transfer.id)/complete" @{} $TH
Check 'cross-tenant completion cannot see the transfer (404)' ($crossComplete.status -eq 404) "status=$($crossComplete.status)"

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }
