# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). It exercises the live HTTP API exactly as the
# browser does, including server-side totals, tenant isolation and permission checks.
#
#   powershell -File apps/api/scripts/smoke-purchase-orders.ps1
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
function Pj([string]$uri, $body, $headers) {
  Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json'
}
function Gj([string]$uri, $headers) { Invoke-RestMethod -Uri $uri -Method Get -Headers $headers }
function Pch([string]$uri, $body, $headers) {
  Invoke-RestMethod -Uri $uri -Method Patch -Headers $headers -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json'
}
function DelReq([string]$uri, $headers) { Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers }
function ExpectError([string]$method, [string]$uri, $body, $headers) {
  try {
    if ($method -eq 'GET') { Invoke-RestMethod -Uri $uri -Method Get -Headers $headers | Out-Null }
    elseif ($method -eq 'DELETE') { Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers | Out-Null }
    elseif ($method -eq 'PATCH') { Invoke-RestMethod -Uri $uri -Method Patch -Headers $headers -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json' | Out-Null }
    else { Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json' | Out-Null }
    return @{ status = 200; body = '' }
  } catch {
    $status = 0
    if ($_.Exception.Response -ne $null) { $status = [int]$_.Exception.Response.StatusCode }
    $message = ''
    if ($_.ErrorDetails -ne $null) { $message = [string]$_.ErrorDetails.Message }
    return @{ status = $status; body = $message }
  }
}


Write-Host "`n=== purchase orders API smoke test ===" -ForegroundColor Cyan
$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$H = @{ Authorization = "Bearer $($login.data.token)" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)

# --- fixtures -------------------------------------------------------------
$supplier = (Pj "$base/suppliers" @{ name = "Smoke Supplier $slug"; email = "s.$slug@example.com" } $H).data
$product = (Pj "$base/products" @{ name = "Smoke Product $slug"; sku = "SMK-$slug"; productType = 'PHYSICAL'; costPrice = 100; sellingPrice = 150 } $H).data
$warehouse = @((Gj "$base/org/warehouses" $H).data)[0]
Check 'fixtures created' ($null -ne $supplier.id -and $null -ne $product.id -and $null -ne $warehouse.id) "supplier=$($supplier.id) product=$($product.id)"

# --- create ---------------------------------------------------------------
$createBody = @{
  supplierId = $supplier.id
  warehouseId = $warehouse.id
  expectedDate = (Get-Date).AddDays(7).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  notes = "Smoke run $slug"
  items = @(@{ productId = $product.id; quantity = 2; unitPrice = 150 })
  # deliberately wrong money fields: the server must ignore them
  subtotal = 999999
  totalAmount = 999999
  taxTotal = 999999
}
$po = (Pj "$base/purchase-orders" $createBody $H).data
Check 'create returns a purchase order' ($null -ne $po.id) "id=$($po.id)"
Check 'poNumber matches PO-YYMM-XXXX' ($po.poNumber -match '^PO-\d{4}-[A-F0-9]{4}$') "poNumber=$($po.poNumber)"
Check 'new order starts as DRAFT' ($po.status -eq 'DRAFT') "status=$($po.status)"
Check 'line total is computed server side' ($po.items[0].lineTotal -eq 300) "lineTotal=$($po.items[0].lineTotal)"
Check 'subtotal ignores the client value' ($po.subtotal -eq 300) "subtotal=$($po.subtotal)"
Check 'total ignores the client value' ($po.totalAmount -eq 300) "total=$($po.totalAmount)"
Check 'tax defaults to zero' ($po.taxRate -eq 0 -and $po.taxTotal -eq 0)
Check 'currency falls back to the organization' ($po.currency -match '^[A-Z]{3}$') "currency=$($po.currency)"
Check 'notes are stored' ($po.notes -eq "Smoke run $slug")
Check 'expected date is stored' ($null -ne $po.expectedDate)
Check 'receiving warehouse is attached' ($po.warehouse.id -eq $warehouse.id) "warehouse=$($po.warehouse.name)"
Check 'author is recorded' ($null -ne $po.createdBy) "createdBy=$($po.createdBy.name)"
Check 'supplier is included' ($po.supplier.id -eq $supplier.id)

# tax is derived from the rate, never accepted as an amount
$taxed = (Pj "$base/purchase-orders" @{ supplierId = $supplier.id; taxRate = 16; items = @(@{ productId = $product.id; quantity = 3; unitPrice = 99.99 }) } $H).data
Check 'tax is calculated from the rate' ($taxed.taxTotal -eq 48.00 -and $taxed.totalAmount -eq 347.97) "subtotal=$($taxed.subtotal) tax=$($taxed.taxTotal) total=$($taxed.totalAmount)"

# --- list ----------------------------------------------------------------
$list = Gj "$base/purchase-orders?limit=200" $H
$row = @($list.data | Where-Object { $_.id -eq $po.id })[0]
Check 'list includes the order' ($null -ne $row)
Check 'list carries the item count' ($row._count.items -eq 1) "count=$($row._count.items)"
Check 'list reports status counts' ($null -ne $list.meta.byStatus.DRAFT) "drafts=$($list.meta.byStatus.DRAFT)"

$byStatus = Gj "$base/purchase-orders?status=DRAFT&limit=200" $H
Check 'status filter returns drafts' (@($byStatus.data | Where-Object { $_.status -eq 'DRAFT' }).Count -ge 1)
$sentOnly = Gj "$base/purchase-orders?status=SENT&limit=200" $H
Check 'status filter excludes other states' (@($sentOnly.data | Where-Object { $_.id -eq $po.id }).Count -eq 0)

$byNumber = Gj "$base/purchase-orders?search=$($po.poNumber)" $H
Check 'search by po number works' (@($byNumber.data | Where-Object { $_.id -eq $po.id }).Count -eq 1)
$bySupplier = Gj "$base/purchase-orders?search=Smoke%20Supplier" $H
Check 'search by supplier name works' (@($bySupplier.data | Where-Object { $_.id -eq $po.id }).Count -eq 1)
$noMatch = Gj "$base/purchase-orders?search=zzzznotapozzzz" $H
Check 'search with no match returns empty' ($noMatch.meta.total -eq 0)
$bySupplierId = Gj "$base/purchase-orders?supplierId=$($supplier.id)" $H
Check 'filter by supplier works' (@($bySupplierId.data | Where-Object { $_.id -eq $po.id }).Count -eq 1)

# --- detail --------------------------------------------------------------
$detail = Gj "$base/purchase-orders/$($po.id)" $H
Check 'detail includes lines and product' ($detail.data.items[0].product.id -eq $product.id)
$unknown = ExpectError 'GET' "$base/purchase-orders/00000000-0000-0000-0000-000000000000" $null $H
Check 'unknown order is 404' ($unknown.status -eq 404) "status=$($unknown.status)"

# --- update a draft ------------------------------------------------------
$patched = Pch "$base/purchase-orders/$($po.id)" @{ items = @(@{ productId = $product.id; quantity = 4; unitPrice = 125.50 }); notes = 'Patched by smoke' } $H
Check 'updating lines recomputes the totals' ($patched.data.subtotal -eq 502.00 -and $patched.data.totalAmount -eq 502.00) "subtotal=$($patched.data.subtotal)"
Check 'the old line is replaced, not appended' (@($patched.data.items).Count -eq 1) "items=$(@($patched.data.items).Count)"
Check 'notes are updated' ($patched.data.notes -eq 'Patched by smoke')
Check 'updatedAt is present' ($null -ne $patched.data.updatedAt)

$emptyItems = ExpectError 'PATCH' "$base/purchase-orders/$($po.id)" @{ items = @() } $H
Check 'patch with no lines is rejected' ($emptyItems.status -eq 400) "status=$($emptyItems.status)"
$zeroQty = ExpectError 'PATCH' "$base/purchase-orders/$($po.id)" @{ items = @(@{ productId = $product.id; quantity = 0; unitPrice = 10 }) } $H
Check 'zero quantity is rejected with 400' ($zeroQty.status -eq 400) "status=$($zeroQty.status)"

# --- lifecycle -----------------------------------------------------------
$sent = Pj "$base/purchase-orders/$($po.id)/send" @{} $H
Check 'send moves the order to SENT' ($sent.data.status -eq 'SENT') "status=$($sent.data.status)"
Check 'send stamps sentAt' ($null -ne $sent.data.sentAt)
$resend = ExpectError 'POST' "$base/purchase-orders/$($po.id)/send" @{} $H
Check 'sending twice is rejected with 409' ($resend.status -eq 409) "status=$($resend.status)"
$locked = ExpectError 'PATCH' "$base/purchase-orders/$($po.id)" @{ notes = 'too late' } $H
Check 'a sent order cannot be edited (409)' ($locked.status -eq 409 -and $locked.body -match 'PO_LOCKED') "status=$($locked.status) body=$($locked.body)"
$deleteSent = ExpectError 'DELETE' "$base/purchase-orders/$($po.id)" $null $H
Check 'a sent order cannot be deleted (409)' ($deleteSent.status -eq 409) "status=$($deleteSent.status)"

# --- cancel --------------------------------------------------------------
$cancelTarget = (Pj "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = $product.id; quantity = 1; unitPrice = 20 }) } $H).data
$cancelled = Pj "$base/purchase-orders/$($cancelTarget.id)/cancel" @{} $H
Check 'a draft can be cancelled' ($cancelled.data.status -eq 'CANCELLED') "status=$($cancelled.data.status)"
$recancel = ExpectError 'POST' "$base/purchase-orders/$($cancelTarget.id)/cancel" @{} $H
Check 'cancelling twice is rejected with 409' ($recancel.status -eq 409) "status=$($recancel.status)"
$removeCancelled = DelReq "$base/purchase-orders/$($cancelTarget.id)" $H
Check 'a cancelled order can be deleted' ($removeCancelled.data.deleted -eq $true)

# --- tenant isolation ---------------------------------------------------
$tenant = Pj "$base/auth/register" @{ name = 'Tenant C'; email = "tc.$slug@kazios.dev"; password = 'tenantC123'; organizationName = "Tenant $slug"; country = 'KE'; currency = 'KES'; timezone = 'Africa/Nairobi' } $null
$TH = @{ Authorization = "Bearer $($tenant.data.token)" }
$crossRead = ExpectError 'GET' "$base/purchase-orders/$($po.id)" $null $TH
Check 'cross tenant read is 404' ($crossRead.status -eq 404) "status=$($crossRead.status)"
$crossSend = ExpectError 'POST' "$base/purchase-orders/$($po.id)/send" @{} $TH
Check 'cross tenant send is blocked' ($crossSend.status -eq 404) "status=$($crossSend.status)"
$crossList = Gj "$base/purchase-orders?limit=200" $TH
Check 'cross tenant list does not leak orders' (@($crossList.data | Where-Object { $_.id -eq $po.id }).Count -eq 0)
$crossCreate = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = $product.id; quantity = 1; unitPrice = 5 }) } $TH
Check 'cross tenant create with a foreign supplier is blocked' ($crossCreate.status -eq 400) "status=$($crossCreate.status)"

