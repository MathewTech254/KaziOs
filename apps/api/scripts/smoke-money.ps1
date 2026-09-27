# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). This is the money safety suite: it proves the
# server derives every amount itself, so no client can bill 1 cent for a large order.
#
#   powershell -File apps/api/scripts/smoke-money.ps1
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

Write-Host "`n=== money safety smoke test ===" -ForegroundColor Cyan
$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$H = @{ Authorization = "Bearer $($login.data.token)" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)

$customer = (Pj "$base/customers" @{ name = "Money Customer $slug"; email = "m.$slug@example.com" } $H).data
Check 'customer fixture created' ($null -ne $customer.id)

# Builds an invoice, deliberately declaring absurd totals the server must ignore.
function NewInvoice([array]$items) {
  $body = @{
    customerId = $customer.id
    issueDate = '2026-09-25T00:00:00.000Z'
    dueDate = '2026-10-25T00:00:00.000Z'
    currency = 'KES'
    items = $items
    subtotal = 0.01
    taxTotal = 0
    discountTotal = 0
    total = 0.01
  }
  return (Pj "$base/invoices" $body $H).data
}

# --- the exploit this suite exists for -------------------------------------
# Declares a total of 0.01 while the line is worth 100,000,000.
$exploit = NewInvoice @(@{ description = 'bulk'; quantity = 1000; unitPrice = 100000; discountAmount = 0; taxRate = 0 })
Check 'a declared total of 0.01 is ignored' ($exploit.total -eq 100000000) "stored total=$($exploit.total)"
Check 'the header agrees with the lines' ($exploit.subtotal -eq $exploit.total) "subtotal=$($exploit.subtotal) total=$($exploit.total)"

# --- tax and discount arithmetic ------------------------------------------
$taxed = NewInvoice @(@{ description = 'taxed line'; quantity = 2; unitPrice = 99.99; discountAmount = 0; taxRate = 16 })
Check 'subtotal is quantity times price' ($taxed.subtotal -eq 199.98) "subtotal=$($taxed.subtotal)"
Check 'tax is a percentage of the line' ($taxed.taxTotal -eq 32) "tax=$($taxed.taxTotal)"
Check 'total is subtotal plus tax' ($taxed.total -eq 231.98) "total=$($taxed.total)"

$discounted = NewInvoice @(@{ description = 'discounted line'; quantity = 1; unitPrice = 10; discountAmount = 3; taxRate = 0 })
Check 'a discount reduces the total' ($discounted.total -eq 7) "total=$($discounted.total)"

# --- money must not drift the way floating point does ----------------------
$decimals = NewInvoice @(
  @{ description = 'ten cents'; quantity = 3; unitPrice = 0.1; discountAmount = 0; taxRate = 0 },
  @{ description = 'twenty cents'; quantity = 1; unitPrice = 0.2; discountAmount = 0; taxRate = 0 }
)
Check 'tenths add up exactly, with no float drift' ($decimals.total -eq 0.5) "total=$($decimals.total) (a float gives 0.5000000000000001)"

$many = NewInvoice @(@{ description = 'thousands'; quantity = 1000; unitPrice = 0.01; discountAmount = 0; taxRate = 0 })
Check 'a thousand low value lines total exactly 10.00' ($many.total -eq 10) "total=$($many.total)"

# --- a discount cannot exceed the line it applies to -----------------------
$overDiscount = NewInvoice @(@{ description = 'over discount'; quantity = 1; unitPrice = 10; discountAmount = 999; taxRate = 0 })
Check 'a discount larger than the line cannot go negative' ($overDiscount.total -ge 0) "total=$($overDiscount.total)"

# --- stored line must equal the stored header ------------------------------
$detail = Gj "$base/invoices/$($taxed.id)" $H
$lineSum = 0
foreach ($line in $detail.data.items) { $lineSum += $line.lineTotal }
Check 'the sum of stored lines equals the stored total' ([math]::Abs($lineSum - $detail.data.total) -lt 0.001) "lines=$lineSum total=$($detail.data.total)"

# --- purchase orders use the same rule -------------------------------------
$product = (Pj "$base/products" @{ name = "Money Product $slug"; sku = "MNY-$slug"; productType = 'PHYSICAL'; costPrice = 10; sellingPrice = 20 } $H).data
$supplier = (Pj "$base/suppliers" @{ name = "Money Supplier $slug"; email = "ms.$slug@example.com" } $H).data
$poBody = @{
  supplierId = $supplier.id
  taxRate = 16
  subtotal = 0.01
  total = 0.01
  items = @(@{ productId = $product.id; quantity = 2; unitPrice = 99.99 })
}
$po = (Pj "$base/purchase-orders" $poBody $H).data
Check 'purchase order totals are also derived server side' ($po.totalAmount -eq 231.98) "total=$($po.totalAmount)"

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }
