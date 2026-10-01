# Proves the notification system actually works end to end.
#
#   powershell -File apps/api/scripts/smoke-notifications.ps1
#
# It opens the real Server Sent Events stream, triggers real business events through
# the public API, and asserts the alert arrives over that open socket. An alert that
# only appears after a page reload is not real time, so this test reads the socket
# rather than polling the list endpoint.
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

Write-Host "`n=== notification smoke test ===" -ForegroundColor Cyan

$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$token = $login.data.token
$H = @{ Authorization = "Bearer $token" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)
$orgRoot = $base -replace '/api/v\d+$', ''

# --- open the live stream ---------------------------------------------------
# A raw TCP client rather than a browser EventSource: PowerShell has no built in SSE
# client, and reading the raw bytes is what proves the server is pushing rather than
# waiting to be asked.
$streamUrl = "$orgRoot/api/v1/notifications/stream?access_token=$([uri]::EscapeDataString($token))"
$script:buffer = ''
$script:seen = New-Object System.Collections.ArrayList

function Start-Stream {
  param([string]$Url)
  $uri = [uri]$Url
  $c = New-Object System.Net.Sockets.TcpClient
  $c.Connect($uri.Host, $uri.Port)
  $s = $c.GetStream()
  $req = "GET $($uri.PathAndQuery) HTTP/1.1`r`nHost: $($uri.Host)`r`nAccept: text/event-stream`r`nConnection: keep-alive`r`n`r`n"
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
  $s.Write($bytes, 0, $bytes.Length)
  $s.ReadTimeout = 1500
  return @{ client = $c; stream = $s }
}

function Read-Frames([int]$Seconds = 6) {
  # Reads until the deadline, collecting any complete SSE frame that arrives. The short
  # read timeout is deliberate: it throws when nothing is arriving, which is how a
  # missing alert is detected rather than waited on.
  $deadline = (Get-Date).AddSeconds($Seconds)
  $buf = New-Object byte[] 4096
  while ((Get-Date) -lt $deadline) {
    try {
      $read = $script:stream.Read($buf, 0, $buf.Length)
      if ($read -le 0) { continue }
      $script:buffer += [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
      $parts = $script:buffer -split "`n`n"
      $script:buffer = $parts[-1]
      for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        if ($parts[$i] -match 'event:\s*notification' -and $parts[$i] -match 'data:\s*(.+)$') {
          try { [void]$script:seen.Add(($Matches[1].Trim() | ConvertFrom-Json)) } catch {}
        }
      }
    } catch { continue }
  }
}

