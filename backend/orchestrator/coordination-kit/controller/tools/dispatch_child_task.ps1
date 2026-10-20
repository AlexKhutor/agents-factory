[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{1,63}$')]
    [string]$SourceId,

    [Parameter(Mandatory = $true)]
    [string]$TaskDefinitionPath,

    [switch]$OpenWorkspace,
    [switch]$NoOpenTaskFile,
    [string]$RepoRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "project_tooling_common.ps1")
. (Join-Path $PSScriptRoot "orchestration_common.ps1")

function Get-TaskFileSha256 {
    param([string]$Path)

    # The PS 5.1 LiteralPath implementation suppresses its path read under WhatIf.
    # The supported stream overload hashes bytes without changing preview policy.
    $stream = [System.IO.File]::OpenRead($Path)
    try {
        return (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    finally { $stream.Dispose() }
}

function Convert-ToTaskStringArray {
    param(
        [AllowNull()]
        [object]$Value,
        [string]$Name,
        [switch]$RelativePaths
    )

    $items = @()
    foreach ($entry in @($Value)) {
        if ($null -eq $entry) { continue }
        $text = [string]$entry
        if ([string]::IsNullOrWhiteSpace($text)) {
            throw "Task field '$Name' may not contain an empty value."
        }
        Assert-ControlDurableText -Text $text -Description "task field '$Name'"
        if ($RelativePaths) {
            Assert-ControlRelativeReference -Value $text -Description "task field '$Name'"
            $text = $text.Replace('\', '/')
        }
        $items += $text
    }

    return [string[]]$items
}

function Get-TaskContractVersion {
    param([psobject]$Definition)

    $declared = [string](Get-ControlObjectPropertyValue -Object $Definition -Name "contractVersion")
    if ($declared) { return $declared }
    if ($Definition.PSObject.Properties["workflowPolicy"] -or $Definition.PSObject.Properties["intentConfirmation"]) {
        return "v0.3.0"
    }
    if ($Definition.PSObject.Properties["intent"] -or $Definition.PSObject.Properties["desiredOutcomes"]) {
        return "v0.2.0"
    }
    return "v0.1.0"
}

function Get-ChildSupportedTaskContracts {
    param([psobject]$Contract)

    $versions = New-Object System.Collections.Generic.List[string]
    # Historical packets remain readable after a child contract upgrade.
    $versions.Add("v0.1.0")
    if ($Contract.PSObject.Properties["supportedTaskContractVersions"]) {
        foreach ($version in @($Contract.supportedTaskContractVersions)) {
            $text = [string]$version
            if ($text -and -not $versions.Contains($text)) { $versions.Add($text) }
        }
    }
    $current = [string](Get-ControlObjectPropertyValue -Object $Contract -Name "taskContractVersion")
    if ($current -and -not $versions.Contains($current)) { $versions.Add($current) }
    return [string[]]$versions.ToArray()
}

function Add-TaskMarkdownList {
    param(
        [System.Collections.Generic.List[string]]$Lines,
        [string]$Title,
        [object[]]$Values
    )

    $Lines.Add("## $Title")
    $Lines.Add("")
    if (@($Values).Count -eq 0) {
        $Lines.Add("- None specified.")
    }
    else {
        foreach ($value in @($Values)) { $Lines.Add("- $value") }
    }
    $Lines.Add("")
}

function Get-TaskMarkdownLines {
    param([psobject]$Task)

    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($line in @(
        "# Orchestrated Task: $($Task.title)",
        "",
        "- Task ID: ``$($Task.taskId)``",
        "- Target: ``$($Task.targetId)``",
        "- Contract: ``$($Task.contractVersion)``",
        "- Priority: ``$($Task.priority)``",
        "- Dispatched: ``$($Task.dispatchedAtUtc)``",
        "- Execution adapter: ``$($Task.executionAdapter)``",
        ""
    )) { $lines.Add($line) }

    if ($Task.PSObject.Properties["executionProfile"]) {
        $lines.Add("## Execution Profile")
        $lines.Add("")
        $lines.Add("- Provider: ``$($Task.executionProfile.provider)``")
        $lines.Add("- Model: ``$($Task.executionProfile.model)``")
        $lines.Add("- Reasoning effort: ``$($Task.executionProfile.reasoningEffort)``")
        $lines.Add("- Fallback: ``$($Task.executionProfile.fallbackPolicy)``")
        $lines.Add("")
    }

    if ([string]$Task.contractVersion -in @("v0.2.0", "v0.3.0")) {
        $lines.Add("## Intent")
        $lines.Add("")
        $lines.Add([string]$Task.intent)
        $lines.Add("")
        Add-TaskMarkdownList -Lines $lines -Title "Desired Outcomes" -Values @($Task.desiredOutcomes)
        if ([string]$Task.contractVersion -eq "v0.3.0") {
            $lines.Add("## Confirmed Workflow")
            $lines.Add("")
            $lines.Add("- Policy: ``$($Task.workflowPolicy)``")
            $lines.Add("- Intent confirmed by: ``$($Task.intentConfirmation.confirmedBy)``")
            $lines.Add("- Intent confirmed at: ``$($Task.intentConfirmation.confirmedAtUtc)``")
            $lines.Add("- Implementation remains locked until the child plan is separately confirmed.")
            $lines.Add("")
        }
    }
    else {
        $lines.Add("## Objective")
        $lines.Add("")
        $lines.Add([string]$Task.objective)
        $lines.Add("")
    }

    $lines.Add("## Responsibility Boundary")
    $lines.Add("")
    $lines.Add([string]$Task.responsibilityBoundary)
    $lines.Add("")

    if ([string]$Task.contractVersion -in @("v0.2.0", "v0.3.0")) {
        $lines.Add("## Execution Authority")
        $lines.Add("")
        $lines.Add("The target project owns concrete file selection, implementation, local architecture, and local validation. The coordinator owns intent, external constraints, and cross-project acceptance.")
        $lines.Add("")
        Add-TaskMarkdownList -Lines $lines -Title "Required Reading" -Values @($Task.requiredReading)
        Add-TaskMarkdownList -Lines $lines -Title "Forbidden Paths" -Values @($Task.forbiddenPaths)
        Add-TaskMarkdownList -Lines $lines -Title "Constraints" -Values @($Task.constraints)
        Add-TaskMarkdownList -Lines $lines -Title "Deliverables" -Values @($Task.deliverables)
    }
    else {
        Add-TaskMarkdownList -Lines $lines -Title "Acceptance Criteria" -Values @($Task.acceptanceCriteria)
        Add-TaskMarkdownList -Lines $lines -Title "Required Reading" -Values @($Task.requiredReading)
        Add-TaskMarkdownList -Lines $lines -Title "Allowed Paths (Maximum Safety Boundary)" -Values @($Task.allowedPaths)
        Add-TaskMarkdownList -Lines $lines -Title "Forbidden Paths" -Values @($Task.forbiddenPaths)
        Add-TaskMarkdownList -Lines $lines -Title "Constraints" -Values @($Task.constraints)
        Add-TaskMarkdownList -Lines $lines -Title "Deliverables" -Values @($Task.deliverables)
    }

    foreach ($line in @(
        "## Completion Protocol",
        "",
        '1. Invoke `$execute-orchestrated-task` and validate this task against the local owner scope.',
        "2. Acknowledge the task with the bundled ``accept_task.ps1`` script.",
        "3. Inspect the current project and choose the implementation files and local validation plan inside the target's owner boundary."
    )) { $lines.Add($line) }
    if ([string]$Task.contractVersion -eq "v0.3.0") {
        $lines.Add("4. Publish the proposed plan, stop, and record explicit user confirmation with ``confirm_task_plan.ps1``.")
        $lines.Add("5. Record the pre-implementation checkpoint before changing source or behavior.")
        $lines.Add("6. Submit an immutable report with ``submit_report.ps1``.")
        $lines.Add("7. Do not edit this task packet or plan approval after creation.")
    }
    else {
        $lines.Add("4. Submit an immutable report with ``submit_report.ps1``.")
        $lines.Add("5. Do not edit this task packet after dispatch.")
    }
    foreach ($line in @(
        ""
    )) { $lines.Add($line) }

    return [string[]]$lines.ToArray()
}

function Write-TaskPackage {
    param(
        [string]$DestinationDirectory,
        [psobject]$Task
    )

    New-Item -ItemType Directory -Force -Path $DestinationDirectory | Out-Null
    $taskJsonPath = Join-Path $DestinationDirectory "task.json"
    Write-JsonUtf8NoBom -Path $taskJsonPath -Data $Task -Depth 20
    Write-LinesUtf8NoBom -Path (Join-Path $DestinationDirectory "task.md") -Lines (Get-TaskMarkdownLines -Task $Task)
    $taskHash = Get-TaskFileSha256 -Path $taskJsonPath
    Write-TextUtf8NoBom -Path (Join-Path $DestinationDirectory "task.sha256") -Text "$taskHash  task.json`n"
    return $taskHash
}

$resolvedRepoRoot = Get-ProjectRepoRoot -Override $RepoRoot
$toolContext = Start-ProjectToolRun -ToolName "dispatch_child_task" -ResolvedRepoRoot $resolvedRepoRoot -Parameters @{
    SourceId           = $SourceId
    TaskDefinitionPath = $TaskDefinitionPath
    OpenWorkspace      = [bool]$OpenWorkspace
    NoOpenTaskFile     = [bool]$NoOpenTaskFile
    WhatIf            = [bool]$WhatIfPreference
    RepoRoot           = $RepoRoot
}
$resultData = @{}

try {
    $definitionPath = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $TaskDefinitionPath).Path)
    $definitionItem = Get-Item -LiteralPath $definitionPath
    if ($definitionItem.Length -gt 1048576) { throw "Task definition exceeds the 1 MiB limit." }
    $definitionText = [System.IO.File]::ReadAllText($definitionPath)
    Assert-ControlDurableText -Text $definitionText -Description "task definition"
    $definition = $definitionText | ConvertFrom-Json
    $definitionHash = Get-TaskFileSha256 -Path $definitionPath
    $taskContractVersion = Get-TaskContractVersion -Definition $definition
    if ($taskContractVersion -notin @("v0.1.0", "v0.2.0", "v0.3.0")) {
        throw "Unsupported task definition contract '$taskContractVersion'."
    }

    $taskId = [string](Get-ControlObjectPropertyValue -Object $definition -Name "taskId")
    if ($taskId -notmatch '^[a-z0-9][a-z0-9.-]{2,95}$') {
        throw "taskId must match ^[a-z0-9][a-z0-9.-]{2,95}$"
    }
    $targetId = [string](Get-ControlObjectPropertyValue -Object $definition -Name "targetId" -Default $SourceId)
    if ($targetId -ne $SourceId) { throw "Task targetId '$targetId' does not match requested source '$SourceId'." }
    $title = [string](Get-ControlObjectPropertyValue -Object $definition -Name "title")
    $responsibilityBoundary = [string](Get-ControlObjectPropertyValue -Object $definition -Name "responsibilityBoundary")
    if ([string]::IsNullOrWhiteSpace($title) -or [string]::IsNullOrWhiteSpace($responsibilityBoundary)) {
        throw "Task definition requires non-empty title and responsibilityBoundary."
    }
    foreach ($textField in @($title, $responsibilityBoundary)) {
        Assert-ControlDurableText -Text $textField -Description "task text"
    }

    $source = Resolve-ControlSourceWorkspace -ControlRoot $resolvedRepoRoot -SourceId $SourceId
    $contractPath = Join-Path $source.WorkspacePath ".orchestrator\contract.json"
    if (-not (Test-Path -LiteralPath $contractPath -PathType Leaf)) {
        throw "Child coordination kit is not installed for '$SourceId'. Run tools/install_child_coordination_kit.bat first."
    }
    $childContract = Get-Content -LiteralPath $contractPath -Raw | ConvertFrom-Json
    if ([string]$childContract.sourceId -ne $SourceId) { throw "Child contract sourceId does not match '$SourceId'." }
    $supportedTaskContracts = @(Get-ChildSupportedTaskContracts -Contract $childContract)
    if ($taskContractVersion -notin $supportedTaskContracts) {
        throw "Child '$SourceId' does not support task contract '$taskContractVersion'; supported: $($supportedTaskContracts -join ', ')."
    }

    $artifactReferences = @()
    foreach ($artifact in @(Get-ControlObjectPropertyValue -Object $definition -Name "artifactReferences" -Default @())) {
        $kind = [string](Get-ControlObjectPropertyValue -Object $artifact -Name "kind")
        $path = [string](Get-ControlObjectPropertyValue -Object $artifact -Name "path")
        if ($kind -notin @("file", "image", "audio", "video", "directory", "log")) {
            throw "Unsupported artifact kind '$kind'."
        }
        Assert-ControlRelativeReference -Value $path -Description "artifact path"
        $sha256 = [string](Get-ControlObjectPropertyValue -Object $artifact -Name "sha256")
        if ($sha256 -and $sha256 -notmatch '^[a-fA-F0-9]{64}$') {
            throw "Artifact sha256 must contain 64 hexadecimal characters."
        }
        $artifactReferences += [PSCustomObject]@{
            kind   = $kind
            path   = $path.Replace('\', '/')
            sha256 = if ($sha256) { $sha256.ToLowerInvariant() } else { $null }
        }
    }

    $priority = [string](Get-ControlObjectPropertyValue -Object $definition -Name "priority" -Default "normal")
    if ($priority -notin @("low", "normal", "high", "critical")) {
        throw "Task priority must be low, normal, high, or critical."
    }
    $requiredReading = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "requiredReading" -Default @()) -Name "requiredReading" -RelativePaths
    $forbiddenPaths = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "forbiddenPaths" -Default @()) -Name "forbiddenPaths" -RelativePaths
    $constraints = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "constraints" -Default @()) -Name "constraints"
    $deliverables = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "deliverables" -Default @()) -Name "deliverables"
    if (@($deliverables).Count -eq 0) { throw "Task definition requires at least one deliverable." }

    $executionProfile = $null
    $requestedExecutionProfile = Get-ControlObjectPropertyValue -Object $definition -Name "executionProfile"
    if ($requestedExecutionProfile) {
        if ($taskContractVersion -eq "v0.1.0") {
            throw "Legacy task contract v0.1.0 does not support executionProfile."
        }
        $profileProvider = [string](Get-ControlObjectPropertyValue -Object $requestedExecutionProfile -Name "provider")
        $profileModel = [string](Get-ControlObjectPropertyValue -Object $requestedExecutionProfile -Name "model")
        $profileEffort = [string](Get-ControlObjectPropertyValue -Object $requestedExecutionProfile -Name "reasoningEffort")
        $profileFallback = [string](Get-ControlObjectPropertyValue -Object $requestedExecutionProfile -Name "fallbackPolicy")
        # Desk agents run on Claude Code; every other source on Codex.
        $expectedProvider = if ([string](Get-ControlObjectPropertyValue -Object $source.Definition -Name "providerRoute") -eq "claude-desk-agent") { "anthropic" } else { "openai" }
        if ($profileProvider -ne $expectedProvider) { throw "executionProfile.provider must be '$expectedProvider'." }
        if ([string]::IsNullOrWhiteSpace($profileModel)) { throw "executionProfile.model is required." }
        if ([string]::IsNullOrWhiteSpace($profileEffort)) { throw "executionProfile.reasoningEffort is required." }
        if ($profileFallback -ne "deny") { throw "executionProfile.fallbackPolicy must be 'deny'." }
        foreach ($profileText in @($profileModel, $profileEffort)) {
            Assert-ControlDurableText -Text $profileText -Description "execution profile"
        }
        $executionProfile = [ordered]@{
            provider        = $expectedProvider
            model           = $profileModel
            reasoningEffort = $profileEffort
            fallbackPolicy  = "deny"
        }
    }

    $task = if ($taskContractVersion -in @("v0.2.0", "v0.3.0")) {
        if ($definition.PSObject.Properties["objective"] -or
            $definition.PSObject.Properties["acceptanceCriteria"] -or
            $definition.PSObject.Properties["allowedPaths"]) {
            throw "Task definition $taskContractVersion must use intent and desiredOutcomes and must not prescribe objective, acceptanceCriteria, or allowedPaths."
        }
        $intent = [string](Get-ControlObjectPropertyValue -Object $definition -Name "intent")
        $desiredOutcomes = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "desiredOutcomes" -Default @()) -Name "desiredOutcomes"
        if ([string]::IsNullOrWhiteSpace($intent) -or @($desiredOutcomes).Count -eq 0) {
            throw "Task definition $taskContractVersion requires non-empty intent and desiredOutcomes."
        }
        Assert-ControlDurableText -Text $intent -Description "task intent"
        $intentTask = [ordered]@{
            schemaVersion          = 1
            contractVersion        = $taskContractVersion
            taskId                 = $taskId
            coordinatorId          = "agents-factory-control"
            targetId               = $SourceId
            title                  = $title
            intent                 = $intent
            desiredOutcomes        = $desiredOutcomes
            responsibilityBoundary = $responsibilityBoundary
            priority               = $priority
            requiredReading        = $requiredReading
            forbiddenPaths         = $forbiddenPaths
            constraints            = $constraints
            deliverables           = $deliverables
            artifactReferences     = [object[]]$artifactReferences
            allowSubagents         = [bool](Get-ControlObjectPropertyValue -Object $definition -Name "allowSubagents" -Default $true)
            executionAuthority     = [ordered]@{
                implementationOwner          = "target"
                localValidationOwner         = "target"
                crossProjectAcceptanceOwner  = "coordinator"
            }
        }
        if ($executionProfile) {
            $intentTask["executionProfile"] = $executionProfile
        }
        if ($taskContractVersion -eq "v0.3.0") {
            $workflowPolicy = [string](Get-ControlObjectPropertyValue -Object $definition -Name "workflowPolicy")
            $confirmation = Get-ControlObjectPropertyValue -Object $definition -Name "intentConfirmation"
            if ($workflowPolicy -ne "intent-confirm-plan-v1") {
                throw "Task definition v0.3.0 requires workflowPolicy 'intent-confirm-plan-v1'."
            }
            if (-not $confirmation -or [string]$confirmation.status -ne "confirmed") {
                throw "Task definition v0.3.0 requires an explicit confirmed intentConfirmation."
            }
            $confirmedBy = [string](Get-ControlObjectPropertyValue -Object $confirmation -Name "confirmedBy")
            $confirmedAtUtc = [string](Get-ControlObjectPropertyValue -Object $confirmation -Name "confirmedAtUtc")
            $confirmationNote = [string](Get-ControlObjectPropertyValue -Object $confirmation -Name "note")
            if ([string]::IsNullOrWhiteSpace($confirmedBy) -or [string]::IsNullOrWhiteSpace($confirmedAtUtc)) {
                throw "Task definition v0.3.0 requires confirmedBy and confirmedAtUtc."
            }
            try { [void][datetimeoffset]::Parse($confirmedAtUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind) }
            catch { throw "Task definition v0.3.0 confirmedAtUtc is not a valid date-time." }
            foreach ($confirmationText in @($confirmedBy, $confirmationNote)) {
                if ($confirmationText) { Assert-ControlDurableText -Text $confirmationText -Description "intent confirmation" }
            }
            $intentTask.Insert(2, "workflowPolicy", $workflowPolicy)
            $intentTask.Insert(3, "intentConfirmation", [ordered]@{
                status         = "confirmed"
                confirmedBy    = $confirmedBy
                confirmedAtUtc = $confirmedAtUtc
                note           = if ($confirmationNote) { $confirmationNote } else { $null }
            })
        }
        $intentTask
    }
    else {
        $objective = [string](Get-ControlObjectPropertyValue -Object $definition -Name "objective")
        $acceptanceCriteria = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "acceptanceCriteria" -Default @()) -Name "acceptanceCriteria"
        if ([string]::IsNullOrWhiteSpace($objective) -or @($acceptanceCriteria).Count -eq 0) {
            throw "Legacy task definition requires non-empty objective and acceptanceCriteria."
        }
        Assert-ControlDurableText -Text $objective -Description "legacy task objective"
        [ordered]@{
            schemaVersion          = 1
            contractVersion        = "v0.1.0"
            taskId                 = $taskId
            coordinatorId          = "agents-factory-control"
            targetId               = $SourceId
            title                  = $title
            objective              = $objective
            responsibilityBoundary = $responsibilityBoundary
            priority               = $priority
            acceptanceCriteria     = $acceptanceCriteria
            requiredReading        = $requiredReading
            allowedPaths           = Convert-ToTaskStringArray -Value (Get-ControlObjectPropertyValue -Object $definition -Name "allowedPaths" -Default @()) -Name "allowedPaths" -RelativePaths
            forbiddenPaths         = $forbiddenPaths
            constraints            = $constraints
            deliverables           = $deliverables
            artifactReferences     = [object[]]$artifactReferences
            allowSubagents         = [bool](Get-ControlObjectPropertyValue -Object $definition -Name "allowSubagents" -Default $true)
        }
    }

    $task["definitionSha256"] = $definitionHash
    $task["dispatchedAtUtc"] = [datetime]::UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ")
    $task["executionAdapter"] = $source.ExecutionAdapter
    $task["executionState"] = "awaiting-child-agent-acceptance"
    $task["agentTurnStarted"] = $false
    $task["reportContract"] = [ordered]@{
        version       = [string]$childContract.reportContractVersion
        outbox        = $source.ReportOutboxRelativePath
        requiredSkill = "execute-orchestrated-task"
    }

    $controlTaskDirectory = Join-Path $resolvedRepoRoot "coordination\tasks\dispatched\$taskId"
    $controlTaskJsonPath = Join-Path $controlTaskDirectory "task.json"
    $controlAction = "not-run"
    $taskHash = $null

    if (Test-Path -LiteralPath $controlTaskJsonPath -PathType Leaf) {
        $existingTask = Get-Content -LiteralPath $controlTaskJsonPath -Raw | ConvertFrom-Json
        if ([string]$existingTask.definitionSha256 -ne $definitionHash -or [string]$existingTask.targetId -ne $SourceId) {
            throw "Task ID '$taskId' already exists with a different definition or target. Dispatched tasks are immutable."
        }
        $task = $existingTask
        $taskHash = Get-TaskFileSha256 -Path $controlTaskJsonPath
        $controlAction = "already-dispatched"
    }
    elseif ($PSCmdlet.ShouldProcess($controlTaskDirectory, "Create immutable coordinator task package")) {
        $temporaryDirectory = "$controlTaskDirectory.tmp-$([System.Guid]::NewGuid().ToString('N'))"
        try {
            $taskHash = Write-TaskPackage -DestinationDirectory $temporaryDirectory -Task $task
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $controlTaskDirectory) | Out-Null
            Move-Item -LiteralPath $temporaryDirectory -Destination $controlTaskDirectory
        }
        finally { Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue }
        $controlAction = "dispatched"
    }
    else { $controlAction = "previewed" }

    $childTaskDirectory = Join-Path $source.TaskInboxPath $taskId
    $childTaskJsonPath = Join-Path $childTaskDirectory "task.json"
    $childAction = "not-run"
    if (Test-Path -LiteralPath $childTaskJsonPath -PathType Leaf) {
        $childHash = Get-TaskFileSha256 -Path $childTaskJsonPath
        if ($taskHash -and $childHash -ne $taskHash) { throw "Child inbox contains a conflicting immutable task '$taskId'." }
        $childAction = "already-delivered"
    }
    elseif ($controlAction -ne "previewed" -and $PSCmdlet.ShouldProcess($childTaskDirectory, "Deliver task package to child inbox")) {
        $temporaryChildDirectory = "$childTaskDirectory.tmp-$([System.Guid]::NewGuid().ToString('N'))"
        try {
            New-Item -ItemType Directory -Force -Path $temporaryChildDirectory | Out-Null
            foreach ($fileName in @("task.json", "task.md", "task.sha256")) {
                Copy-Item -LiteralPath (Join-Path $controlTaskDirectory $fileName) -Destination (Join-Path $temporaryChildDirectory $fileName)
            }
            New-Item -ItemType Directory -Force -Path (Split-Path -Parent $childTaskDirectory) | Out-Null
            Move-Item -LiteralPath $temporaryChildDirectory -Destination $childTaskDirectory
        }
        finally { Remove-Item -LiteralPath $temporaryChildDirectory -Recurse -Force -ErrorAction SilentlyContinue }
        $childAction = "delivered"
    }
    elseif ($controlAction -eq "previewed") { $childAction = "previewed" }

    $openAction = "not-requested"
    if ($OpenWorkspace -and $childAction -in @("delivered", "already-delivered")) {
        $openToolPath = Join-Path $PSScriptRoot "open_child_workspace.ps1"
        $openRelativePath = if ($NoOpenTaskFile) { $null } else { "$($source.TaskInboxRelativePath)/$taskId/task.md" }
        if ($PSCmdlet.ShouldProcess($source.WorkspacePath, "Open child workspace after task delivery")) {
            $powerShellExecutable = Get-ControlPowerShellExecutable
            $arguments = @("-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", $openToolPath, "-SourceId", $SourceId, "-RepoRoot", $resolvedRepoRoot)
            if ($openRelativePath) { $arguments += @("-OpenRelativePath", $openRelativePath) }
            $previousPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = "Continue"
                $openOutput = & $powerShellExecutable @arguments 2>&1
                $openExitCode = $LASTEXITCODE
            }
            finally { $ErrorActionPreference = $previousPreference }
            foreach ($line in @($openOutput)) { Write-Host "child_open: $line" }
            if ($openExitCode -ne 0) { throw "Task was delivered, but opening child workspace failed with exit code $openExitCode." }
            $openAction = "opened"
        }
    }

    $resultData = @{
        SourceId             = $SourceId
        TaskId               = $taskId
        ContractVersion      = $taskContractVersion
        DefinitionSha256     = $definitionHash
        TaskSha256           = $taskHash
        ControlTaskDirectory = $controlTaskDirectory
        ChildTaskDirectory   = $childTaskDirectory
        ControlAction        = $controlAction
        ChildAction          = $childAction
        OpenAction           = $openAction
        ExecutionAdapter     = $source.ExecutionAdapter
        ExecutionState       = "awaiting-child-agent-acceptance"
        AgentTurnStarted     = $false
        ExecutionModel       = if ($executionProfile) { [string]$executionProfile.model } else { $null }
        ExecutionEffort      = if ($executionProfile) { [string]$executionProfile.reasoningEffort } else { $null }
    }

    Write-Host "task_id: $taskId"
    Write-Host "task_contract_version: $taskContractVersion"
    Write-Host "task_control_action: $controlAction"
    Write-Host "task_child_action: $childAction"
    Write-Host "task_open_action: $openAction"
    Write-Host "task_execution_adapter: $($source.ExecutionAdapter)"
    Write-Host "task_execution_model: $(if ($executionProfile) { $executionProfile.model } else { 'inherit-ui' })"
    Write-Host "task_execution_effort: $(if ($executionProfile) { $executionProfile.reasoningEffort } else { 'inherit-ui' })"
    Write-Host "task_agent_turn_started: false"
    Stop-ProjectToolRun -Context $toolContext -Status "success" -ExitCode 0 -ResultData $resultData | Out-Null
}
catch {
    Stop-ProjectToolRun -Context $toolContext -Status "failed" -ExitCode 1 -ResultData $resultData -ErrorRecord $_ | Out-Null
    throw
}
