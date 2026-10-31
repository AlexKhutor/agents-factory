Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-ControlSourceRegistry {
    param([string]$ControlRoot)

    $path = Join-Path $ControlRoot "config\source-registry.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Source registry was not found: $path"
    }

    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Get-ControlSourceBindings {
    param([string]$ControlRoot)

    $path = Join-Path $ControlRoot ".project-local\source-bindings.json"
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Machine-local source bindings were not found: $path"
    }

    return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
}

function Get-ControlSourceDefinition {
    param(
        [string]$ControlRoot,
        [string]$SourceId
    )

    $registry = Get-ControlSourceRegistry -ControlRoot $ControlRoot
    $matches = @($registry.sources | Where-Object { [string]$_.id -eq $SourceId })
    if (@($matches).Count -ne 1) {
        throw "Expected exactly one registered source '$SourceId'; found $(@($matches).Count)."
    }

    return $matches[0]
}

function Resolve-ControlRelativePath {
    param(
        [string]$BasePath,
        [string]$RelativePath,
        [switch]$AllowMissing
    )

    if ([string]::IsNullOrWhiteSpace($RelativePath)) {
        throw "Relative path must not be empty."
    }
    if ([System.IO.Path]::IsPathRooted($RelativePath)) {
        throw "Expected a relative path, received '$RelativePath'."
    }
    if ($RelativePath -match '(^|[\/])\.\.([\/]|$)') {
        throw "Relative path may not traverse above its root: '$RelativePath'."
    }

    $resolvedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    $resolved = [System.IO.Path]::GetFullPath((Join-Path $resolvedBase $RelativePath))
    $prefix = $resolvedBase + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Resolved path escapes its root: '$RelativePath'."
    }
    if (-not $AllowMissing -and -not (Test-Path -LiteralPath $resolved)) {
        throw "Resolved path does not exist: $resolved"
    }

    return $resolved
}

function Get-ControlPortableRelativePath {
    param(
        [string]$BasePath,
        [string]$TargetPath
    )

    $resolvedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    $resolvedTarget = [System.IO.Path]::GetFullPath($TargetPath)
    $baseUri = [System.Uri]::new($resolvedBase + [System.IO.Path]::DirectorySeparatorChar)
    $targetUri = [System.Uri]::new($resolvedTarget)
    $relative = [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString())
    if ($relative.StartsWith("../", [System.StringComparison]::Ordinal)) {
        throw "Target path is outside the requested base path: $resolvedTarget"
    }

    return $relative.Replace('\', '/')
}

function Resolve-ControlSourceWorkspace {
    param(
        [string]$ControlRoot,
        [string]$SourceId
    )

    $source = Get-ControlSourceDefinition -ControlRoot $ControlRoot -SourceId $SourceId
    $bindings = Get-ControlSourceBindings -ControlRoot $ControlRoot
    $bindingProperty = if ($bindings.sources) { $bindings.sources.PSObject.Properties[$SourceId] } else { $null }
    if (-not $bindingProperty) {
        throw "No machine-local binding exists for source '$SourceId'."
    }

    $binding = $bindingProperty.Value
    $boundWorkspacePath = Get-ControlObjectPropertyValue -Object $binding -Name "workspacePath"
    $legacyBoundPath = Get-ControlObjectPropertyValue -Object $binding -Name "path"
    $workspacePath = if ($boundWorkspacePath) {
        [string]$boundWorkspacePath
    }
    elseif ($legacyBoundPath) {
        [string]$legacyBoundPath
    }
    else {
        $null
    }
    if ([string]::IsNullOrWhiteSpace($workspacePath)) {
        throw "Binding '$SourceId' requires workspacePath (or legacy path)."
    }

    $workspacePath = [System.IO.Path]::GetFullPath($workspacePath)
    if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) {
        throw "Bound workspace does not exist for '$SourceId': $workspacePath"
    }

    $configuredSourceRelativeRoot = Get-ControlObjectPropertyValue -Object $source -Name "workspaceRelativeSourceRoot"
    $sourceRelativeRoot = if ($configuredSourceRelativeRoot) {
        [string]$configuredSourceRelativeRoot
    }
    else {
        "."
    }
    $boundSourcePath = Get-ControlObjectPropertyValue -Object $binding -Name "sourcePath"
    $sourcePath = if ($boundSourcePath) {
        [System.IO.Path]::GetFullPath([string]$boundSourcePath)
    }
    elseif ($sourceRelativeRoot -eq ".") {
        $workspacePath
    }
    else {
        Resolve-ControlRelativePath -BasePath $workspacePath -RelativePath $sourceRelativeRoot
    }
    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        throw "Bound implementation source does not exist for '$SourceId': $sourcePath"
    }

    $route = [string](Get-ControlObjectPropertyValue -Object $source -Name "providerRoute")
    $adapter = [string](Get-ControlObjectPropertyValue -Object $source -Name "executionAdapter")
    $profile = [string](Get-ControlObjectPropertyValue -Object $source -Name "coordinationProfile")
    $launcherRelativePath = $null
    $launcherPath = $null
    # The Codex sources - an isolated VS Code window with its launcher (the
    # default route) and the Codex App Server - left with the Codex path.
    if ($route -in @("codex-vscode", "codex-app-server") -or ($route -eq '' -and
        ($adapter -eq '' -or $adapter -eq 'handoff-file') -and ($profile -eq '' -or $profile -eq 'codex'))) {
        throw "The Codex route of '$SourceId' left the product; the source needs a Claude Code route."
    }
    if ($route -eq "claude-code") {
        $validator = Join-Path $PSScriptRoot '../.orchestrator/runtime/control-source-route-validation.mjs'
        if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
            $validator = Join-Path $PSScriptRoot '../orchestrator/src/control-source-route-validation.mjs'
        }
        if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { throw 'source_route_validator_missing' }
        $resultText = & node.exe $validator $ControlRoot $SourceId $workspacePath
        if ($LASTEXITCODE -ne 0) { throw "Source route validation failed for '$SourceId': $resultText" }
        $routeResult = ($resultText -join "`n") | ConvertFrom-Json
        if ($routeResult.status -ne 'valid' -or $routeResult.routeId -ne $route) { throw 'source_route_result_mismatch' }
    }
    elseif ($route -eq 'claude-desk-agent') {
        # A desk agent of the 2D desk: its coordination folder is controller-owned
        # and no window is launched (claude-code-controller.md).
        $validator = Join-Path $PSScriptRoot '../.orchestrator/runtime/desk-agent-source-validation.mjs'
        if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) {
            $validator = Join-Path $PSScriptRoot '../orchestrator/src/desk-agent-source-validation.mjs'
        }
        if (-not (Test-Path -LiteralPath $validator -PathType Leaf)) { throw 'desk_source_validator_missing' }
        $resultText = & node.exe $validator $ControlRoot $SourceId $workspacePath
        if ($LASTEXITCODE -ne 0) { throw "Desk agent source validation failed for '$SourceId': $resultText" }
        $routeResult = ($resultText -join "`n") | ConvertFrom-Json
        if ($routeResult.status -ne 'valid' -or $routeResult.routeId -ne $route) { throw 'desk_source_result_mismatch' }
    }
    else {
        throw "Unknown or contradictory provider route for '$SourceId'."
    }

    $configuredTaskInbox = Get-ControlObjectPropertyValue -Object $source -Name "taskInbox"
    $taskInboxRelativePath = if ($configuredTaskInbox) {
        [string]$configuredTaskInbox
    }
    else {
        ".orchestrator/tasks/inbox"
    }
    $configuredReportOutbox = Get-ControlObjectPropertyValue -Object $source -Name "reportOutbox"
    $reportOutboxRelativePath = if ($configuredReportOutbox) {
        [string]$configuredReportOutbox
    }
    else {
        ".orchestrator/reports/outbox"
    }

    return [PSCustomObject]@{
        SourceId                  = $SourceId
        Definition                = $source
        Binding                   = $binding
        WorkspacePath             = $workspacePath
        SourcePath                = $sourcePath
        LauncherPath              = $launcherPath
        LauncherRelativePath      = if ($launcherRelativePath) { $launcherRelativePath.Replace('\', '/') } else { $null }
        RuntimePath               = Join-Path $workspacePath ".project-runtime"
        TaskInboxPath             = Resolve-ControlRelativePath -BasePath $workspacePath -RelativePath $taskInboxRelativePath -AllowMissing
        TaskInboxRelativePath     = $taskInboxRelativePath.Replace('\', '/')
        ReportOutboxPath          = Resolve-ControlRelativePath -BasePath $workspacePath -RelativePath $reportOutboxRelativePath -AllowMissing
        ReportOutboxRelativePath  = $reportOutboxRelativePath.Replace('\', '/')
        ExecutionAdapter          = if (Get-ControlObjectPropertyValue -Object $source -Name "executionAdapter") { [string](Get-ControlObjectPropertyValue -Object $source -Name "executionAdapter") } else { "handoff-file" }
    }
}

function Assert-ControlTextSafety {
    param(
        [AllowNull()]
        [string]$Text,
        [string]$Description = "content"
    )

    if ($Text -and $Text -match '(?i)data\s*:\s*(image|audio|video)/[^,\s]+(?:;[^,\s]+)*,') {
        throw "Inline media is forbidden in $Description. Use a project-relative artifact path."
    }
}

function Assert-ControlDurableText {
    param(
        [AllowNull()]
        [string]$Text,
        [string]$Description = "durable content"
    )

    Assert-ControlTextSafety -Text $Text -Description $Description
    if (Test-ControlTextHasMachineLocalAbsolutePath -Text $Text) {
        throw "Machine-local absolute paths are forbidden in $Description. Use a project-relative reference."
    }
}

function Test-ControlTextHasMachineLocalAbsolutePath {
    param(
        [AllowNull()]
        [string]$Text
    )

    if (-not $Text) {
        return $false
    }

    return [bool]($Text -match '(?i)(^|[\s"''(<\[])\s*(?:file:/+|[a-z]:[\\/]|\\\\[^\\/\s]+[\\/])')
}

function Assert-ControlRelativeReference {
    param(
        [string]$Value,
        [string]$Description
    )

    if ([string]::IsNullOrWhiteSpace($Value)) {
        throw "$Description must not be empty."
    }
    if ([System.IO.Path]::IsPathRooted($Value)) {
        throw "$Description must be project-relative: '$Value'."
    }
    if ($Value -match '^[a-zA-Z][a-zA-Z0-9+.-]*://') {
        throw "$Description must be project-relative, not a URI: '$Value'."
    }
    if ($Value -match '(^|[\/])\.\.([\/]|$)') {
        throw "$Description may not traverse above the project: '$Value'."
    }
    Assert-ControlTextSafety -Text $Value -Description $Description
}

function Get-ControlFileSha256 {
    param([string]$Path)

    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Copy-ControlFileAtomically {
    param(
        [string]$SourcePath,
        [string]$DestinationPath
    )

    $destinationDirectory = Split-Path -Parent $DestinationPath
    New-Item -ItemType Directory -Force -Path $destinationDirectory | Out-Null
    $temporaryPath = "$DestinationPath.tmp-$([System.Guid]::NewGuid().ToString('N'))"
    try {
        Copy-Item -LiteralPath $SourcePath -Destination $temporaryPath
        Move-Item -LiteralPath $temporaryPath -Destination $DestinationPath -Force
    }
    finally {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
}

function Get-ControlPowerShellExecutable {
    $pwsh = Get-Command -Name "pwsh" -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }

    $powershell = Get-Command -Name "powershell" -ErrorAction Stop
    return $powershell.Source
}

function Get-ControlObjectPropertyValue {
    param(
        [AllowNull()]
        [object]$Object,
        [string]$Name,
        [AllowNull()]
        [object]$Default = $null
    )

    if ($null -eq $Object) {
        return $Default
    }

    $property = $Object.PSObject.Properties[$Name]
    if ($property) {
        return $property.Value
    }

    return $Default
}