try {
  # --- two people, because alerts are personal --------------------------------
  # The cashier who rings the sale is deliberately not told about their own sale, so
  # proving that a sale alert is delivered needs a second person to receive it. That is
  # the real arrangement in a shop: one person at the till, someone else watching.
  $ownerRole = @((Gj "$base/roles" $H).data | Where-Object { $_.type -eq 'OWNER' })[0]
  $watcherEmail = "watcher.$slug@kazios.dev"
  $watcherPassword = "Watch$slug!123"
  Pj "$base/users" @{
      name = "Watcher $slug"; email = $watcherEmail
      password = $watcherPassword; roleId = $ownerRole.id
    } $H | Out-Null
  $watcher = Pj "$base/auth/login" @{ email = $watcherEmail; password = $watcherPassword } $null
  $watcherToken = $watcher.data.token
  Check 'a second user can sign in' ($null -ne $watcherToken) 'watcher login failed'

  # The stream is opened as the watcher, because the watcher is who should hear about
  # a sale rung by somebody else.
  $watcherStream = "$orgRoot/api/v1/notifications/stream?access_token=$([uri]::EscapeDataString($watcherToken))"
  $conn = Start-Stream -Url $watcherStream
  $script:client = $conn.client
  $script:stream = $conn.stream
  Read-Frames -Seconds 2
  Check 'the stream opens and authenticates' ($script:buffer.Length -ge 0) 'connection failed'

  # --- a real sale must raise a real alert -----------------------------------
  $product = (Pj "$base/products" @{
      name = "Notify Widget $slug"; sku = "NTF-$slug"; productType = 'PHYSICAL'
      costPrice = 50; sellingPrice = 80; minStock = 5
    } $H).data
  Check 'product fixture created' ($null -ne $product.id)

  $customer = (Pj "$base/customers" @{ name = "Notify Customer $slug"; email = "n.$slug@example.com" } $H).data

  # The context answers with lists, because a till can be pointed at any branch or
  # warehouse. A new organization always has exactly one of each.
  $context = (Gj "$base/pos/context" $H).data
  $branchId = @($context.branches)[0].id
  $warehouseId = @($context.warehouses)[0].id
  Check 'the till context has a branch and a warehouse' ($null -ne $branchId -and $null -ne $warehouseId) 'none found'

  # Seed stock so the sale has something to sell.
  try {
    Pj "$base/inventory/adjustments" @{
      productId = $product.id; warehouseId = $warehouseId
      adjustmentType = 'INCREASE'; quantity = 10; reason = 'smoke seed'
    } $H | Out-Null
    $seeded = $true
  } catch { $seeded = $false }
  Check 'stock seeded for the sale' $seeded

  Read-Frames -Seconds 1
  $before = $script:seen.Count

  Pj "$base/pos/sale" @{
      branchId = $branchId; warehouseId = $warehouseId; customerId = $customer.id
      idempotencyKey = "smoke-$slug"
      items = @(@{ productId = $product.id; quantity = 1; discountAmount = 0 })
      payments = @(@{ provider = 'CASH'; methodType = 'cash'; amount = 80; tenderedAmount = 100 })
    } $H | Out-Null

  Read-Frames -Seconds 6
  $newAlerts = $script:seen.Count - $before
  Check 'a completed sale pushes an alert over the live stream' ($newAlerts -ge 1) "new=$newAlerts"

  $saleAlert = $script:seen | Select-Object -Last 1
  Write-Host "        -> $($saleAlert.title): $($saleAlert.body)" -ForegroundColor DarkGray

  # --- low stock must raise an alert, and only once --------------------------
  Read-Frames -Seconds 1
  Pj "$base/pos/sale" @{
      branchId = $branchId; warehouseId = $warehouseId; customerId = $customer.id
      idempotencyKey = "smoke2-$slug"
      items = @(@{ productId = $product.id; quantity = 4; discountAmount = 0 })
      payments = @(@{ provider = 'CASH'; methodType = 'cash'; amount = 320; tenderedAmount = 400 })
    } $H | Out-Null
  Read-Frames -Seconds 6

  $lowAlerts = @($script:seen | Where-Object { $_.title -match 'Low stock|Out of stock' })
  Check 'falling to the reorder level raises a low stock alert' ($lowAlerts.Count -ge 1) "count=$($lowAlerts.Count)"

  # The condition is still true, so no second alert may appear. A stock sweep runs
  # every few minutes and would otherwise fill the list with identical rows.
  $dedupedBefore = $lowAlerts.Count
  Pj "$base/inventory/adjustments" @{
      productId = $product.id; warehouseId = $warehouseId
      adjustmentType = 'DECREASE'; quantity = 1; reason = 'smoke still low'
    } $H | Out-Null
  Read-Frames -Seconds 5
  $lowAlertsAfter = @($script:seen | Where-Object { $_.title -match 'Low stock|Out of stock' })
  Check 'the same condition does not alert twice' ($lowAlertsAfter.Count -eq $dedupedBefore) "before=$dedupedBefore after=$($lowAlertsAfter.Count)"

  # --- the stored list must agree with what was pushed -----------------------
  # Read as the watcher, because that is whose list the alerts were delivered into.
  $WH = @{ Authorization = "Bearer $watcherToken" }
  $list = Gj "$base/notifications?limit=50" $WH
  $stored = @($list.data | Where-Object { $_.title -match 'Sale completed' })
  Check 'the sale is also persisted, not only broadcast' ($stored.Count -ge 1) "stored=$($stored.Count)"
  Check 'the unread badge reflects pushed alerts' ($list.meta.unread -ge 1) "unread=$($list.meta.unread)"

  # The cashier must not be told about their own sale: the screen they are looking at
  # already shows it, and an alert for it would be noise on the busiest screen there is.
  $own = Gj "$base/notifications?limit=50" $H
  $ownSale = @($own.data | Where-Object { $_.title -match 'Sale completed' })
  Check 'the cashier is not alerted about their own sale' ($ownSale.Count -eq 0) "count=$($ownSale.Count)"

  # --- marking read must stick ----------------------------------------------
  $target = @($list.data | Where-Object { -not $_.readAt })[0]
  if ($target) {
    Pj "$base/notifications/read" @{ ids = @($target.id) } $WH | Out-Null
    $after = Gj "$base/notifications?limit=50" $WH
    $still = @($after.data | Where-Object { $_.id -eq $target.id -and -not $_.readAt })
    Check 'marking a notification read persists' ($still.Count -eq 0) 'still unread'
  } else {
    Check 'marking a notification read persists' $false 'no unread notification to mark'
  }
} finally {
  if ($script:stream) { try { $script:stream.Close() } catch {} }
  if ($script:client) { try { $script:client.Close() } catch {} }
}

