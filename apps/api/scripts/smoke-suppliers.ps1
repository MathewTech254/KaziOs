# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). It exercises the live HTTP API exactly as the
# browser does, including tenant isolation and permission checks.
#
#   powershell -File apps/api/scripts/smoke-suppliers.ps1
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
  Invoke-RestMethod -Uri $uri -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 6) -ContentType 'application/json'
}
function Gj([string]$uri, $headers) { Invoke-RestMethod -Uri $uri -Method Get -Headers $headers }
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

Write-Host "`n=== suppliers API smoke test ===" -ForegroundColor Cyan
$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$H = @{ Authorization = "Bearer $($login.data.token)" }

$before = (Gj "$base/suppliers?limit=200" $H).meta.total
$name = "Smoke Supplier $([guid]::NewGuid().ToString('N').Substring(0,6))"

$created = Pj "$base/suppliers" @{ name = $name; email = 'buyer@example.com'; phone = '+254700000000'; taxNumber = 'TAX-001'; address = 'Nairobi' } $H
$id = $created.data.id
Check 'create returns the supplier' ($null -ne $id) "id=$id"
Check 'optional fields are stored' ($created.data.email -eq 'buyer@example.com' -and $created.data.taxNumber -eq 'TAX-001')

$list = Gj "$base/suppliers?limit=200" $H
Check 'list includes the new supplier' (@($list.data | Where-Object { $_.id -eq $id }).Count -eq 1)
Check 'list includes a purchase order count' ($null -ne ($list.data | Where-Object { $_.id -eq $id })._count)
Check 'total increased by one' ($list.meta.total -eq ($before + 1)) "before=$before now=$($list.meta.total)"

$search = Gj "$base/suppliers?search=$($name.Substring(0,10))" $H
Check 'search by name matches' ($search.data.Count -ge 1)
$noMatch = Gj "$base/suppliers?search=zzzznotasupplierzzzz" $H
Check 'search with no match returns empty' ($noMatch.data.Count -eq 0 -and $noMatch.meta.total -eq 0)

$updated = Invoke-RestMethod -Uri "$base/suppliers/$id" -Method Patch -Headers $H -Body (@{ phone = '+254711111111' } | ConvertTo-Json) -ContentType 'application/json'
Check 'update changes the field' ($updated.data.phone -eq '+254711111111')

$dup = ExpectError 'POST' "$base/suppliers" @{ name = $name } $H
Check 'duplicate name is rejected with 409' ($dup.status -eq 409) "status=$($dup.status) body=$($dup.body)"
$bad = ExpectError 'POST' "$base/suppliers" @{ name = 'x' } $H
Check 'too short a name is rejected with 400' ($bad.status -eq 400) "status=$($bad.status)"

$detail = Gj "$base/suppliers/$id" $H
Check 'detail includes purchase orders' ($null -ne $detail.data.purchaseOrders)
$missing = ExpectError 'GET' "$base/suppliers/00000000-0000-0000-0000-000000000000" $null $H
Check 'unknown supplier is 404' ($missing.status -eq 404) "status=$($missing.status)"

# tenant isolation: a second organization must not see or touch this supplier
$slug = [guid]::NewGuid().ToString('N').Substring(0,8)
$tenant = Pj "$base/auth/register" @{ name = 'Tenant B'; email = "t.$slug@kazios.dev"; password = 'tenantB123'; organizationName = "Tenant $slug"; country = 'KE'; currency = 'KES'; timezone = 'Africa/Nairobi' } $null
$TH = @{ Authorization = "Bearer $($tenant.data.token)" }
$crossRead = ExpectError 'GET' "$base/suppliers/$id" $null $TH
Check 'cross tenant read is 404' ($crossRead.status -eq 404) "status=$($crossRead.status)"
$crossPatch = ExpectError 'POST' "$base/suppliers/$id" @{} $TH
Check 'cross tenant write is blocked' ($crossPatch.status -in @(400,404,405)) "status=$($crossPatch.status)"
$crossDelete = ExpectError 'POST' "$base/suppliers/$id/delete" @{} $TH
Check 'cross tenant delete is blocked' ($crossDelete.status -in @(400,404,405)) "status=$($crossDelete.status)"
$crossList = Gj "$base/suppliers?limit=200" $TH
Check 'cross tenant list does not leak the supplier' (@($crossList.data | Where-Object { $_.id -eq $id }).Count -eq 0) "count=$($crossList.data.Count)"

# permissions: view only
$roles = @((Gj "$base/roles" $H).data)
$viewerRole = $roles | Where-Object { $_.name -eq 'Supplier Viewer Smoke' } | Select-Object -First 1
if ($null -eq $viewerRole) {
  $viewerRole = (Pj "$base/roles" @{ name = 'Supplier Viewer Smoke'; type = 'CUSTOM'; permissions = @('purchasing.view') } $H).data
}
$viewerEmail = "viewer.$slug@kazios.dev"
$users = @((Gj "$base/users" $H).data)
if (($users | Where-Object { $_.email -eq $viewerEmail }).Count -eq 0) {
  Pj "$base/users" @{ name = 'Supplier Viewer'; email = $viewerEmail; password = 'viewer123'; roleId = $viewerRole.id } $H | Out-Null
}
$viewerLogin = Pj "$base/auth/login" @{ email = $viewerEmail; password = 'viewer123' } $null
$VH = @{ Authorization = "Bearer $($viewerLogin.data.token)" }
$viewOk = Gj "$base/suppliers?limit=5" $VH
Check 'purchasing.view can read suppliers' ($null -ne $viewOk.data)
$denied = ExpectError 'POST' "$base/suppliers" @{ name = "Denied $([guid]::NewGuid().ToString('N').Substring(0,4))" } $VH
Check 'purchasing.view cannot create (403)' ($denied.status -eq 403) "status=$($denied.status)"

# cleanup
$removed = Invoke-RestMethod -Uri "$base/suppliers/$id" -Method Delete -Headers $H
Check 'delete removes the supplier' ($removed.data.deleted -eq $true)
$gone = ExpectError 'GET' "$base/suppliers/$id" $null $H
Check 'deleted supplier is gone (404)' ($gone.status -eq 404) "status=$($gone.status)"

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }
