<#
    Moves the OWNER of every Surense lead to one user.

    The assignee is never touched. Only ownerId is sent, so whoever handles
    each lead stays exactly as they are.

    Standalone: this talks to the Surense API directly and has nothing to do
    with the mirror service, its database or its code. Run it by hand.

    Credentials are never stored here. Pass them as parameters, set
    SURENSE_CLIENT_ID / SURENSE_CLIENT_SECRET in the environment, or let the
    script ask. They are the same pair the Render service uses.

    THIS WRITES TO THE CRM — the only thing in this project that does. It is
    built so the change can be taken back:

      * without -Apply it reads, plans and reports, and writes nothing.
      * before the first write it saves every lead's current owner to a CSV.
        -Undo <that file> puts them all back.
      * it changes one lead first and reads it back before touching the rest.

    Usage:
        .\set-lead-owner.ps1                 # plan only
        .\set-lead-owner.ps1 -Apply          # do it
        .\set-lead-owner.ps1 -Undo .\owners-backup-20261103-174500.csv
#>

[CmdletBinding()]
param(
    [string] $ClientId     = $env:SURENSE_CLIENT_ID,
    [string] $ClientSecret = $env:SURENSE_CLIENT_SECRET,
    [string] $TokenUrl     = 'https://api.surense.com/oauth/token',
    [string] $ApiBase      = 'https://api.surense.com/api/v1',

    # Written straight into ownerId. Checked against the real user list
    # first, because an id that is wrong would land on every lead there is.
    [string] $OwnerId      = '',

    [switch] $Apply,
    [string] $Undo         = '',

    [int]    $DelayMs      = 350,
    [int]    $MaxPages     = 200
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if (-not $ClientId)     { $ClientId     = Read-Host 'Surense client id  (cid_...)' }
if (-not $ClientSecret) { $ClientSecret = Read-Host 'Surense client secret (csk_...)' }
if (-not $OwnerId)      { $OwnerId      = Read-Host 'Owner user id to set on every lead' }

$stamp     = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupCsv = Join-Path (Get-Location) "owners-backup-$stamp.csv"
$logCsv    = Join-Path (Get-Location) "owners-changes-$stamp.csv"

# ---------------------------------------------------------------- plumbing
# PowerShell 5.1's Invoke-RestMethod guesses the response encoding and
# mangles Hebrew. The backup has to be readable to be worth anything, so the
# bytes are decoded as UTF-8 by hand.
function Read-Json($response) {
    [Text.Encoding]::UTF8.GetString($response.RawContentStream.ToArray()) | ConvertFrom-Json
}

function Get-Status($err) {
    if ($err.Exception.Response) { return [int]$err.Exception.Response.StatusCode }
    return 0
}

function Get-Body($err) {
    if ($err.ErrorDetails.Message) { return $err.ErrorDetails.Message }
    if ($err.Exception.Response) {
        try {
            $reader = New-Object IO.StreamReader($err.Exception.Response.GetResponseStream())
            return $reader.ReadToEnd()
        } catch { }
    }
    return $err.Exception.Message
}

# A lead this key may not touch at all. Surense reports it as 400 with a
# message rather than 403, so the text is the only way to tell it apart from
# a malformed request — and the difference decides whether to keep going.
function Test-Forbidden($err) {
    return (Get-Body $err) -match 'not authorized to access this lead'
}

function Invoke-Api($method, $path, $body) {
    $request = @{
        Uri             = "$ApiBase$path"
        Method          = $method
        Headers         = $script:headers
        UseBasicParsing = $true
    }

    if ($null -ne $body) {
        $request.ContentType = 'application/json; charset=utf-8'
        $request.Body = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 6 -Compress))
    }

    Read-Json (Invoke-WebRequest @request)
}

function Get-Rows($payload) {
    foreach ($key in 'results', 'rows', 'data', 'items', 'content') {
        if ($payload.$key -is [Array]) { return @($payload.$key) }
    }
    return @()
}

# PATCH, not PUT. Against the live API, PUT answers 405 "Method 'PUT' is not
# supported" and POST answers "This endpoint is not part of the public API".
function Set-Owner($leadId) {
    Invoke-Api PATCH "/leads/$leadId" @{ ownerId = $OwnerId }
}

# -------------------------------------------------------------------- auth
Write-Host 'Authenticating...' -ForegroundColor Cyan

$tokenResponse = Invoke-WebRequest -Uri $TokenUrl -Method Post -UseBasicParsing `
    -ContentType 'application/x-www-form-urlencoded' `
    -Body @{ grant_type = 'client_credentials'; client_id = $ClientId; client_secret = $ClientSecret }

$token = (Read-Json $tokenResponse).access_token
if (-not $token) { throw 'The token response carried no access_token.' }

$script:headers = @{ Authorization = "Bearer $token" }

$segment = $token.Split('.')[1].Replace('-', '+').Replace('_', '/')
while ($segment.Length % 4) { $segment += '=' }
$scopes = @((([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($segment)) |
             ConvertFrom-Json).scope) -split ' ')

if ($scopes -notcontains 'leads:update') {
    Write-Host 'STOP - leads:update is not on this key. Nothing can be written.' -ForegroundColor Red
    return
}

Write-Host '  ok, leads:update present.' -ForegroundColor Green

# ------------------------------------------------------- confirm the owner
try {
    $users = Get-Rows (Invoke-Api POST '/users/search' @{ startRow = 0; endRow = 50 })
    $match = @($users | Where-Object { $_.id -eq $OwnerId })[0]

    if ($match) {
        $shown = $match.fullName
        if (-not $shown) { $shown = $match.name }
        Write-Host "  owner target: $shown  ($OwnerId)" -ForegroundColor Green
    } else {
        Write-Host "  STOP - $OwnerId is not in the user list this key can see." -ForegroundColor Red
        Write-Host '  The users it can see:'
        foreach ($user in $users) {
            $label = $user.fullName
            if (-not $label) { $label = $user.name }
            Write-Host "    $label  $($user.id)"
        }
        return
    }
} catch {
    Write-Host '  (could not read the user list; continuing on the id as given)' -ForegroundColor Yellow
}

# ------------------------------------------------------------------- undo
if ($Undo) {
    if (-not (Test-Path $Undo)) { throw "No such backup file: $Undo" }

    $rows = @(Import-Csv -Path $Undo -Encoding UTF8 | Where-Object { $_.ownerId })
    Write-Host "Restoring the owner on $($rows.Count) leads..." -ForegroundColor Yellow

    $ok = 0; $bad = 0

    foreach ($row in $rows) {
        try {
            Invoke-Api PATCH "/leads/$($row.id)" @{ ownerId = $row.ownerId } | Out-Null
            $ok++
        } catch { $bad++ }

        Write-Host -NoNewline "`r  $ok restored, $bad failed  "
        Start-Sleep -Milliseconds $DelayMs
    }

    Write-Host ''
    Write-Host "Done. Restored $ok, failed $bad." -ForegroundColor Yellow
    return
}

# -------------------------------------------------------------- read leads
Write-Host 'Reading every lead...' -ForegroundColor Cyan

$leads = @()
$start = 0

for ($page = 0; $page -lt $MaxPages; $page++) {
    $batch = Invoke-Api POST '/leads/search' @{ startRow = $start; endRow = $start + 50 }
    $leads += Get-Rows $batch
    $start += 50

    Write-Host -NoNewline "`r  $($leads.Count) "
    if (-not $batch.hasNextPage) { break }
}

Write-Host ''
if (-not $leads.Count) { throw 'No leads came back; refusing to continue.' }