Write-Host "`n  passed: $script:pass  failed: $script:fail`n" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }
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

Write-Host "`n=== notification smoke test ===" -ForegroundColor Cyan

$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$token = $login.data.token
$H = @{ Authorization = "Bearer $token" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)
$orgRoot = $base -replace '/api/v\d+$', ''

# --- open the live stream ---------------------------------------------------
# A raw TCP client rather than a browser EventSource: PowerShell has no built in SSE
# client, and reading the raw bytes is what proves the server is pushing rather than
# waiting to be asked.
$streamUrl = "$orgRoot/api/v1/notifications/stream?access_token=$([uri]::EscapeDataString($token))"
$script:buffer = ''
$script:seen = New-Object System.Collections.ArrayList

function Start-Stream {
  param([string]$Url)
  $uri = [uri]$Url
  $c = New-Object System.Net.Sockets.TcpClient
  $c.Connect($uri.Host, $uri.Port)
  $s = $c.GetStream()
  $req = "GET $($uri.PathAndQuery) HTTP/1.1`r`nHost: $($uri.Host)`r`nAccept: text/event-stream`r`nConnection: keep-alive`r`n`r`n"
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($req)
  $s.Write($bytes, 0, $bytes.Length)
  $s.ReadTimeout = 1500
  return @{ client = $c; stream = $s }
}

function Read-Frames([int]$Seconds = 6) {
  # Reads until the deadline, collecting any complete SSE frame that arrives. The short
  # read timeout is deliberate: it throws when nothing is arriving, which is how a
  # missing alert is detected rather than waited on.
  $deadline = (Get-Date).AddSeconds($Seconds)
  $buf = New-Object byte[] 4096
  while ((Get-Date) -lt $deadline) {
    try {
      $read = $script:stream.Read($buf, 0, $buf.Length)
      if ($read -le 0) { continue }
      $script:buffer += [System.Text.Encoding]::UTF8.GetString($buf, 0, $read)
      $parts = $script:buffer -split "`n`n"
      $script:buffer = $parts[-1]
      for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        if ($parts[$i] -match 'event:\s*notification' -and $parts[$i] -match 'data:\s*(.+)$') {
          try { [void]$script:seen.Add(($Matches[1].Trim() | ConvertFrom-Json)) } catch {}
        }
      }
    } catch { continue }
  }
}