# --- permissions --------------------------------------------------------
$roles = @((Gj "$base/roles" $H).data)
$viewerRole = $roles | Where-Object { $_.name -eq 'PO Viewer Smoke' } | Select-Object -First 1
if ($null -eq $viewerRole) {
  $viewerRole = (Pj "$base/roles" @{ name = 'PO Viewer Smoke'; type = 'CUSTOM'; permissions = @('purchasing.view') } $H).data
}
$viewerEmail = "poviewer.$slug@kazios.dev"
$users = @((Gj "$base/users" $H).data)
if (($users | Where-Object { $_.email -eq $viewerEmail }).Count -eq 0) {
  Pj "$base/users" @{ name = 'PO Viewer'; email = $viewerEmail; password = 'viewer123'; roleId = $viewerRole.id } $H | Out-Null
}
$viewerLogin = Pj "$base/auth/login" @{ email = $viewerEmail; password = 'viewer123' } $null
$VH = @{ Authorization = "Bearer $($viewerLogin.data.token)" }
$viewOk = Gj "$base/purchase-orders?limit=5" $VH
Check 'purchasing.view can read orders' ($null -ne $viewOk.data)
$denied = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = $product.id; quantity = 1; unitPrice = 5 }) } $VH
Check 'purchasing.view cannot create (403)' ($denied.status -eq 403) "status=$($denied.status)"

