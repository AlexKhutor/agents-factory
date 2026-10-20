[CmdletBinding(SupportsShouldProcess, DefaultParameterSetName = "Registered")]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,63}$')]
    [string]$SourceId,
    [Parameter(Mandatory = $true, ParameterSetName = "Unregistered")]
    [string]$WorkspaceRoot,
    [Parameter(Mandatory = $true, ParameterSetName = "Unregistered")]
    [ValidateSet("claude-handoff", "foreign-provider-handoff")]
    [string]$CoordinationProfile,
    [Parameter(Mandatory = $true, ParameterSetName = "Unregistered")]
    [ValidatePattern('^[a-f0-9]{64}$')]
    [string]$ExpectedKitManifestSha256,
    [string]$RepoRoot,
    [string]$ExpectedProjectName,
    [switch]$PlanOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "project_tooling_common.ps1")

# PowerShell 5.1 Get-FileHash inherits WhatIf into its internal provider lookup.
# Hashing is read-only and must still run during installation preview.
function Get-FileHash {
    param([string]$LiteralPath, [string]$Algorithm = 'SHA256')
    if ($Algorithm -ne 'SHA256') { throw 'Only SHA256 is supported.' }
    $stream = [IO.File]::OpenRead($LiteralPath)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        [pscustomobject]@{ Hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '') }
    }
    finally { $hasher.Dispose(); $stream.Dispose() }
}

function Resolve-InsideRoot {
    param([string]$Root, [string]$RelativePath)
    if ([IO.Path]::IsPathRooted($RelativePath) -or $RelativePath -split '[\\/]' -contains '..') {
        throw "Unsafe child kit path '$RelativePath'."
    }
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath((Join-Path $resolvedRoot $RelativePath))
    if (-not $candidate.StartsWith($resolvedRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Child kit path escaped its root: '$RelativePath'."
    }
    $ancestor = $candidate
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and
            ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Child kit path contains a reparse point: '$RelativePath'."
        }
        $ancestor = [IO.Path]::GetDirectoryName($ancestor)
    }
    return $candidate
}

function Write-Utf8Atomic {
    param([string]$Path, [string]$Text)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
    $temporary = "$Path.$PID.$([guid]::NewGuid().ToString('N')).tmp"
    try {
        [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
}

function Set-ObjectProperty {
    param([psobject]$Object, [string]$Name, [object]$Value)
    if ($Object.PSObject.Properties[$Name]) { $Object.$Name = $Value }
    else { $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value }
}

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "install_child_coordination_kit" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    SourceId = $SourceId
    SelectionMode = $PSCmdlet.ParameterSetName
}
$resultData = @{}

try {
    $registryPath = Join-Path $resolvedRepoRoot "config\source-registry.json"
    $bindingsPath = Join-Path $resolvedRepoRoot ".project-local\source-bindings.json"
    if ($PSCmdlet.ParameterSetName -eq "Unregistered") {
        if (-not [IO.Path]::IsPathRooted($WorkspaceRoot)) { throw "Explicit workspace path must be absolute." }
        $workspaceRoot = [IO.Path]::GetFullPath($WorkspaceRoot)
        $existingContractPath = Resolve-InsideRoot -Root $workspaceRoot -RelativePath '.orchestrator/contract.json'
        $existingContract = if (Test-Path -LiteralPath $existingContractPath -PathType Leaf) {
            Get-Content -LiteralPath $existingContractPath -Raw | ConvertFrom-Json
        } else { $null }
        if ($null -eq $existingContract -and $CoordinationProfile -ne 'foreign-provider-handoff') {
            throw 'Existing Claude contract is required.'
        }
        if ($CoordinationProfile -eq 'foreign-provider-handoff') {
            $ownerVersionPath = Resolve-InsideRoot -Root $workspaceRoot -RelativePath 'project-version.json'
            $ownerVersion = Get-Content -LiteralPath $ownerVersionPath -Raw | ConvertFrom-Json
            if ([string]::IsNullOrWhiteSpace($ExpectedProjectName) -or
                [string]$ownerVersion.projectName -cne $ExpectedProjectName) {
                throw 'Explicit foreign workspace project identity mismatch.'
            }
        }
        if ($null -ne $existingContract -and ([int]$existingContract.schemaVersion -ne 1 -or [string]$existingContract.sourceId -ne $SourceId -or
            [string]$existingContract.taskInbox -ne '.orchestrator/tasks/inbox' -or
            [string]$existingContract.reportOutbox -ne '.orchestrator/reports/outbox')) {
            throw "Existing contract does not identify the selected workspace."
        }
        if ($null -ne $existingContract -and (($existingContract.PSObject.Properties['kitProfile'] -and $existingContract.kitProfile -ne $CoordinationProfile) -or
            ($existingContract.PSObject.Properties['executorState'] -and $existingContract.executorState -ne 'foreign-owner-required'))) {
            throw "Existing workspace profile or executor state conflicts with preparation."
        }
        if (Test-Path -LiteralPath (Join-Path $workspaceRoot '.orchestrator/workspace-endpoint.json')) {
            throw "Workspace already has an endpoint; use its registered lifecycle."
        }
        $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
        $bindings = Get-Content -LiteralPath $bindingsPath -Raw | ConvertFrom-Json
        if (@($registry.sources | Where-Object { [string]$_.id -eq $SourceId }).Count -gt 0 -or
            $bindings.sources.PSObject.Properties[$SourceId]) {
            throw "Source already has controller registration or binding; use registered mode."
        }
        foreach ($registeredBinding in $bindings.sources.PSObject.Properties) {
            foreach ($pathName in @('workspacePath', 'path')) {
                $boundPath = $registeredBinding.Value.PSObject.Properties[$pathName]
                if ($boundPath -and -not [string]::IsNullOrWhiteSpace([string]$boundPath.Value) -and
                    [IO.Path]::GetFullPath([string]$boundPath.Value).TrimEnd('\', '/') -eq $workspaceRoot.TrimEnd('\', '/')) {
                    throw "Workspace path is already bound to another source."
                }
            }
        }
        $source = [pscustomobject]@{
            coordinationProfile = $CoordinationProfile
            executorState = 'foreign-owner-required'
            taskInbox = '.orchestrator/tasks/inbox'
            reportOutbox = '.orchestrator/reports/outbox'
        }
    }
    else {
    $registry = Get-Content -LiteralPath $registryPath -Raw | ConvertFrom-Json
    $bindings = Get-Content -LiteralPath $bindingsPath -Raw | ConvertFrom-Json
    $sources = @($registry.sources | Where-Object { [string]$_.id -eq $SourceId })
    if ($sources.Count -ne 1) { throw "Source '$SourceId' must occur exactly once in the controller registry." }
    $source = $sources[0]
    $binding = $bindings.sources.PSObject.Properties[$SourceId]
    if (-not $binding) { throw "Source '$SourceId' has no machine-local binding." }
    $workspaceText = [string]$binding.Value.workspacePath
    if ([string]::IsNullOrWhiteSpace($workspaceText)) { $workspaceText = [string]$binding.Value.path }
    if ([string]::IsNullOrWhiteSpace($workspaceText)) { throw "Source '$SourceId' binding has no workspace path." }
    $workspaceRoot = [IO.Path]::GetFullPath($workspaceText)
    }
    if (-not (Test-Path -LiteralPath $workspaceRoot -PathType Container)) {
        throw "Source '$SourceId' workspace does not exist."
    }
    $versionPath = Resolve-InsideRoot -Root $workspaceRoot -RelativePath 'project-version.json'
    $versionBefore = Get-Content -LiteralPath $versionPath -Raw
    $projectVersion = $versionBefore | ConvertFrom-Json
    $contractPath = Resolve-InsideRoot -Root $workspaceRoot -RelativePath '.orchestrator/contract.json'
    $childManifestPath = Resolve-InsideRoot -Root $workspaceRoot -RelativePath '.orchestrator/kit-manifest.json'

    $kitRoot = Join-Path $resolvedRepoRoot "coordination\child-agent-kit"
    $manifestPath = Join-Path $kitRoot "kit-manifest.json"
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($ExpectedKitManifestSha256 -and
        (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ExpectedKitManifestSha256) {
        throw "Selected child kit manifest hash does not match the expected package."
    }
    if ([int]$manifest.schemaVersion -ne 1 -or @($manifest.files).Count -eq 0 -or
        -not $manifest.profiles -or -not $manifest.componentVersions) {
        throw "Child coordination kit manifest is incompatible."
    }
    $profileId = if ($source.PSObject.Properties["coordinationProfile"]) {
        [string]$source.coordinationProfile
    }
    else { $null }
    if ([string]::IsNullOrWhiteSpace($profileId)) {
        $profileId = if ([string]$source.executionAdapter -eq "claude-code-workspace-handoff-v1") {
            "claude-handoff"
        }
        else { "codex" }
    }
    $profileProperty = $manifest.profiles.PSObject.Properties[$profileId]
    if (-not $profileProperty) { throw "Child coordination profile '$profileId' is unavailable." }
    $profile = $profileProperty.Value
    if ($profileId -eq 'foreign-provider-handoff') {
        $checker = Resolve-InsideRoot -Root $resolvedRepoRoot -RelativePath 'coordination/accepted-delivery/verify-accepted-delivery.mjs'
        $lock = Resolve-InsideRoot -Root $resolvedRepoRoot -RelativePath 'coordination/contracts/accepted-delivery.v1.json'
        $verifiedText = & node.exe $checker --lock $lock --artifact child-agent-kit --root $kitRoot
        if ($LASTEXITCODE -ne 0) { throw 'Accepted child kit preflight failed.' }
        $verified = ($verifiedText -join "`n") | ConvertFrom-Json
        if ($verified.status -ne 'verified') { throw 'Accepted child kit is not verified.' }
    }
    $sourceExecutorState = if ($source.PSObject.Properties["executorState"]) {
        [string]$source.executorState
    }
    else { $null }
    if ($sourceExecutorState -and $sourceExecutorState -ne [string]$profile.executorState) {
        throw "Source executor state does not match coordination profile '$profileId'."
    }
    $excludedFiles = @($manifest.commonExcludedFiles) + @($profile.excludedFiles)
    $selectedFiles = @($manifest.files | Where-Object { [string]$_ -notin $excludedFiles })
    $copies = @()
    foreach ($relative in $selectedFiles) {
        $portable = ([string]$relative).Replace('/', '\')
        $sourcePath = Resolve-InsideRoot -Root $kitRoot -RelativePath $portable
        $destinationPath = Resolve-InsideRoot -Root $workspaceRoot -RelativePath $portable
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Child kit source is missing: $relative"
        }
        $copies += [pscustomobject]@{ Relative = [string]$relative; Source = $sourcePath; Destination = $destinationPath }
    }
    # An accepted payload proves its bytes, not ownership of an occupied target.
    # Foreign shells require owner reconciliation before replacing different bytes.
    if ($profileId -eq 'foreign-provider-handoff') {
        foreach ($copy in $copies) {
            if (Test-Path -LiteralPath $copy.Destination) {
                if (-not (Test-Path -LiteralPath $copy.Destination -PathType Leaf) -or
                    (Get-FileHash -LiteralPath $copy.Destination -Algorithm SHA256).Hash -ne
                    (Get-FileHash -LiteralPath $copy.Source -Algorithm SHA256).Hash) {
                    throw "child_kit_destination_conflict: $($copy.Relative); owner reconciliation required before installation."
                }
            }
        }
    }
    $applyInstall = -not $PlanOnly -and $PSCmdlet.ShouldProcess($workspaceRoot, "Install $($manifest.kitVersion) child kit for $SourceId ($profileId)")
    $backupRoot = $null
    if ($applyInstall) {
        $backupRoot = Join-Path $resolvedRepoRoot ".project-local/child-kit-backups/$SourceId/$([guid]::NewGuid().ToString('N'))"
        $backupEntries = @()
        $backupPaths = @($copies | ForEach-Object { $_.Relative }) + @('project-version.json', '.orchestrator/contract.json', '.orchestrator/kit-manifest.json')
        foreach ($relative in $backupPaths) {
            $original = Resolve-InsideRoot -Root $workspaceRoot -RelativePath $relative
            if (-not (Test-Path -LiteralPath $original -PathType Leaf)) { continue }
            $saved = Resolve-InsideRoot -Root $backupRoot -RelativePath $relative
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $saved) | Out-Null
            Copy-Item -LiteralPath $original -Destination $saved
            $originalHash = (Get-FileHash -LiteralPath $original -Algorithm SHA256).Hash.ToLowerInvariant()
            if ((Get-FileHash -LiteralPath $saved -Algorithm SHA256).Hash.ToLowerInvariant() -ne $originalHash) {
                throw "Child kit backup verification failed: $relative"
            }
            $backupEntries += [ordered]@{ path = $relative; sha256 = $originalHash }
        }
        Write-Utf8Atomic -Path (Join-Path $backupRoot 'backup.json') -Text (([ordered]@{
            schemaVersion = 1; sourceId = $SourceId; workspaceRoot = $workspaceRoot
            kitVersion = [string]$manifest.kitVersion; files = @($backupEntries)
        } | ConvertTo-Json -Depth 10) + "`n")
    }
    $copied = 0
    $unchanged = 0
    $deferredDestinations = @()
    foreach ($copy in $copies) {
        $sourceHash = (Get-FileHash -LiteralPath $copy.Source -Algorithm SHA256).Hash
        $destinationHash = if (Test-Path -LiteralPath $copy.Destination -PathType Leaf) {
            (Get-FileHash -LiteralPath $copy.Destination -Algorithm SHA256).Hash
        } else { $null }
        if ($sourceHash -eq $destinationHash) { $unchanged++; continue }
        if ($applyInstall) {
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $copy.Destination) | Out-Null
            $temporary = "$($copy.Destination).$PID.tmp"
            try {
                Copy-Item -LiteralPath $copy.Source -Destination $temporary -Force
                if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $sourceHash) {
                    throw "Child kit copy hash mismatch: $($copy.Relative)"
                }
                Move-Item -LiteralPath $temporary -Destination $copy.Destination -Force
            }
            finally { Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue }
            $copied++
        }
        else {
            $deferredDestinations += $copy.Destination
        }
    }
    if (-not $projectVersion.PSObject.Properties["componentVersions"]) {
        Set-ObjectProperty -Object $projectVersion -Name "componentVersions" -Value ([pscustomobject]@{})
    }
    $versionChanged = $false
    foreach ($component in $manifest.componentVersions.PSObject.Properties) {
        $existingComponent = $projectVersion.componentVersions.PSObject.Properties[$component.Name]
        if (-not $existingComponent -or [string]$existingComponent.Value -ne [string]$component.Value) {
            Set-ObjectProperty -Object $projectVersion.componentVersions -Name $component.Name -Value ([string]$component.Value)
            $versionChanged = $true
        }
    }
    $versionUpdateApplied = $false
    if ($versionChanged) {
        if ($applyInstall) {
            if ((Get-Content -LiteralPath $versionPath -Raw) -cne $versionBefore) {
                throw "Owner project version changed during kit installation; inspect the preserved backup before recovery."
            }
            Write-Utf8Atomic -Path $versionPath -Text (($projectVersion | ConvertTo-Json -Depth 30) + "`n")
            $versionUpdateApplied = $true
        }
    }
    $contract = [ordered]@{
        schemaVersion = 1
        sourceId = $SourceId
        kitVersion = [string]$manifest.kitVersion
        kitProfile = $profileId
        executorState = [string]$profile.executorState
        taskContractVersion = [string]$manifest.taskContractVersion
        supportedTaskContractVersions = [object[]]@($manifest.supportedTaskContractVersions)
        reportContractVersion = [string]$manifest.reportContractVersion
        taskInbox = [string]$source.taskInbox
        reportOutbox = [string]$source.reportOutbox
        coordinatorId = "agents-factory-control"
    }
    $contractPath = Join-Path $workspaceRoot ".orchestrator\contract.json"
    $childManifestPath = Join-Path $workspaceRoot ".orchestrator\kit-manifest.json"
    $expectedManifestSha256 = (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $desiredContractCanonical = $contract | ConvertTo-Json -Depth 12 -Compress
    $existingContractCanonical = if (Test-Path -LiteralPath $contractPath -PathType Leaf) {
        (Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json) |
            ConvertTo-Json -Depth 12 -Compress
    }
    else { $null }
    $contractChanged = $existingContractCanonical -ne $desiredContractCanonical
    $manifestChanged = -not (Test-Path -LiteralPath $childManifestPath -PathType Leaf) -or
        (Get-FileHash -LiteralPath $childManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            $expectedManifestSha256
    $contractApplied = -not $contractChanged
    $manifestApplied = -not $manifestChanged
    if ($contractChanged -and $applyInstall) {
        Write-Utf8Atomic -Path $contractPath -Text (($contract | ConvertTo-Json -Depth 12) + "`n")
        $contractApplied = $true
    }
    if ($manifestChanged -and $applyInstall) {
        $temporaryManifest = "$childManifestPath.$PID.$([guid]::NewGuid().ToString('N')).tmp"
        try {
            Copy-Item -LiteralPath $manifestPath -Destination $temporaryManifest
            if ((Get-FileHash -LiteralPath $temporaryManifest).Hash.ToLowerInvariant() -ne $expectedManifestSha256) {
                throw 'Copied child kit manifest hash mismatch.'
            }
            Move-Item -LiteralPath $temporaryManifest -Destination $childManifestPath -Force
        }
        finally { Remove-Item -LiteralPath $temporaryManifest -Force -ErrorAction SilentlyContinue }
        $manifestApplied = $true
    }
    if ($contractApplied) {
        $verifiedContractCanonical = (Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json) |
            ConvertTo-Json -Depth 12 -Compress
        if ($verifiedContractCanonical -ne $desiredContractCanonical) {
            throw "Installed child coordination contract failed verification."
        }
    }
    if ($manifestApplied -and
        (Get-FileHash -LiteralPath $childManifestPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne
            $expectedManifestSha256) {
        throw "Installed child kit manifest failed verification."
    }
    foreach ($copy in $copies) {
        if ($copy.Destination -in $deferredDestinations) { continue }
        if ((Get-FileHash -LiteralPath $copy.Source -Algorithm SHA256).Hash -ne
            (Get-FileHash -LiteralPath $copy.Destination -Algorithm SHA256).Hash) {
            throw "Installed child kit failed verification: $($copy.Relative)"
        }
    }
    $resultData = @{
        SourceId = $SourceId
        SelectionMode = $PSCmdlet.ParameterSetName
        BackupRoot = $backupRoot
        ProviderStarted = $false
        RegistrationChanged = $false
        WorkspaceRoot = $workspaceRoot
        KitVersion = [string]$manifest.kitVersion
        KitProfile = $profileId
        ExecutorState = [string]$profile.executorState
        FileCount = $copies.Count
        CopiedCount = $copied
        UnchangedCount = $unchanged
        DeferredCount = $deferredDestinations.Count
        ComponentVersionsUpdated = $versionUpdateApplied
        ContractUpdated = [bool]($contractChanged -and $contractApplied)
        ManifestUpdated = [bool]($manifestChanged -and $manifestApplied)
        ContractPath = $contractPath
        ManifestSha256 = $expectedManifestSha256
    }
    Write-Host "child_source_id: $SourceId"
    if ($applyInstall -and $profileId -eq 'foreign-provider-handoff') {
        $verifiedText = & node.exe $checker --lock $lock --artifact child-agent-kit --profile $profileId --root $workspaceRoot
        if ($LASTEXITCODE -ne 0) { throw 'Installed accepted child kit verification failed.' }
        $verified = ($verifiedText -join "`n") | ConvertFrom-Json
        if ($verified.status -ne 'verified') { throw 'Installed accepted child kit is not verified.' }
        $receiptPath = Join-Path $backupRoot 'installation-receipt.json'
        Write-Utf8Atomic -Path $receiptPath -Text (([ordered]@{
            schemaVersion = 1; result = $resultData; verification = $verified
            completedAtUtc = [datetime]::UtcNow.ToString('o')
        } | ConvertTo-Json -Depth 12) + "`n")
        $resultData['ReceiptPath'] = $receiptPath
    }
    Write-Host "child_kit_version: $($manifest.kitVersion)"
    Write-Host "child_kit_profile: $profileId"
    Write-Host "child_executor_state: $($profile.executorState)"
    Write-Host "child_kit_files: $($copies.Count)"
    Write-Host "child_kit_copied: $copied"
    Write-Host "child_kit_unchanged: $unchanged"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
