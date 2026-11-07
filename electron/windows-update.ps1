param(
  [string] $Manifest,
  [switch] $LibraryOnly
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

# This helper is copied into the private transaction directory before it starts.
# It never overwrites a running application and only moves explicit program entries.
function Get-FullPath([string] $Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { throw 'Empty update path' }
  return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]@('\', '/'))
}
function Test-Within([string] $Root, [string] $Candidate, [bool] $AllowEqual = $false) {
  $base = Get-FullPath $Root
  $target = Get-FullPath $Candidate
  return ($AllowEqual -and $target.Equals($base, [StringComparison]::OrdinalIgnoreCase)) -or $target.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
}
function Assert-NoLinks([string] $Target) {
  $current = Get-FullPath $Target
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Update path is a reparse point: $current" }
    }
    $parent = [IO.Path]::GetDirectoryName($current)
    if ($parent -eq $current) { break }
    $current = $parent
  }
}
function Assert-SafeTree([string] $Target) {
  Assert-NoLinks $Target
  if (-not (Test-Path -LiteralPath $Target)) { return }
  foreach ($child in @(Get-ChildItem -LiteralPath $Target -Force)) {
    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Update tree contains a reparse point: $($child.FullName)" }
    if ($child.PSIsContainer) { Assert-SafeTree $child.FullName }
  }
}
function Test-ProgramEntry([string] $Name) {
  return $Name -match '^(CIKE\.exe|[^\\/:]+\.dll|icudtl\.dat|chrome_\d+_percent\.pak|resources\.pak|snapshot_blob\.bin|v8_context_snapshot\.bin|vk_swiftshader_icd\.json|LICENSE|LICENSES\.chromium\.html|BUILD-INFO\.txt|version|resources|locales|swiftshader)$'
}
function Write-Json([string] $File, $Value) {
  $temporary = $File + '.new'
  [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 12), (New-Object Text.UTF8Encoding($false)))
  # File.Move does not replace on Windows PowerShell; replacing an existing status
  # keeps readers seeing a complete JSON document instead of an in-place write.
  if (Test-Path -LiteralPath $File) {
    # PowerShell 5 converts a null string argument into an empty path, so give
    # File.Replace an explicit backup filename within the same transaction.
    $previous = $File + '.previous'
    [IO.File]::Replace($temporary, $File, $previous)
    [IO.File]::Delete($previous)
  }
  else { [IO.File]::Move($temporary, $File) }
}
function Write-Status($State, [string] $Phase, [string] $ErrorMessage = '') {
  Write-Json (Join-Path $State.transaction 'status.json') @{ phase = $Phase; error = $ErrorMessage; version = $State.version; time = [DateTime]::UtcNow.ToString('o') }
}
function Assert-ProgramTarget($State, [string] $Name) {
  if (-not (Test-ProgramEntry $Name) -or $Name -match '[\\/]|\.\.|[ .]$') { throw "Invalid program entry: $Name" }
  $target = Get-FullPath (Join-Path $State.root $Name)
  if (-not (Test-Within $State.root $target)) { throw 'Program entry escapes installation directory' }
  foreach ($reserved in $State.protectedPaths) {
    if ((Test-Within $reserved $target $true) -or (Test-Within $target $reserved $true)) { throw 'Program update overlaps a protected data directory' }
  }
  Assert-SafeTree $target
}
function Read-UpdateManifest([string] $File) {
  $manifestPath = Get-FullPath $File
  Assert-NoLinks $manifestPath
  $state = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
  if ($state.schema -ne 1 -or $state.transactionId -notmatch '^[a-f0-9-]{36}$' -or $state.version -notmatch '^\d+\.\d+\.\d+$' -or $state.confirmationToken -notmatch '^[a-f0-9]{64}$') { throw 'Invalid update manifest' }
  foreach ($key in @('root', 'transaction', 'stage', 'backup')) {
    $state.$key = Get-FullPath $state.$key
    Assert-NoLinks $state.$key
  }
  if ([IO.Path]::GetDirectoryName($manifestPath) -ne $state.transaction -or [IO.Path]::GetFileName($state.transaction) -ne $state.transactionId -or $state.stage -ne (Join-Path $state.transaction 'stage') -or $state.backup -ne (Join-Path $state.transaction 'backup')) { throw 'Invalid transaction directory boundaries' }
  if ($state.root -eq [IO.Path]::GetPathRoot($state.root).TrimEnd('\') -or (Test-Within $state.stage $state.root $true)) { throw 'Invalid installation root' }
  if ([IO.Path]::GetPathRoot($state.root) -ne [IO.Path]::GetPathRoot($state.transaction)) { throw 'Update backup must be on the installation volume' }
  foreach ($name in @('data', 'browsers', 'Downloads')) {
    if (-not (@($state.protectedPaths) -contains (Join-Path $state.root $name))) { throw "Missing protected data directory: $name" }
  }
  if (-not @($state.protectedPaths | Where-Object { Test-Within $_ $state.transaction }).Count) { throw 'Transaction must be inside a protected data directory' }
  $seen = @{}
  foreach ($entry in $state.entries) {
    if ($seen.ContainsKey($entry)) { throw 'Duplicate program entry' }
    $seen[$entry] = $true
    Assert-ProgramTarget $state $entry
  }
  if (-not $seen.ContainsKey('CIKE.exe') -or -not $seen.ContainsKey('resources')) { throw 'Missing program entry point' }
  return $state
}
function Assert-StagedFiles($State) {
  Assert-SafeTree $State.stage
  $expected = @{}
  foreach ($file in $State.files) {
    $relative = [string] $file.path
    if ($relative -match '(^[/\\]|[:\\]|(^|/)\.\.?(/|$))' -or $relative -match '[ .](/|$)' -or $file.sha256 -notmatch '^[a-f0-9]{64}$') { throw 'Unsafe manifest file name or hash' }
    $target = Get-FullPath (Join-Path $State.stage $relative)
    if (-not (Test-Within $State.stage $target) -or $expected.ContainsKey($target)) { throw 'Duplicate or escaping staged path' }
    $expected[$target] = $file
  }
  $files = @(Get-ChildItem -LiteralPath $State.stage -File -Recurse -Force)
  if ($files.Count -ne $expected.Count -or $files.Count -eq 0) { throw 'Staged file list does not match manifest' }
  foreach ($file in $files) {
    $record = $expected[$file.FullName]
    if ($null -eq $record -or $file.Length -ne $record.size -or (Get-SHA256 $file.FullName) -ne $record.sha256) { throw "Staged integrity check failed: $($file.Name)" }
  }
  foreach ($entry in @(Get-ChildItem -LiteralPath $State.stage -Force)) {
    if (-not (@($State.entries) -contains $entry.Name)) { throw 'Unlisted staged program entry' }
    Assert-ProgramTarget $State $entry.Name
  }
}
function Get-SHA256([string] $File) {
  # .NET is present in Windows PowerShell even when a host inherited a PowerShell
  # 7 module search path that prevents Get-FileHash from being auto-loaded.
  $algorithm = [Security.Cryptography.SHA256]::Create()
  $stream = [IO.File]::OpenRead($File)
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
function Move-ProgramEntry([string] $Source, [string] $Destination) {
  Assert-NoLinks $Source
  Assert-NoLinks $Destination
  if (Test-Path -LiteralPath $Destination) { throw "Update destination already exists: $Destination" }
  if ((Get-Item -LiteralPath $Source -Force).PSIsContainer) { [IO.Directory]::Move($Source, $Destination) }
  else { [IO.File]::Move($Source, $Destination) }
}
function Remove-ProgramEntry($State, [string] $Name) {
  Assert-ProgramTarget $State $Name
  $target = Join-Path $State.root $Name
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
function Invoke-ReplaceProgram($State) {
  Assert-StagedFiles $State
  if (Test-Path -LiteralPath $State.backup) { throw 'Backup directory already exists; recover the previous transaction first' }
  [IO.Directory]::CreateDirectory($State.backup) | Out-Null
  $journal = @{ originals = @($State.entries | Where-Object { Test-Path -LiteralPath (Join-Path $State.root $_) }); installing = $false }
  Write-Json (Join-Path $State.transaction 'journal.json') $journal
  # Rename complete top-level entries on the same volume. A failed rename leaves
  # that original intact; successfully moved originals are always discoverable.
  foreach ($name in $journal.originals) {
    Assert-ProgramTarget $State $name
    Move-ProgramEntry (Join-Path $State.root $name) (Join-Path $State.backup $name)
  }
  $journal.installing = $true
  Write-Json (Join-Path $State.transaction 'journal.json') $journal
  foreach ($entry in @(Get-ChildItem -LiteralPath $State.stage -Force)) {
    Assert-ProgramTarget $State $entry.Name
    Move-ProgramEntry $entry.FullName (Join-Path $State.root $entry.Name)
  }
}
function Invoke-Rollback($State) {
  $journalFile = Join-Path $State.transaction 'journal.json'
  if (-not (Test-Path -LiteralPath $journalFile)) { return }
  $journal = [IO.File]::ReadAllText($journalFile) | ConvertFrom-Json
  Assert-SafeTree $State.backup
  foreach ($name in $State.entries) {
    Assert-ProgramTarget $State $name
    $old = Join-Path $State.backup $name
    if (Test-Path -LiteralPath $old) {
      Remove-ProgramEntry $State $name
      Move-ProgramEntry $old (Join-Path $State.root $name)
    } elseif ($journal.installing -and -not (@($journal.originals) -contains $name)) {
      Remove-ProgramEntry $State $name
    }
  }
}
function Remove-TransactionChild($State, [string] $Child) {
  $target = Get-FullPath (Join-Path $State.transaction $Child)
  if (-not (Test-Within $State.transaction $target) -or $Child -match '[\\/]|\.\.') { throw 'Unsafe transaction cleanup path' }
  Assert-SafeTree $target
  if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
function Start-UpdatedApp($State, [bool] $Confirm) {
  if ($Confirm) { $env:CIKE_UPDATE_TOKEN = $State.confirmationToken }
  else { Remove-Item Env:CIKE_UPDATE_TOKEN -ErrorAction SilentlyContinue }
  # A hidden updater must not create a visible PowerShell window. The Electron
  # application itself creates its normal window after its process starts.
  return Start-Process -FilePath (Join-Path $State.root 'CIKE.exe') -WorkingDirectory $State.root -WindowStyle Hidden -PassThru
}
function Invoke-Update([string] $File) {
  $state = $null
  $child = $null
  $replaced = $false
  $confirmed = $false
  try {
    $state = Read-UpdateManifest $File
    Assert-StagedFiles $state
    $parent = Get-Process -Id $state.parentPid -ErrorAction SilentlyContinue
    # Hold the original process object so a reused PID cannot satisfy the wait.
    Write-Status $state 'waiting-for-exit'
    $deadline = [DateTime]::UtcNow.AddSeconds(120)
    $ready = Join-Path $state.transaction 'apply.ready'
    while (-not (Test-Path -LiteralPath $ready) -or ($null -ne $parent -and -not $parent.HasExited)) {
      if (Test-Path -LiteralPath (Join-Path $state.transaction 'cancel')) { throw 'Update was cancelled before shutdown' }
      if ([DateTime]::UtcNow -gt $deadline) { throw 'Application did not exit within the update deadline' }
      Start-Sleep -Milliseconds 200
    }
    if ([IO.File]::ReadAllText($ready) -ne $state.transactionId) { throw 'Invalid update handoff token' }
    Write-Status $state 'installing'
    # Mark rollback responsibility before the first original is moved.
    $replaced = $true
    Invoke-ReplaceProgram $state
    Write-Status $state 'awaiting-confirmation'
    $child = Start-UpdatedApp $state $true
    $deadline = [DateTime]::UtcNow.AddSeconds(90)
    $confirmation = Join-Path $state.transaction 'confirmed.json'
    while ([DateTime]::UtcNow -lt $deadline) {
      if (Test-Path -LiteralPath $confirmation) {
        $value = [IO.File]::ReadAllText($confirmation) | ConvertFrom-Json
        if ($value.transactionId -eq $state.transactionId -and $value.token -eq $state.confirmationToken -and $value.pid -eq $child.Id -and $value.version -eq $state.version) { $confirmed = $true; break }
        throw 'Application startup confirmation is invalid'
      }
      if ($child.HasExited) { throw 'Updated application exited before confirming startup' }
      Start-Sleep -Milliseconds 200
    }
    if (-not $confirmed) { throw 'Updated application did not confirm startup' }
    Write-Status $state 'confirmed'
    try {
      Remove-TransactionChild $state 'backup'
      Remove-TransactionChild $state 'stage'
      Remove-TransactionChild $state ('CIKE-' + $state.version + '-win-x64.zip')
    } catch { Write-Warning ('Update succeeded; deferred cleanup: ' + $_.Exception.Message) }
    $pending = Join-Path ([IO.Path]::GetDirectoryName($state.transaction)) 'pending.json'
    if (Test-Path -LiteralPath $pending) {
      $value = [IO.File]::ReadAllText($pending) | ConvertFrom-Json
      if ($value.transactionId -eq $state.transactionId) { Remove-Item -LiteralPath $pending -Force }
    }
    Write-Status $state 'completed'
  } catch {
    $failure = $_.Exception.Message
    Write-Error $failure -ErrorAction Continue
    if ($null -eq $state) { return 1 }
    if ($confirmed) { Write-Status $state 'confirmed' $failure; return 0 }
    if ($null -ne $child -and -not $child.HasExited) {
      Stop-Process -Id $child.Id -Force
      if (-not $child.WaitForExit(15000)) { Write-Status $state 'recovery-required' ($failure + '; cannot stop unconfirmed application'); return 1 }
    }
    if ($replaced) {
      try {
        Invoke-Rollback $state
        Write-Status $state 'rolled-back' $failure
        Start-UpdatedApp $state $false | Out-Null
      } catch { Write-Status $state 'recovery-required' ($failure + '; rollback: ' + $_.Exception.Message) }
    } else { Write-Status $state 'failed' $failure }
    return 1
  }
  return 0
}

if ($LibraryOnly) { return }
if (-not $Manifest) { throw 'Manifest path is required' }
exit (Invoke-Update $Manifest)