# --- cleanup ------------------------------------------------------------
$removedTaxed = DelReq "$base/purchase-orders/$($taxed.id)" $H
Check 'draft cleanup works' ($removedTaxed.data.deleted -eq $true)
$kept = ExpectError 'DELETE' "$base/purchase-orders/$($po.id)" $null $H
Check 'a sent order stays for the record' ($kept.status -eq 409) "status=$($kept.status)"

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }

$negPrice = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = $product.id; quantity = 1; unitPrice = -5 }) } $H
Check 'negative price is rejected with 400' ($negPrice.status -eq 400) "status=$($negPrice.status)"
$badRate = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; taxRate = 101; items = @(@{ productId = $product.id; quantity = 1; unitPrice = 5 }) } $H
Check 'tax rate above 100 is rejected' ($badRate.status -eq 400) "status=$($badRate.status)"
$badProduct = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = '00000000-0000-0000-0000-000000000000'; quantity = 1; unitPrice = 5 }) } $H
Check 'unknown product is rejected with 400' ($badProduct.status -eq 400) "status=$($badProduct.status)"
$dupe = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = $product.id; quantity = 1; unitPrice = 5 }, @{ productId = $product.id; quantity = 2; unitPrice = 6 }) } $H
Check 'the same product twice is rejected' ($dupe.status -eq 400 -and $dupe.body -match 'DUPLICATE_PRODUCT') "status=$($dupe.status) body=$($dupe.body)"
$noItems = ExpectError 'POST' "$base/purchase-orders" @{ supplierId = $supplier.id; items = @() } $H
Check 'an order with no lines is rejected' ($noItems.status -eq 400) "status=$($noItems.status)"
