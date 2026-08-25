<#
.SYNOPSIS
    Pulls leads from Surense and keeps a local spreadsheet file in step.

.DESCRIPTION
    The same logic as the Apps Script mirror, as a script that runs on your own
    machine. It reads the CRM and writes a CSV that Excel opens directly.

    Rows are matched by lead id and rewritten only when their values actually
    changed, so the "last changed" column means when that row changed, not when
    the script last ran. Three columns are maintained:

        עודכן        when this row last really changed
        סוג שינוי    בסיס / חדש / עודכן / לא נמצא ב-CRM
        _hash        fingerprint used to detect a change; leave it alone

    The CRM is only ever read. The script calls /oauth/token, /leads/fields and
    /leads/search, and nothing else. There is no code path that writes to
    Surense.

    A second file records the history: one line per field that changed.

.PARAMETER OutFile
    The spreadsheet to maintain. It is read at the start and rewritten at the
    end, so the previous run's timestamps survive.

.EXAMPLE
    .\sync-leads.ps1 -ClientId cid_xxx -ClientSecret csk_xxx

.EXAMPLE
    .\sync-leads.ps1 -ClientId cid_xxx -ClientSecret csk_xxx -WhatIf
    Shows what would change without touching the file.

.NOTES
    The secret lands in PowerShell history when passed on the command line.
    Clear it with: Remove-Item (Get-PSReadlineOption).HistorySavePath
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)][string]$ClientId,
    [Parameter(Mandatory = $true)][string]$ClientSecret,

    [string]$OutFile   = "$PSScriptRoot\leads.csv",
    [string]$ChangeLog = "$PSScriptRoot\leads-changes.csv",

    [string]$TokenUrl = 'https://api.surense.com/oauth/token',

    # Tried in order; the first that answers is used. The token's "aud" claim
    # and the integration notes disagree on the host, so both are candidates.
    [string[]]$ApiBase = @(
        'https://api.surense.com/api/v1',
        'https://www.surense.com/api/v1'
    ),

    [int]$PageSize = 50,
    [int]$MaxPages = 400
)

$ErrorActionPreference = 'Stop'

# Windows PowerShell 5.1 still negotiates TLS 1.0, which the API refuses.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$STAMP_COL  = 'עודכן'
$TYPE_COL   = 'סוג שינוי'
$HASH_COL   = '_hash'
$ID_COL     = '_id'
$META = @($ID_COL, $STAMP_COL, $TYPE_COL, $HASH_COL)

$CHANGE_BASELINE = 'בסיס'
$CHANGE_ADDED    = 'חדש'
$CHANGE_UPDATED  = 'עודכן'
$CHANGE_MISSING  = 'לא נמצא ב-CRM'

function Write-Step { param($T) Write-Host "`n=== $T ===" -ForegroundColor Cyan }
function Write-Ok   { param($T) Write-Host "  $T" -ForegroundColor Green }
function Write-Bad  { param($T) Write-Host "  $T" -ForegroundColor Red }
function Write-Note { param($T) Write-Host "  $T" -ForegroundColor Yellow }

function Get-HttpError {
    param($ErrorRecord)

    $response = $ErrorRecord.Exception.Response
    if (-not $response) { return "no response: $($ErrorRecord.Exception.Message)" }

    $code = [int]$response.StatusCode
    $body = ''

    # PowerShell 7 exposes the response body here and its Response object has
    # no GetResponseStream; 5.1 is the other way round. Try both.
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
        $body = $ErrorRecord.ErrorDetails.Message
    } else {
        try {
            $body = (New-Object IO.StreamReader($response.GetResponseStream())).ReadToEnd()
        } catch { }
    }

    $meaning = switch ($code) {
        401 { 'credentials rejected - the secret was probably rotated' }
        403 { 'authenticated, but this client lacks the scope' }
        404 { 'wrong path - check the API base' }
        429 { 'rate limited - wait a minute' }
        default { '' }
    }

    if ($meaning) { return "HTTP $code - $meaning`n       $body" }
    return "HTTP $code`n       $body"
}

<# Picks the array out of whatever envelope the API wraps it in. #>
function Get-Rows {
    param($Response)

    if ($Response -is [array]) { return $Response }

    $names = $Response.PSObject.Properties.Name
    foreach ($key in 'rows', 'data', 'results', 'items', 'leads', 'fields') {
        if ($names -contains $key) { return @($Response.$key) }
    }

    return @($Response)
}

<# Renders one API value as a single cell. Nested lookups arrive as objects. #>
function ConvertTo-Cell {
    param($Value)

    if ($null -eq $Value) { return '' }

    # Invoke-RestMethod turns an ISO timestamp into a [datetime], and casting
    # that to a string uses the machine's locale — so the same CRM value would
    # render differently on a Hebrew and an English Windows, and the row hash
    # would differ with it. Pin the format instead.
    if ($Value -is [datetime]) { return $Value.ToString('yyyy-MM-dd HH:mm:ss') }

    if ($Value -is [string] -or $Value -is [int] -or $Value -is [double] -or
        $Value -is [bool]) {
        return [string]$Value
    }
    if ($Value -is [array]) {
        return (($Value | ForEach-Object { ConvertTo-Cell $_ }) -join ', ')
    }

    foreach ($key in 'name', 'title', 'label', 'value', 'displayName') {
        if ($Value.PSObject.Properties.Name -contains $key -and $Value.$key) {
            return [string]$Value.$key
        }
    }

    return ($Value | ConvertTo-Json -Depth 3 -Compress)
}

function Get-RowHash {
    param([string[]]$Values)

    $md5 = [Security.Cryptography.MD5]::Create()
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Values -join "`u{001F}"))
    return [BitConverter]::ToString($md5.ComputeHash($bytes)).Replace('-', '')
}

<# Export-Csv writes a BOM on 5.1 but not on 7+, and Excel needs one for Hebrew. #>
function Export-Spreadsheet {
    param($Rows, [string]$Path)

    $encoding = 'UTF8'
    if ($PSVersionTable.PSVersion.Major -ge 6) { $encoding = 'utf8BOM' }
    $Rows | Export-Csv -Path $Path -NoTypeInformation -Encoding $encoding
}

# ---------------------------------------------------------------- 1. token
Write-Step 'Connecting to Surense'

try {
    $auth = Invoke-RestMethod -Method Post -Uri $TokenUrl `
        -ContentType 'application/x-www-form-urlencoded' `
        -Body "grant_type=client_credentials&client_id=$ClientId&client_secret=$ClientSecret"
} catch {
    Write-Bad (Get-HttpError $_)
    exit 1
}

if (-not $auth.access_token) {
    Write-Bad 'The token response contained no access_token.'
    exit 1
}

Write-Ok "authenticated (scopes: $($auth.scope))"
$headers = @{ Authorization = "Bearer $($auth.access_token)" }

# ------------------------------------------------------- 2. find the API base
$base = $null

foreach ($candidate in $ApiBase) {
    try {
        $fieldsResponse = Invoke-RestMethod -Uri "$candidate/leads/fields" -Headers $headers
        $base = $candidate
        Write-Ok "API base: $base"
        break
    } catch {
        Write-Host "  -- $candidate did not answer" -ForegroundColor DarkGray
    }
}

if (-not $base) {
    Write-Bad 'No API base answered. Check the host with Surense.'
    exit 1
}

# --------------------------------------------------------------- 3. columns
$fieldDefs = Get-Rows $fieldsResponse
$columns = @()

foreach ($field in $fieldDefs) {
    if ($field -is [string]) {
        $columns += [pscustomobject]@{ Key = $field; Label = $field }
        continue
    }

    $key = $field.key
    if (-not $key) { $key = $field.name }
    if (-not $key) { $key = $field.field }
    if (-not $key) { $key = $field.id }
    if (-not $key) { continue }

    $label = $field.label
    if (-not $label) { $label = $field.title }
    if (-not $label) { $label = $key }

    # Two CRM fields can share a display label; the column headers must not.
    if ($columns.Label -contains $label) { $label = "$label ($key)" }

    $columns += [pscustomobject]@{ Key = [string]$key; Label = [string]$label }
}

if (-not $columns.Count) {
    Write-Bad 'The CRM returned no usable field definitions.'
    exit 1
}

Write-Ok "$($columns.Count) columns from the CRM schema"

# ----------------------------------------------------------------- 4. leads
Write-Step 'Reading leads'

$leads = @()
$startRow = 0
$complete = $false

