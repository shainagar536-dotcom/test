<#
.SYNOPSIS
    Checks the Surense API connection and reports the response *shape*.

.DESCRIPTION
    Runs the same four steps the Apps Script diagnostic runs, from a machine
    that can actually reach the API.

    It deliberately prints field NAMES and never field VALUES, so the output
    can be shared to fix a configuration mismatch without any customer data
    leaving the machine. The only lead data shown is the count of leads.

.EXAMPLE
    .\diagnose.ps1 -ClientId cid_xxx -ClientSecret csk_xxx

.NOTES
    The secret is passed on the command line, so it lands in PowerShell's
    history file. Clear it afterwards with:
        Remove-Item (Get-PSReadlineOption).HistorySavePath
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ClientId,
    [Parameter(Mandatory = $true)][string]$ClientSecret,
    [string]$TokenUrl = 'https://api.surense.com/oauth/token',

    # Both candidates are tried in order and the first that answers wins.
    # The token's "aud" claim names www.surense.com while the integration
    # notes say api.surense.com, and only a live call settles which serves
    # the API.
    [string[]]$ApiBase = @(
        'https://api.surense.com/api/v1',
        'https://www.surense.com/api/v1'
    )
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still defaults to TLS 1.0, which the API will refuse.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Write-Step { param($Text) Write-Host "`n=== $Text ===" -ForegroundColor Cyan }
function Write-Ok   { param($Text) Write-Host "  OK   $Text" -ForegroundColor Green }
function Write-Bad  { param($Text) Write-Host "  FAIL $Text" -ForegroundColor Red }

function Get-HttpError {
    param($ErrorRecord)

    $response = $ErrorRecord.Exception.Response

    if (-not $response) {
        return "no response: $($ErrorRecord.Exception.Message)"
    }

    $code = [int]$response.StatusCode
    $body = ''

    try {
        $reader = New-Object IO.StreamReader($response.GetResponseStream())
        $body = $reader.ReadToEnd()
    } catch { }

    $meaning = switch ($code) {
        401 { 'the credentials were rejected - the secret was probably rotated' }
        403 { 'authenticated, but this client lacks the scope for this endpoint' }
        404 { 'wrong path - check the API base URL' }
        415 { 'wrong content type for this endpoint' }
        429 { 'rate limited - wait a minute and retry' }
        default { '' }
    }

    if ($meaning) { return "HTTP $code - $meaning`n       $body" }
    return "HTTP $code`n       $body"
}

Write-Host "Surense API check" -ForegroundColor White
Write-Host "  token endpoint : $TokenUrl"
Write-Host "  api bases      : $($ApiBase -join ', ')"
Write-Host "  client id      : $($ClientId.Substring(0, [Math]::Min(8, $ClientId.Length)))..."

# --- 1. token --------------------------------------------------------------
Write-Step '1. Requesting a token'

$token = $null

try {
    # This endpoint requires form encoding; JSON is refused.
    $auth = Invoke-RestMethod -Method Post -Uri $TokenUrl `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body "grant_type=client_credentials&client_id=$ClientId&client_secret=$ClientSecret"

    $token = $auth.access_token

    if ($token) {
        Write-Ok "token received (expires_in: $($auth.expires_in))"
    } else {
        Write-Bad "the response had no access_token field"
        $auth | ConvertTo-Json -Depth 4
        exit 1
    }
} catch {
    Write-Bad (Get-HttpError $_)
    Write-Host "`n  Nothing else can be checked without a token." -ForegroundColor Yellow
    exit 1
}

# Scopes, when the token is a JWT. Shows what this client is actually allowed
# to do, which separates a malformed call from a permission that was never
# granted.
$parts = $token.Split('.')

if ($parts.Count -eq 3) {
    try {
        $payload = $parts[1].Replace('-', '+').Replace('_', '/')
        while ($payload.Length % 4) { $payload += '=' }

        $claims = [Text.Encoding]::UTF8.GetString(
            [Convert]::FromBase64String($payload)) | ConvertFrom-Json

        $scope = $claims.scope
        if (-not $scope) { $scope = $claims.scopes }
        if (-not $scope) { $scope = $claims.scp }

        if ($scope) { Write-Ok "scopes granted: $scope" }
    } catch { }
}

