# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). This is a security regression suite: it proves a
# tenant cannot read, edit, steal or delete another tenant's customers or products.
#
#   powershell -File apps/api/scripts/smoke-tenant-isolation.ps1
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
function ExpectError([string]$method, [string]$uri, $body, $headers) {
  try {
    if ($method -eq 'GET') { Invoke-RestMethod -Uri $uri -Method Get -Headers $headers | Out-Null }
    elseif ($method -eq 'DELETE') { Invoke-RestMethod -Uri $uri -Method Delete -Headers $headers | Out-Null }
    else { Invoke-RestMethod -Uri $uri -Method Patch -Headers $headers -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json' | Out-Null }
    return @{ status = 200; body = '' }
  } catch {
    $status = 0
    if ($_.Exception.Response -ne $null) { $status = [int]$_.Exception.Response.StatusCode }
    $message = ''
    if ($_.ErrorDetails -ne $null) { $message = [string]$_.ErrorDetails.Message }
    return @{ status = $status; body = $message }
  }
}

Write-Host "`n=== tenant isolation smoke test ===" -ForegroundColor Cyan
$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$H = @{ Authorization = "Bearer $($login.data.token)" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)

# --- fixtures in the caller's own organization ----------------------------
$customer = (Pj "$base/customers" @{ name = "Iso Customer $slug"; email = "c.$slug@example.com" } $H).data
$product = (Pj "$base/products" @{ name = "Iso Product $slug"; sku = "ISO-$slug"; productType = 'PHYSICAL'; costPrice = 10; sellingPrice = 20 } $H).data
Check 'fixtures created in the owning org' ($null -ne $customer.id -and $null -ne $product.id)

# --- a second organization, the attacker -----------------------------------
$attacker = Pj "$base/auth/register" @{ name = 'Iso Attacker'; email = "iso.$slug@kazios.dev"; password = 'iso123456'; organizationName = "Iso $slug"; country = 'KE'; currency = 'KES'; timezone = 'Africa/Nairobi' } $null
$TH = @{ Authorization = "Bearer $($attacker.data.token)" }

# --- read must not leak ----------------------------------------------------
$crossList = Gj "$base/customers?limit=200" $TH
$leaked = @($crossList.data | Where-Object { $_.id -eq $customer.id }).Count
Check 'customer list does not leak across orgs' ($leaked -eq 0) "found=$leaked"
$crossRead = ExpectError 'GET' "$base/customers/$($customer.id)" $null $TH
Check 'cross tenant customer read is 404' ($crossRead.status -eq 404) "status=$($crossRead.status)"

# --- the exploit this suite exists for -------------------------------------
$steal = ExpectError 'PATCH' "$base/customers/$($customer.id)" @{ name = "STOLEN $slug" } $TH
Check 'cross tenant customer update is blocked' ($steal.status -eq 404) "status=$($steal.status) body=$($steal.body)"

$stillMine = Gj "$base/customers/$($customer.id)" $H

# --- delete must not cross tenants -----------------------------------------
$crossDelete = ExpectError 'DELETE' "$base/customers/$($customer.id)" $null $TH
Check 'cross tenant customer delete is blocked' ($crossDelete.status -eq 404) "status=$($crossDelete.status)"

# --- products carry the same rule -------------------------------------------
$crossProdPatch = ExpectError 'PATCH' "$base/products/$($product.id)" @{ name = "STOLEN $slug" } $TH
Check 'cross tenant product update is blocked' ($crossProdPatch.status -eq 404) "status=$($crossProdPatch.status)"
$crossProdDelete = ExpectError 'DELETE' "$base/products/$($product.id)" $null $TH
Check 'cross tenant product delete is blocked' ($crossProdDelete.status -eq 404) "status=$($crossProdDelete.status)"
$prodIntact = Gj "$base/products/$($product.id)" $H
Check 'the owner still sees the original product name' ($prodIntact.data.name -eq "Iso Product $slug") "name=$($prodIntact.data.name)"

# --- the owner can still do their own work ---------------------------------
$ownPatch = Pch "$base/products/$($product.id)" @{ name = "Iso Product $slug renamed" } $H
Check 'own organization can update its product' ($ownPatch.data.name -eq "Iso Product $slug renamed") "name=$($ownPatch.data.name)"
$ownDelete = Invoke-RestMethod -Uri "$base/products/$($product.id)" -Method Delete -Headers $H
Check 'own organization can delete its product' ($ownDelete.data.deleted -eq $true)
$gone = ExpectError 'GET' "$base/products/$($product.id)" $null $H
Check 'the deleted product is gone (404)' ($gone.status -eq 404) "status=$($gone.status)"

$ownCustomerPatch = Pch "$base/customers/$($customer.id)" @{ name = "Iso Customer $slug renamed" } $H
Check 'own organization can update its customer' ($ownCustomerPatch.data.name -eq "Iso Customer $slug renamed")
$ownCustomerDelete = Invoke-RestMethod -Uri "$base/customers/$($customer.id)" -Method Delete -Headers $H
Check 'own organization can delete its customer' ($ownCustomerDelete.data.deleted -eq $true)

# --- unknown ids still behave ----------------------------------------------
$missing = ExpectError 'PATCH' "$base/customers/00000000-0000-0000-0000-000000000000" @{ name = 'nope' } $H
Check 'unknown customer is 404 on update' ($missing.status -eq 404) "status=$($missing.status)"

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }

Check 'the owner still sees the original name' ($stillMine.data.name -eq "Iso Customer $slug") "name=$($stillMine.data.name)"
