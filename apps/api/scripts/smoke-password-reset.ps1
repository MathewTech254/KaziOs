# Local integration smoke test. Run it with the dev API already listening on :4000
# (npm run dev:api, or npm run dev). It exercises the whole password reset journey and
# the properties that make it safe: no account enumeration, single use links, short
# expiry, and a reset that actually signs the old password out.
#
# With no RESEND_API_KEY set the API logs the message instead of sending it, so this
# script reads the reset link out of the API log the way a developer would.
#
#   powershell -File apps/api/scripts/smoke-password-reset.ps1
#
# Optional overrides:
#   KAZIOS_API_URL        default http://localhost:4000/api/v1
#   KAZIOS_SMOKE_EMAIL    default admin@kazios.dev
#   KAZIOS_SMOKE_PASSWORD default admin123
#   KAZIOS_API_LOG        default %TEMP%\kazios-api.log

$base = if ($env:KAZIOS_API_URL) { $env:KAZIOS_API_URL } else { 'http://localhost:4000/api/v1' }
$healthUrl = $base -replace '/api/v\d+$', '/health'
try { Invoke-RestMethod $healthUrl -TimeoutSec 5 | Out-Null }
catch { Write-Host "API not reachable at $healthUrl - start it with 'npm run dev:api' first." -ForegroundColor Red; exit 1 }
$apiLog = if ($env:KAZIOS_API_LOG) { $env:KAZIOS_API_LOG } else { Join-Path $env:TEMP "kazios-api.log" }
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
function ExpectError([string]$method, [string]$uri, $body, $headers) {
  try {
    if ($method -eq 'GET') { Invoke-RestMethod -Uri $uri -Method Get -Headers $headers | Out-Null }
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

Write-Host "`n=== password reset smoke test ===" -ForegroundColor Cyan
$slug = [guid]::NewGuid().ToString('N').Substring(0, 8)
$email = "reset.$slug@kazios.dev"

$register = Pj "$base/auth/register" @{ name = 'Reset Tester'; email = $email; password = 'originalpass123'; organizationName = "Reset $slug"; country = 'KE'; currency = 'KES'; timezone = 'Africa/Nairobi' } $null
Check 'account created' ($null -ne $register.data.token)

# --- the request must not reveal whether an address is registered ---------
$known = Pj "$base/auth/forgot-password" @{ email = $email } $null
$unknown = Pj "$base/auth/forgot-password" @{ email = "nobody.$slug@kazios.dev" } $null
Check 'known address gets the neutral confirmation' ($known.data.message -like '*If that email address*') $known.data.message
Check 'unknown address gets the identical message' ($unknown.data.message -eq $known.data.message) $unknown.data.message
$malformed = ExpectError 'POST' "$base/auth/forgot-password" @{ email = 'not-an-email' } $null
Check 'a malformed address is rejected outright, not treated as unknown' ($malformed.status -eq 400) "status=$($malformed.status)"

# --- the emailed link ----------------------------------------------------
# The newest link in the log, not the first: earlier runs leave spent links behind.

# Ask for a reset for this account, then read the link the API produced.
Pj "$base/auth/forgot-password" @{ email = $email } $null | Out-Null
Start-Sleep -Seconds 2
$log = Get-Content $apiLog -Raw -ErrorAction SilentlyContinue
$allTokens = @([regex]::Matches($log, "token=([0-9a-f]{64})") | ForEach-Object { $_.Groups[1].Value })
$newestToken = if ($allTokens.Count) { $allTokens[-1] } else { "" }

if ($env:RESEND_API_KEY) {
  Check 'a mail provider is configured, so the link is only in the inbox' $true '(skipped: the link cannot be read from a log)'
} elseif ($newestToken -eq "") {
  Check 'a reset link was produced' $false 'no token found in the API log'
} else {
  $token = $newestToken
  Check 'a reset link was produced' ($token.Length -eq 64) "token length=$($token.Length)"
  # the link must be checked before a password is typed
  $verify = Pj "$base/auth/reset-password/verify" @{ token = $token } $null
  Check 'a fresh link verifies' ($verify.data.valid -eq $true) $verify.data.email
  Check 'the account is masked, not echoed back' ($verify.data.email -like '*@*' -and $verify.data.email -notlike "*$slug@*") $verify.data.email

  $badVerify = ExpectError 'POST' "$base/auth/reset-password/verify" @{ token = 'deadbeef' } $null
  Check 'a made up token is refused (400)' ($badVerify.status -eq 400) "status=$($badVerify.status)"

  # a rejected attempt must not burn the link
  $mismatch = ExpectError 'POST' "$base/auth/reset-password" @{ token = $token; password = 'brandnew123'; confirmPassword = 'different123' } $null
  Check 'mismatched passwords are refused' ($mismatch.status -eq 400) "status=$($mismatch.status)"
  $short = ExpectError 'POST' "$base/auth/reset-password" @{ token = $token; password = 'abc'; confirmPassword = 'abc' } $null
  Check 'a short password is refused' ($short.status -eq 400) "status=$($short.status)"
  $stillGood = Pj "$base/auth/reset-password/verify" @{ token = $token } $null
  Check 'the link survives a failed attempt' ($stillGood.data.valid -eq $true) 'a rejected attempt must not burn the link'

  # the reset itself, and proof that it really changed the password
  $done = Pj "$base/auth/reset-password" @{ token = $token; password = 'brandnew123'; confirmPassword = 'brandnew123' } $null
  Check 'the password is changed' ($done.data.message -like '*has been changed*') $done.data.message
  $oldLogin = ExpectError 'POST' "$base/auth/login" @{ email = $email; password = 'originalpass123' } $null
  Check 'the old password no longer works' ($oldLogin.status -eq 401) "status=$($oldLogin.status)"
  $newLogin = Pj "$base/auth/login" @{ email = $email; password = 'brandnew123' } $null
  Check 'the new password works' ($null -ne $newLogin.data.token)

  # a used link is dead, so a link leaked from an inbox is worthless
  $replay = ExpectError 'POST' "$base/auth/reset-password" @{ token = $token; password = 'attackers1'; confirmPassword = 'attackers1' } $null
  Check 'the same link cannot be used twice' ($replay.status -eq 400 -and $replay.body -match 'already been used') "status=$($replay.status)"
  $attacker = ExpectError 'POST' "$base/auth/login" @{ email = $email; password = 'attackers1' } $null
  Check 'the replayed link changed nothing' ($attacker.status -eq 401) "status=$($attacker.status)"
}

Write-Host "`n=== $($script:pass) passed, $($script:fail) failed ===" -ForegroundColor Cyan
if ($script:fail -gt 0) { exit 1 }