$headers = @{ Authorization = "Bearer $token" }

# --- 2. which base actually serves the API ---------------------------------
Write-Step '2. Finding the API base'

$base = $null

foreach ($candidate in $ApiBase) {
    try {
        Invoke-RestMethod -Uri "$candidate/leads/fields" -Headers $headers | Out-Null
        Write-Ok "$candidate answered"
        $base = $candidate
        break
    } catch {
        Write-Host "  --   $candidate : $(Get-HttpError $_)" -ForegroundColor DarkGray
    }
}

if (-not $base) {
    Write-Bad 'No candidate base answered. Check the API host with Surense.'
    exit 1
}

Write-Host "`n  Use this in CONFIG.surense.apiBase : $base" -ForegroundColor White

# --- 3. field schema -------------------------------------------------------
Write-Step '3. GET /leads/fields'

try {
    $fields = Invoke-RestMethod -Uri "$base/leads/fields" -Headers $headers

    # The array may be bare or wrapped; try the usual envelope keys.
    $list = $fields
    foreach ($key in 'rows', 'data', 'results', 'items', 'fields') {
        if ($fields.PSObject.Properties.Name -contains $key) { $list = $fields.$key; break }
    }

    # Windows PowerShell 5.1 gives no .Count on a lone object; @() forces an array.
    $list = @($list)

    Write-Ok "$($list.Count) field(s) returned"
    Write-Host "`n  Field keys:" -ForegroundColor White

    $list | ForEach-Object {
        if ($_ -is [string]) { "    $_" }
        else {
            $k = $_.key; if (-not $k) { $k = $_.name }; if (-not $k) { $k = $_.field }
            $l = $_.label; if (-not $l) { $l = $_.title }
            if ($l -and $l -ne $k) { "    $k  ($l)" } else { "    $k" }
        }
    }
} catch {
    Write-Bad (Get-HttpError $_)
}

# --- 4. lead search --------------------------------------------------------
Write-Step '4. POST /leads/search'

try {
    $search = Invoke-RestMethod -Method Post -Uri "$base/leads/search" `
        -Headers $headers -ContentType 'application/json' `
        -Body '{"startRow":0,"endRow":1,"filters":[]}'

    $envelope = $search.PSObject.Properties.Name
    Write-Ok "responded"
    Write-Host "  envelope keys : $($envelope -join ', ')"

    $rows = $null
    foreach ($key in 'rows', 'data', 'results', 'items', 'leads') {
        if ($envelope -contains $key) { $rows = $search.$key; break }
    }

    if (-not $rows) { $rows = $search }

    # Same reason as above: one lead must still behave like a list of one.
    $rows = @($rows)

    Write-Host "  leads in page : $($rows.Count)"

    if ($rows.Count -gt 0) {
        Write-Host "`n  Lead field names (names only, no values):" -ForegroundColor White
        $rows[0].PSObject.Properties.Name | ForEach-Object { "    $_" }
    } else {
        Write-Host "  No leads came back. If the CRM has leads, the envelope key" -ForegroundColor Yellow
        Write-Host "  or the filter shape differs from what is expected." -ForegroundColor Yellow
    }
} catch {
    Write-Bad (Get-HttpError $_)
}

# --- 5. total count --------------------------------------------------------
Write-Step '5. How many leads are there'

try {
    $page = Invoke-RestMethod -Method Post -Uri "$base/leads/search" `
        -Headers $headers -ContentType 'application/json' `
        -Body '{"startRow":0,"endRow":50,"filters":[]}'

    $names = $page.PSObject.Properties.Name

    # A total on the envelope saves paging through everything to count.
    foreach ($key in 'total', 'totalRows', 'totalCount', 'count', 'hasNextPage') {
        if ($names -contains $key) { Write-Host "  $key : $($page.$key)" }
    }
} catch {
    Write-Bad (Get-HttpError $_)
}

Write-Host "`nDone. The output above contains field NAMES only - no lead data." -ForegroundColor Green
Write-Host "Rotate the client secret when you are finished testing." -ForegroundColor Yellow
