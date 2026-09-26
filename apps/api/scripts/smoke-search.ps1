# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). It covers every search surface in the product:
# the per-page list searches, the product sku/barcode match a till needs, the payment
# search the payments screen offers, and the global command palette endpoint.
#
#   powershell -File apps/api/scripts/smoke-search.ps1
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
function RowCount($res) {
  # Most list endpoints answer { data: [...], meta }. The products endpoint answers
  # { data: [...], total, page, limit } with the same array, so read .data either way.
  $items = $res.data
  if ($null -eq $items) { return 0 }
  if ($items -is [array]) { return $items.Length }
  return @($items).Length
}
function CountRows($RowCount) { if ($null -eq $RowCount) { return 0 } else { return @($RowCount).Length } }

Write-Host "`n=== search smoke test ===" -ForegroundColor Cyan
$login = Pj "$base/auth/login" @{ email = $email; password = $password } $null
$H = @{ Authorization = "Bearer $($login.data.token)" }
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)

# A term that cannot appear in any row. A search that "works" must return nothing
# for it; this is the assertion that catches a filter which is silently ignored.
$junk = "zzznotathing$slug"

# --- fixtures -------------------------------------------------------------
$supplier = (Pj "$base/suppliers" @{ name = "Search Supplier $slug"; email = "s.$slug@example.com" } $H).data
$product = (Pj "$base/products" @{ name = "Search Widget $slug"; sku = "SRCH-$slug"; barcode = "BAR$slug"; productType = 'PHYSICAL'; costPrice = 50; sellingPrice = 80 } $H).data
$order = (Pj "$base/purchase-orders" @{ supplierId = $supplier.id; items = @(@{ productId = $product.id; quantity = 1; unitPrice = 50 }) } $H).data
Check 'fixtures created' ($null -ne $product.id -and $null -ne $order.id)


# --- products: name, sku and barcode all have to match --------------------
$hits = RowCount (Gj "$base/products?limit=200&search=Search%20Widget" $H)
Check 'product search matches the name' ($hits -ge 1) "hits=$hits"
$hits = RowCount (Gj "$base/products?limit=200&search=SRCH-$slug" $H)
Check 'product search matches the sku' ($hits -eq 1) "hits=$hits (a till reads skus)"
$hits = RowCount (Gj "$base/products?limit=200&search=BAR$slug" $H)
Check 'product search matches the barcode' ($hits -eq 1) "hits=$hits (a till scans barcodes)"
$hits = RowCount (Gj "$base/products?limit=200&search=$junk" $H)
Check 'product search excludes a term that matches nothing' ($hits -eq 0) "hits=$hits"

# --- suppliers ------------------------------------------------------------
$hits = RowCount (Gj "$base/suppliers?limit=200&search=$slug" $H)
Check 'supplier search finds the fixture' ($hits -eq 1) "hits=$hits"
$hits = RowCount (Gj "$base/suppliers?limit=200&search=$junk" $H)
Check 'supplier search excludes a term that matches nothing' ($hits -eq 0) "hits=$hits"

# --- purchase orders ------------------------------------------------------
$hits = RowCount (Gj "$base/purchase-orders?limit=200&search=$($order.poNumber)" $H)
Check 'purchase order search finds the number' ($hits -eq 1) "hits=$hits"
$hits = RowCount (Gj "$base/purchase-orders?limit=200&search=Search%20Supplier" $H)
# The demo organization already has suppliers, so only require that the fixture matches.
Check 'purchase order search matches the supplier name' ($hits -ge 1) "hits=$hits"
$hits = RowCount (Gj "$base/purchase-orders?limit=200&search=$junk" $H)
Check 'purchase order search excludes a term that matches nothing' ($hits -eq 0) "hits=$hits"

# --- payments: the screen offers a search box, so the API must honour it ----
$payAll = Gj "$base/payments?limit=200" $H
$payJunk = Gj "$base/payments?limit=200&search=$junk" $H
$hits = RowCount $payJunk
Check 'payment search actually filters' ($hits -eq 0) "junk hits=$hits (silently ignored before this fix)"
Check 'payment search reduces the result set' ($payJunk.total -lt $payAll.total -or $payAll.total -eq 0) "all=$($payAll.total) filtered=$($payJunk.total)"


# --- command palette ------------------------------------------------------
$palJunk = Gj "$base/reports/search?q=$junk" $H
$hits = CountRows $palJunk.data.results.products
Check 'palette returns nothing for a term that matches nothing' ($hits -eq 0) "hits=$hits"

$palShort = Gj "$base/reports/search?q=a" $H
$shortProducts = CountRows $palShort.data.results.products
$shortSuppliers = CountRows $palShort.data.results.suppliers
Check 'palette ignores a one character term' (($shortProducts -eq 0) -and ($shortSuppliers -eq 0)) "products=$shortProducts suppliers=$shortSuppliers"

$palProduct = Gj "$base/reports/search?q=SRCH-$slug" $H
$hits = CountRows $palProduct.data.results.products
Check 'palette finds a product by sku' ($hits -eq 1) "hits=$hits"

$palOrder = Gj "$base/reports/search?q=$($order.poNumber)" $H
$hits = CountRows $palOrder.data.results.purchaseOrders
Check 'palette finds a purchase order by number' ($hits -eq 1) "hits=$hits"

$palSupplier = Gj "$base/reports/search?q=$slug" $H
$hits = CountRows $palSupplier.data.results.suppliers
Check 'palette finds the supplier' ($hits -eq 1) "hits=$hits"

# --- tenant isolation on the palette --------------------------------------
$tenant = Pj "$base/auth/register" @{ name = 'Search Tenant'; email = "st.$slug@kazios.dev"; password = 'tenant123'; organizationName = "Search $slug"; country = 'KE'; currency = 'KES'; timezone = 'Africa/Nairobi' } $null
$TH = @{ Authorization = "Bearer $($tenant.data.token)" }
$crossPal = Gj "$base/reports/search?q=SRCH-$slug" $TH
$hits = CountRows $crossPal.data.results.products
Check 'palette does not leak across organizations' ($hits -eq 0) "hits=$hits"
$crossProd = Gj "$base/products?limit=200&search=SRCH-$slug" $TH
$hits = RowCount $crossProd
Check 'product search does not leak across organizations' ($hits -eq 0) "hits=$hits"

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }


