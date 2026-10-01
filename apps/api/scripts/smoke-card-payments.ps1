# Card payment safety smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). This suite proves the till cannot fake a card payment:
# an invoice is only ever marked paid after Paystack itself confirms the money.
#
#   powershell -File apps/api/scripts/smoke-card-payments.ps1
#
# Optional overrides:
#   KAZIOS_API_URL        default http://localhost:4000/api/v1
#   KAZIOS_SMOKE_EMAIL    default admin@kazios.dev
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

# Returns the HTTP status instead of throwing, so a refused request is a result rather
# than a crashed test. Security cases are exactly the ones that must be refused.
# The status is read from the response itself, because a 201 is a success but is not 200.
function TryPost([string]$uri, $body, $headers) {
  try {
    $r = Invoke-WebRequest -Uri $uri -Method Post -Headers $headers -Body ($body | ConvertTo-Json -Depth 8) -ContentType 'application/json' -UseBasicParsing
    $parsed = $r.Content | ConvertFrom-Json
    return @{ Status = [int]$r.StatusCode; Body = $parsed }
  } catch {
    $status = 0
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    return @{ Status = $status; Body = $null }
  }
}

Write-Host "`n=== card payment safety smoke test ===" -ForegroundColor Cyan
$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$H = @{ Authorization = "Bearer $($login.data.token)" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)

$customer = (Pj "$base/customers" @{ name = "Card Customer $slug"; email = "c.$slug@example.com" } $H).data
Check 'customer fixture created' ($null -ne $customer.id)

$context = Gj "$base/pos/context" $H
$branch = $context.data.branches | Where-Object { $_.isMain } | Select-Object -First 1
$warehouse = $context.data.warehouses | Where-Object { $_.branchId -eq $branch.id } | Select-Object -First 1
$products = Gj "$base/pos/products?page=1&limit=5&branchId=$($branch.id)" $H
$item = $products.data | Where-Object { $_.stockQuantity -gt 5 } | Select-Object -First 1
Check 'saleable product found' ($null -ne $item) 'no product with stock'

# ---------------------------------------------------------------- card is offered
$cardMethod = $context.data.paymentMethods | Where-Object { $_.provider -eq 'PAYSTACK' }
if (-not $cardMethod) {
  Write-Host "  SKIP  card payments are not configured in this environment." -ForegroundColor Yellow
  Write-Host "  Set PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY and PAYSTACK_WEBHOOK_SECRET" -ForegroundColor Yellow
  Write-Host "  to exercise the full flow." -ForegroundColor Yellow
  Write-Host "`n$script:pass passed, $script:fail failed`n"
  exit 0
}
Check 'card payment offered at the till' ($null -ne $cardMethod)
Check 'public key exposed to the browser' ($context.data.cardPublicKey -like 'pk_*') 'no public key in POS context'
Check 'secret key never sent to the browser' (-not (($context.data | ConvertTo-Json -Depth 8) -match 'sk_')) 'secret key leaked in POS context'

# ---------------------------------------------------------------- a card sale is not paid upfront
$sale = TryPost "$base/pos/sale" @{
  branchId = $branch.id
  warehouseId = $warehouse.id
  customerId = $customer.id
  items = @(@{ productId = $item.id; quantity = 2; discountAmount = 0 })
  discountAmount = 0
  payments = @(@{ provider = 'PAYSTACK'; methodType = 'card'; amount = ($item.sellingPrice * 2) })
  idempotencyKey = "card-$slug"
} $H

Check 'card sale is accepted' ($sale.Status -eq 201) "status $($sale.Status)"
if ($sale.Status -ne 201) { Write-Host "`n$script:pass passed, $script:fail failed`n"; exit 1 }

$invoiceId = $sale.Body.data.invoiceId
Check 'sale asks the till to start a card payment' ($sale.Body.data.requiresCardPayment -eq $true)
Check 'card sale is not marked paid before Paystack confirms' ($sale.Body.data.invoice.status -ne 'PAID') "status was $($sale.Body.data.invoice.status)"
Check 'card sale records no payment yet' ($sale.Body.data.invoice.payments.Count -eq 0) 'a payment row was written before confirmation'
Check 'change is not offered for a card sale' ($sale.Body.data.changeAmount -eq 0)

# ---------------------------------------------------------------- forged confirmations are refused
$fake = TryPost "$base/card-payments/confirm" @{ reference = "made-up-$slug" } $H
Check 'confirming an unknown reference is refused' ($fake.Status -ge 400) "status $($fake.Status)"

$noSession = TryPost "$base/card-payments/confirm" @{ reference = "made-up-$slug" } $null
Check 'confirm requires a signed in cashier' ($noSession.Status -ge 400) "status $($noSession.Status)"

$badEmail = TryPost "$base/card-payments/initialize" @{ invoiceId = $invoiceId; email = 'not-an-email' } $H
Check 'an invalid customer email is refused' ($badEmail.Status -eq 400) "status $($badEmail.Status)"

# ---------------------------------------------------------------- the webhook refuses forgeries
$webhookUrl = $base -replace '/api/v\d+$', '/api/v1/webhooks/paystack'
$forgedBody = '{"event":"charge.success","data":{"reference":"' + $invoiceId + '","amount":1}}'
try {
  Invoke-RestMethod -Uri $webhookUrl -Method Post -Body $forgedBody -ContentType 'application/json' -Headers @{ 'x-paystack-signature' = 'forged' } | Out-Null
  Check 'unsigned webhook is refused' $false 'the webhook accepted an unsigned request'
} catch {
  $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
  Check 'unsigned webhook is refused' ($status -eq 401) "status $status"
}

# ---------------------------------------------------------------- the invoice is still unpaid
$after = Gj "$base/pos/receipt/$invoiceId" $H
Check 'the invoice is still unpaid after every attempt to fake payment' ($after.data.invoice.status -ne 'PAID') "status $($after.data.invoice.status)"
Check 'the invoice still has no payment recorded' ($after.data.invoice.payments.Count -eq 0)

Write-Host "`n$script:pass passed, $script:fail failed`n"
if ($script:fail -gt 0) { exit 1 }