# Written even on a dry run: it costs nothing, and it means the "before"
# picture exists from the first time anyone looked.
$leads | Select-Object `
    @{n='id';           e={$_.id}},
    @{n='leadNumber';   e={$_.number}},
    @{n='customer';     e={$_.fullName}},
    @{n='ownerId';      e={$_.ownerId}},
    @{n='ownerName';    e={$_.ownerName}},
    @{n='assigneeName'; e={$_.assigneeName}} |
    Export-Csv -Path $backupCsv -NoTypeInformation -Encoding UTF8

$toChange = @($leads | Where-Object { $_.ownerId -ne $OwnerId })

Write-Host ''
Write-Host '=== plan ===' -ForegroundColor Cyan
Write-Host "  leads total     : $($leads.Count)"
Write-Host "  already correct : $($leads.Count - $toChange.Count)"
Write-Host "  would change    : $($toChange.Count)"
Write-Host '  (owner only - the assignee is not touched)'
Write-Host ''
Write-Host '  current owners of those leads:'

$toChange | Group-Object ownerName | Sort-Object Count -Descending | ForEach-Object {
    $name = $_.Name
    if (-not $name) { $name = '(none)' }
    Write-Host ("    {0,-20} {1}" -f $name, $_.Count)
}

Write-Host ''
Write-Host '  owners before any change saved to:' -ForegroundColor Green
Write-Host "    $backupCsv"

if (-not $Apply) {
    Write-Host ''
    Write-Host 'Dry run - nothing was written. Add -Apply to do it.' -ForegroundColor Yellow
    return
}

if (-not $toChange.Count) {
    Write-Host ''
    Write-Host 'Nothing to change.' -ForegroundColor Green
    return
}

# ------------------------------------------------------------------ probe
# One lead first, read back, before touching the rest. A lead this key may
# not access is skipped rather than treated as a failed probe: about ten of
# them are refused outright, and stopping on one of those would report the
# method as broken when it is fine.
Write-Host ''
Write-Host '=== probe ===' -ForegroundColor Cyan

$probe = $null

foreach ($candidate in ($toChange | Select-Object -First 8)) {
    try {
        Set-Owner $candidate.id | Out-Null
        $probe = $candidate
        break
    } catch {
        if (Test-Forbidden $_) {
            Write-Host "  lead $($candidate.number): not accessible to this key, trying another"
            continue
        }

        Write-Host "  FAILED on lead $($candidate.number) - HTTP $(Get-Status $_)" -ForegroundColor Red
        Write-Host ('  ' + (Get-Body $_))
        Write-Host '  Nothing else was touched.' -ForegroundColor Red
        return
    }
}

if (-not $probe) {
    Write-Host '  every lead tried was refused. Stopping.' -ForegroundColor Red
    return
}

Start-Sleep -Milliseconds $DelayMs
$after = Invoke-Api GET "/leads/$($probe.id)" $null

if ($after.ownerId -ne $OwnerId) {
    Write-Host '  the write was accepted but the owner did not change.' -ForegroundColor Red
    Write-Host "  ownerId is still $($after.ownerId). Stopping."
    return
}

Write-Host "  lead $($probe.number): confirmed." -ForegroundColor Green

# -------------------------------------------------------------- the rest
$results   = @()
$changed   = 1
$forbidden = 0
$failed    = 0

$rest = @($toChange | Where-Object { $_.id -ne $probe.id })

Write-Host ''
Write-Host "=== applying to the remaining $($rest.Count) ===" -ForegroundColor Cyan

foreach ($lead in $rest) {
    $outcome = 'changed'

    try {
        Set-Owner $lead.id | Out-Null
        $changed++
    } catch {
        $code = Get-Status $_

        if (Test-Forbidden $_) {
            # Expected for the handful this key may not see. Not a fault to
            # stop on: those need a permission in Surense, not another try.
            $forbidden++
            $outcome = 'not-authorized'
        }
        elseif ($code -eq 429) {
            # A rate limit is not a failure. Wait it out and take the same
            # lead again rather than letting it fall through unchanged.
            Start-Sleep -Seconds 30
            try { Set-Owner $lead.id | Out-Null; $changed++ }
            catch { $failed++; $outcome = "failed $(Get-Status $_)" }
        }
        else {
            $failed++
            $outcome = "failed $code"
        }
    }

    $results += [pscustomobject]@{
        leadNumber = $lead.number
        id         = $lead.id
        wasOwner   = $lead.ownerName
        result     = $outcome
    }

    Write-Host -NoNewline "`r  $changed changed, $forbidden not-authorized, $failed failed  "
    Start-Sleep -Milliseconds $DelayMs
}

$results | Export-Csv -Path $logCsv -NoTypeInformation -Encoding UTF8

Write-Host ''
Write-Host ''
Write-Host '=== done ===' -ForegroundColor Green
Write-Host "  changed        : $changed"
Write-Host "  not authorized : $forbidden   (need a permission in Surense)"
Write-Host "  failed         : $failed"
Write-Host "  log            : $logCsv"
Write-Host "  undo           : .\set-lead-owner.ps1 -Undo `"$backupCsv`""
