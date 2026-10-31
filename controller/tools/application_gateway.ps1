[CmdletBinding()]
param(
    [ValidateSet("Start", "Status", "DescriptorStatus", "Stop", "Recover", "OpenMonitor", "CloseMonitor", "Watch")]
    [string]$Command = "Status",
    [string]$RepoRoot,
    [string]$ProjectId,
    [string]$NodeCommand = "node",
    [string]$MonitorId,
    # Claude Code is the Gateway's only provider: the Codex path, with its
    # owner chat, left the product (roadmap step 1).
    [ValidateSet("claude")][string]$Provider = "claude",
    [ValidateRange(1, 60)][int]$StartupTimeoutSeconds = 15,
    [ValidateRange(250, 10000)][int]$RefreshMilliseconds = 1000,
    [switch]$PlanOnly,
    [switch]$AsJson
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Quote-ProcessArgument {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

function Resolve-GatewayContext {
    $root = if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
        Split-Path -Parent $PSScriptRoot
    } else { $RepoRoot }
    $root = [System.IO.Path]::GetFullPath($root)
    $versionPath = Join-Path $root "project-version.json"
    if ([string]::IsNullOrWhiteSpace($ProjectId)) {
        if (-not (Test-Path -LiteralPath $versionPath -PathType Leaf)) {
            throw "gateway_project_identity_unavailable"
        }
        $version = Get-Content -LiteralPath $versionPath -Raw | ConvertFrom-Json
        $resolvedProjectId = [string]$version.projectName
    } else { $resolvedProjectId = $ProjectId }
    if ($resolvedProjectId -notmatch '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$') {
        throw "gateway_project_identity_invalid"
    }
    $node = (Get-Command $NodeCommand -CommandType Application -ErrorAction Stop).Source
    $installedCli = Join-Path $root ".orchestrator\runtime\application-gateway-cli.mjs"
    $sourceCli = Join-Path $root "orchestrator\src\application-gateway-cli.mjs"
    $cli = if (Test-Path -LiteralPath $installedCli -PathType Leaf) {
        $installedCli
    } else { $sourceCli }
    if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
        throw "gateway_cli_unavailable"
    }
    $runtime = Join-Path $root ".project-local\application-gateway"
    return [pscustomobject]@{
        Root = $root
        ProjectId = $resolvedProjectId
        Node = $node
        Cli = $cli
        Runtime = $runtime
        Status = Join-Path $runtime "status.v1.json"
        Monitor = Join-Path $runtime "monitor-status.v1.json"
        MonitorOwner = Join-Path $runtime "monitor-owner.v1.json"
        Log = Join-Path $root "logs\application_gateway.log"
        ErrorLog = Join-Path $root "logs\application_gateway.error.log"
    }
}

function Invoke-GatewayCliJson {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][string]$CliCommand,
        [string[]]$Extra = @()
    )
    $arguments = @(
        $Context.Cli, $CliCommand,
        "--repo-root", $Context.Root,
        "--project-id", $Context.ProjectId,
        "--json"
    ) + $Extra
    $text = & $Context.Node @arguments
    if ($LASTEXITCODE -ne 0) { throw "gateway_${CliCommand}_failed" }
    try { return ([string]$text | ConvertFrom-Json) }
    catch { throw "gateway_${CliCommand}_response_invalid" }
}

function Read-JsonFile {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return (Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json) }
    catch { throw "gateway_runtime_record_invalid" }
}

function Test-ProcessAlive {
    param([int]$ProcessId)
    if ($ProcessId -lt 1) { return $false }
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Invoke-StaleGatewayRecovery {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][object]$Status
    )
    if ([bool]$Status.terminal) { return $Status }
    $processId = [int]$Status.identity.process.processId
    if (Test-ProcessAlive -ProcessId $processId) {
        throw "gateway_recovery_process_alive"
    }
    $heartbeatAge = ([datetime]::UtcNow -
        [datetime]::Parse([string]$Status.heartbeatAtUtc).ToUniversalTime()).TotalSeconds
    if ($heartbeatAge -le 30) { throw "gateway_recovery_not_stale" }
    $result = Invoke-GatewayCliJson -Context $Context -CliCommand "recover" -Extra @(
        "--expected-instance-id", [string]$Status.identity.instanceId,
        "--expected-process-id", [string]$processId,
        "--expected-process-started-at-utc", [string]$Status.identity.process.startedAtUtc
    )
    if ([string]$result.status -cne "recovered") {
        throw "gateway_recovery_unconfirmed"
    }
    return Read-JsonFile -Path $Context.Status
}

function Wait-MonitorReady {
    param(
        [Parameter(Mandatory = $true)][object]$Context,
        [Parameter(Mandatory = $true)][string]$ExpectedMonitorId
    )
    $deadline = [datetime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
    do {
        $record = Read-JsonFile -Path $Context.Monitor
        if ($null -ne $record -and [string]$record.monitorId -ceq $ExpectedMonitorId -and
            [string]$record.state -ceq "ready" -and
            (Test-ProcessAlive -ProcessId ([int]$record.processId)) -and
            (([datetime]::UtcNow - [datetime]::Parse([string]$record.heartbeatAtUtc).ToUniversalTime()).TotalSeconds -le 15)) {
            return $record
        }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    throw "observability_unavailable"
}

function Start-VisibleMonitor {
    param([Parameter(Mandatory = $true)][object]$Context)
    $existing = Read-JsonFile -Path $Context.Monitor
    if ($null -ne $existing -and (Test-ProcessAlive -ProcessId ([int]$existing.processId))) {
        throw "gateway_monitor_already_owned"
    }
    $id = if ([string]::IsNullOrWhiteSpace($MonitorId)) {
        [guid]::NewGuid().ToString("D").ToLowerInvariant()
    } else { $MonitorId }
    $powerShell = (Get-Command powershell.exe -CommandType Application -ErrorAction Stop).Source
    $arguments = @(
        "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass",
        "-File", (Quote-ProcessArgument $PSCommandPath),
        "-Command", "Watch",
        "-RepoRoot", (Quote-ProcessArgument $Context.Root),
        "-ProjectId", (Quote-ProcessArgument $Context.ProjectId),
        "-NodeCommand", (Quote-ProcessArgument $Context.Node),
        "-MonitorId", (Quote-ProcessArgument $id),
        "-RefreshMilliseconds", [string]$RefreshMilliseconds
    )
    $null = Start-Process -FilePath $powerShell `
        -ArgumentList ([string]::Join(" ", $arguments)) `
        -WorkingDirectory $Context.Root -PassThru
    return Wait-MonitorReady -Context $Context -ExpectedMonitorId $id
}

function Write-GatewayOutput {
    param([Parameter(Mandatory = $true)][object]$Value)
    if ($AsJson) { $Value | ConvertTo-Json -Depth 12 -Compress }
    else { $Value | ConvertTo-Json -Depth 12 }
}

$context = Resolve-GatewayContext

if ($Command -ceq "Watch") {
    if ([string]::IsNullOrWhiteSpace($MonitorId)) { throw "gateway_monitor_id_required" }
    & $context.Node $context.Cli watch `
        --repo-root $context.Root `
        --project-id $context.ProjectId `
        --monitor-id $MonitorId `
        --refresh-ms ([string]$RefreshMilliseconds)
    if ($LASTEXITCODE -ne 0) { throw "gateway_monitor_failed" }
    return
}

if ($Command -ceq "Status") {
    Write-GatewayOutput -Value (Invoke-GatewayCliJson `
        -Context $context -CliCommand "status")
    return
}

if ($Command -ceq "DescriptorStatus") {
    Write-GatewayOutput -Value (Invoke-GatewayCliJson `
        -Context $context -CliCommand "descriptor-status")
    return
}

if ($Command -ceq "Stop") {
    if ($PlanOnly) {
        Write-GatewayOutput -Value ([ordered]@{
            schemaVersion = 1
            command = "stop"
            planOnly = $true
            projectId = $context.ProjectId
            exactInstanceRequired = $true
            broadKill = $false
        })
        return
    }
    Write-GatewayOutput -Value (Invoke-GatewayCliJson `
        -Context $context -CliCommand "stop")
    return
}

if ($Command -ceq "Recover") {
    if ($PlanOnly) {
        Write-GatewayOutput -Value ([ordered]@{
            schemaVersion = 1
            command = "recover"
            planOnly = $true
            projectId = $context.ProjectId
            exactDeadInstanceRequired = $true
            minimumStaleSeconds = 30
            broadKill = $false
        })
        return
    }
    $status = Read-JsonFile -Path $context.Status
    if ($null -eq $status) {
        Write-GatewayOutput -Value ([ordered]@{ command = "recover"; state = "absent" })
        return
    }
    $recovered = Invoke-StaleGatewayRecovery -Context $context -Status $status
    Write-GatewayOutput -Value ([ordered]@{
        schemaVersion = 1
        command = "recover"
        state = if ([bool]$recovered.terminal) { [string]$recovered.lifecycle } else { "unchanged" }
        instanceId = [string]$recovered.identity.instanceId
        restartAllowed = [bool]$recovered.terminal
    })
    return
}

if ($Command -ceq "OpenMonitor") {
    if ($PlanOnly) {
        Write-GatewayOutput -Value ([ordered]@{
            schemaVersion = 1
            command = "open-monitor"
            planOnly = $true
            projectId = $context.ProjectId
            presentationOnly = $true
        })
        return
    }
    $monitor = Start-VisibleMonitor -Context $context
    Write-GatewayOutput -Value ([ordered]@{
        schemaVersion = 1
        command = "open-monitor"
        ready = $true
        monitorId = [string]$monitor.monitorId
        processId = [int]$monitor.processId
        presentationOnly = $true
    })
    return
}

if ($Command -ceq "CloseMonitor") {
    $record = Read-JsonFile -Path $context.Monitor
    if ($null -eq $record) {
        if (Test-Path -LiteralPath $context.MonitorOwner -PathType Leaf) {
            throw "gateway_monitor_identity_uncertain"
        }
        Write-GatewayOutput -Value ([ordered]@{
            schemaVersion = 1
            command = "close-monitor"
            state = "absent"
        })
        return
    }
    $fresh = (([datetime]::UtcNow -
        [datetime]::Parse([string]$record.heartbeatAtUtc).ToUniversalTime()).TotalSeconds -le 15)
    $monitorAlive = Test-ProcessAlive -ProcessId ([int]$record.processId)
    if ([string]$record.projectId -cne $context.ProjectId -or -not $fresh -or
        -not $monitorAlive) {
        throw "gateway_monitor_identity_uncertain"
    }
    if ($PlanOnly) {
        Write-GatewayOutput -Value ([ordered]@{
            schemaVersion = 1
            command = "close-monitor"
            planOnly = $true
            monitorId = [string]$record.monitorId
            processId = [int]$record.processId
            gatewayStop = $false
        })
        return
    }
    Stop-Process -Id ([int]$record.processId) -ErrorAction Stop
    $deadline = [datetime]::UtcNow.AddSeconds(5)
    do {
        if (-not (Test-ProcessAlive -ProcessId ([int]$record.processId))) { break }
        Start-Sleep -Milliseconds 100
    } while ([datetime]::UtcNow -lt $deadline)
    if (Test-ProcessAlive -ProcessId ([int]$record.processId)) {
        throw "gateway_monitor_close_unconfirmed"
    }
    $null = Invoke-GatewayCliJson -Context $context -CliCommand "release-monitor" -Extra @(
        '--monitor-id', [string]$record.monitorId, '--expected-process-id', [string]$record.processId
    )
    $current = Read-JsonFile -Path $context.Monitor
    if ($null -ne $current -and [string]$current.monitorId -ceq [string]$record.monitorId) {
        Remove-Item -LiteralPath $context.Monitor -Force
    }
    Write-GatewayOutput -Value ([ordered]@{
        schemaVersion = 1
        command = "close-monitor"
        state = "closed"
        monitorId = [string]$record.monitorId
        gatewayStop = $false
    })
    return
}

if ($Command -cne "Start") { throw "gateway_command_unsupported" }
if ($PlanOnly) {
    Write-GatewayOutput -Value ([ordered]@{
        schemaVersion = 1
        command = "start"
        planOnly = $true
        projectId = $context.ProjectId
        sequence = @(
            "open-visible-monitor", "verify-monitor-readiness", "inspect-exact-gateway",
            "recover-exact-dead-stale-if-needed", "launch-hidden-host-if-terminal-or-absent",
            "verify-ready-instance", "verify-monitor-binding"
        )
        provider = $Provider
        headlessAutostart = $false
        broadKill = $false
    })
    return
}

$monitor = Start-VisibleMonitor -Context $context
$status = Read-JsonFile -Path $context.Status
$gatewayProcess = $null
$launched = $false
if ($null -ne $status -and -not [bool]$status.terminal) {
    $heartbeatAge = ([datetime]::UtcNow -
        [datetime]::Parse([string]$status.heartbeatAtUtc).ToUniversalTime()).TotalSeconds
    if (-not (Test-ProcessAlive -ProcessId ([int]$status.identity.process.processId))) {
        $status = Invoke-StaleGatewayRecovery -Context $context -Status $status
    } elseif ($heartbeatAge -gt 30) {
        throw "live_gateway_unhealthy"
    }
}
if ($null -eq $status -or [bool]$status.terminal) {
    $logRoot = Split-Path -Parent $context.Log
    $null = New-Item -ItemType Directory -Path $logRoot -Force
    foreach ($logPath in @($context.Log, $context.ErrorLog)) {
        if (Test-Path -LiteralPath $logPath -PathType Leaf) {
            Move-Item -LiteralPath $logPath -Destination ($logPath + ".previous") -Force
        }
    }
    $arguments = @(
        (Quote-ProcessArgument $context.Cli), "run",
        "--repo-root", (Quote-ProcessArgument $context.Root),
        "--project-id", (Quote-ProcessArgument $context.ProjectId),
        "--monitor-id", (Quote-ProcessArgument ([string]$monitor.monitorId)),
        "--provider", $Provider
    )
    $gatewayProcess = Start-Process -FilePath $context.Node `
        -ArgumentList ([string]::Join(" ", $arguments)) `
        -WorkingDirectory $context.Root -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $context.Log -RedirectStandardError $context.ErrorLog
    $launched = $true
}

$deadline = [datetime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
do {
    $status = Read-JsonFile -Path $context.Status
    if ($null -ne $status -and [string]$status.lifecycle -ceq "ready" -and
        (Test-ProcessAlive -ProcessId ([int]$status.identity.process.processId))) { break }
    if ($null -ne $gatewayProcess) {
        $gatewayProcess.Refresh()
        if ($gatewayProcess.HasExited) { throw "gateway_start_failed" }
    }
    Start-Sleep -Milliseconds 100
} while ([datetime]::UtcNow -lt $deadline)
if ($null -eq $status -or [string]$status.lifecycle -cne "ready") {
    throw "gateway_start_timeout"
}

$bound = $false
do {
    $monitor = Wait-MonitorReady `
        -Context $context -ExpectedMonitorId ([string]$monitor.monitorId)
    if ([string]$monitor.gatewayInstanceId -ceq [string]$status.identity.instanceId -and
        [int]$monitor.gatewayProcessId -eq [int]$status.identity.process.processId -and
        [string]$monitor.health -ceq "gateway-ready") {
        $bound = $true
        break
    }
    Start-Sleep -Milliseconds 100
} while ([datetime]::UtcNow -lt $deadline)
if (-not $bound) { throw "observability_unavailable" }

Write-GatewayOutput -Value ([ordered]@{
    schemaVersion = 1
    command = "start"
    state = if ($launched) { "started" } else { "already-running" }
    ready = $true
    projectId = $context.ProjectId
    instanceId = [string]$status.identity.instanceId
    processId = [int]$status.identity.process.processId
    monitorId = [string]$monitor.monitorId
    monitorProcessId = [int]$monitor.processId
    monitorBound = $true
    provider = $Provider
    headlessAutostart = $false
})