for ($page = 0; $page -lt $MaxPages; $page++) {
    try {
        $body = @{
            startRow = $startRow
            endRow   = $startRow + $PageSize
            sorts    = @(@{ field = 'statusDate'; dir = 'asc' })
            filters  = @()
        } | ConvertTo-Json -Depth 4

        $response = Invoke-RestMethod -Method Post -Uri "$base/leads/search" `
            -Headers $headers -ContentType 'application/json' -Body $body
    } catch {
        Write-Bad (Get-HttpError $_)
        Write-Note 'The file was left untouched.'
        exit 1
    }

    $batch = Get-Rows $response
    if ($batch.Count -gt 0) { $leads += $batch }

    Write-Host "`r  read $($leads.Count) leads..." -NoNewline

    $hasNext = $batch.Count -eq $PageSize
    if ($null -ne $response.hasNextPage) { $hasNext = [bool]$response.hasNextPage }

    if (-not $hasNext -or $batch.Count -eq 0) { $complete = $true; break }
    $startRow += $PageSize
}

Write-Host ''

# A partial read must not be written: every lead not read would look deleted.
if (-not $complete) {
    Write-Bad "Stopped after $MaxPages pages without reaching the end."
    Write-Note 'The file was left untouched. Raise -MaxPages and retry.'
    exit 1
}

if ($leads.Count -eq 0) {
    Write-Bad 'The CRM returned no leads at all.'
    Write-Note 'The file was left untouched - this is more likely a fault than an empty CRM.'
    exit 1
}

Write-Ok "$($leads.Count) leads read"

# ----------------------------------------------------- 5. what is on disk now
$previous = @{}
$previousOrder = @()
$isBaseline = $true

if (Test-Path $OutFile) {
    $existing = @(Import-Csv -Path $OutFile)

    if ($existing.Count -gt 0) {
        $headerNames = $existing[0].PSObject.Properties.Name

        # Without the meta columns this file was not written by this script -
        # treat it as a baseline rather than guessing at its layout.
        if (($META | Where-Object { $headerNames -notcontains $_ }).Count -eq 0) {
            $isBaseline = $false

            foreach ($row in $existing) {
                $id = [string]$row.$ID_COL
                if (-not $id) { continue }
                $previous[$id] = $row
                $previousOrder += $id
            }
        }
    }
}

if ($isBaseline) {
    Write-Note 'No previous sync found - this run records a baseline.'
} else {
    Write-Ok "$($previous.Count) rows from the previous sync"
}

# ------------------------------------------------------------- 6. build rows
Write-Step 'Comparing against the CRM'

$now = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
$out = New-Object Collections.ArrayList
$changes = New-Object Collections.ArrayList
$seen = @{}
$added = 0; $updated = 0; $unchanged = 0; $missing = 0

foreach ($lead in $leads) {
    $cells = @()
    foreach ($column in $columns) { $cells += (ConvertTo-Cell $lead.($column.Key)) }

    $id = [string]$lead.id
    if (-not $id) { $id = [string]$lead.leadId }
    if (-not $id) { $id = $cells[0] }

    $hash = Get-RowHash $cells
    $prior = $previous[$id]

    if ($isBaseline) {
        $stamp = $now; $type = $CHANGE_BASELINE
    } elseif (-not $prior) {
        $stamp = $now; $type = $CHANGE_ADDED; $added++
        [void]$changes.Add([pscustomobject]@{
            'תאריך' = $now; 'מזהה ליד' = $id; 'סוג שינוי' = $CHANGE_ADDED
            'עמודה' = ''; 'לפני' = ''; 'אחרי' = ($cells -join ' | ')
        })
    } elseif ([string]$prior.$HASH_COL -ne $hash) {
        $stamp = $now; $type = $CHANGE_UPDATED; $updated++

        for ($i = 0; $i -lt $columns.Count; $i++) {
            $was = [string]$prior.($columns[$i].Label)
            $is  = [string]$cells[$i]

            if ($was -ne $is) {
                [void]$changes.Add([pscustomobject]@{
                    'תאריך' = $now; 'מזהה ליד' = $id; 'סוג שינוי' = $CHANGE_UPDATED
                    'עמודה' = $columns[$i].Label; 'לפני' = $was; 'אחרי' = $is
                })
            }
        }
    } else {
        # Untouched: keep the stamp from whenever this row last really changed.
        $stamp = [string]$prior.$STAMP_COL
        $type  = [string]$prior.$TYPE_COL
        $unchanged++
    }

    $record = [ordered]@{}
    for ($i = 0; $i -lt $columns.Count; $i++) { $record[$columns[$i].Label] = $cells[$i] }
    $record[$ID_COL] = $id
    $record[$STAMP_COL] = $stamp
    $record[$TYPE_COL] = $type
    $record[$HASH_COL] = $hash

    [void]$out.Add([pscustomobject]$record)
    $seen[$id] = $true
}

# Leads the CRM no longer returns. Kept and flagged, not deleted: a vanished
# lead is more often a changed filter or permission than a real deletion.
if (-not $isBaseline) {
    foreach ($id in $previousOrder) {
        if ($seen[$id]) { continue }

        $prior = $previous[$id]
        $alreadyFlagged = [string]$prior.$TYPE_COL -eq $CHANGE_MISSING

        $record = [ordered]@{}
        foreach ($column in $columns) { $record[$column.Label] = [string]$prior.($column.Label) }
        $record[$ID_COL] = $id
        $flaggedStamp = $now
        if ($alreadyFlagged) { $flaggedStamp = [string]$prior.$STAMP_COL }
        $record[$STAMP_COL] = $flaggedStamp
        $record[$TYPE_COL] = $CHANGE_MISSING
        $record[$HASH_COL] = [string]$prior.$HASH_COL

        [void]$out.Add([pscustomobject]$record)

        if (-not $alreadyFlagged) {
            $missing++
            [void]$changes.Add([pscustomobject]@{
                'תאריך' = $now; 'מזהה ליד' = $id; 'סוג שינוי' = $CHANGE_MISSING
                'עמודה' = ''; 'לפני' = ''; 'אחרי' = ''
            })
        }
    }
}

# ----------------------------------------------------------------- 7. report
Write-Host ''
$addedColour   = 'Gray'; if ($added)   { $addedColour   = 'Green'  }
$updatedColour = 'Gray'; if ($updated) { $updatedColour = 'Yellow' }
$missingColour = 'Gray'; if ($missing) { $missingColour = 'Red'    }

Write-Host ("  {0,-22} {1}" -f 'לידים ב-CRM:', $leads.Count)
Write-Host ("  {0,-22} {1}" -f 'חדשים:', $added)        -ForegroundColor $addedColour
Write-Host ("  {0,-22} {1}" -f 'עודכנו:', $updated)      -ForegroundColor $updatedColour
Write-Host ("  {0,-22} {1}" -f 'ללא שינוי:', $unchanged)
Write-Host ("  {0,-22} {1}" -f 'נעלמו מה-CRM:', $missing) -ForegroundColor $missingColour

if ($changes.Count -gt 0) {
    Write-Host "`n  מה השתנה:" -ForegroundColor White
    $changes | Select-Object -First 25 | ForEach-Object {
        if ($_.'עמודה') {
            Write-Host ("    {0}  {1}: {2} -> {3}" -f $_.'מזהה ליד', $_.'עמודה', $_.'לפני', $_.'אחרי')
        } else {
            Write-Host ("    {0}  {1}" -f $_.'מזהה ליד', $_.'סוג שינוי')
        }
    }
    if ($changes.Count -gt 25) { Write-Host "    ... ועוד $($changes.Count - 25)" }
}

# ------------------------------------------------------------------ 8. write
if (-not $PSCmdlet.ShouldProcess($OutFile, 'write')) {
    Write-Note "`nWhatIf: nothing was written."
    exit 0
}

Write-Step 'Writing'

# Keep one rollback copy: this file is the only record of the timestamps.
if (Test-Path $OutFile) { Copy-Item $OutFile "$OutFile.bak" -Force }

Export-Spreadsheet -Rows $out -Path $OutFile
Write-Ok "$OutFile  ($($out.Count) rows)"

if ($changes.Count -gt 0) {
    $history = @()
    if (Test-Path $ChangeLog) { $history = @(Import-Csv $ChangeLog) }
    Export-Spreadsheet -Rows ($history + $changes) -Path $ChangeLog
    Write-Ok "$ChangeLog  (+$($changes.Count) lines)"
}

Write-Host "`nDone. Nothing was written to the CRM." -ForegroundColor Green
