param(
  [Parameter(Mandatory = $true)][ValidateSet('ExtractZip', 'Version')][string]$Operation,
  [string]$Archive,
  [string]$Destination,
  [string]$Executable
)
$ErrorActionPreference = 'Stop'
# Load only the modules shipped beside this PowerShell executable. Automatic
# discovery can scan unrelated machine/user modules for tens of seconds on CI.
$PSModuleAutoLoadingPreference = 'None'
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1" -Scope Local
Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -Scope Local
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

if ($Operation -eq 'Version') {
  $item = Get-Item -LiteralPath $Executable -Force
  if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Executable must be a regular file' }
  $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($item.FullName)
  foreach ($candidate in @($version.ProductVersion, $version.FileVersion)) {
    if ($candidate -match '\b\d+\.\d+\.\d+\.\d+\b') { [Console]::WriteLine($Matches[0]); exit 0 }
  }
  # Some PE producers render only three components in their string resource.
  # The fixed numeric FileVersion retains all four components without running
  # the program (Node and Electron fixtures commonly use this representation).
  if ($version.FileVersion -match '^\d+\.\d+\.\d+(?:[-+].*)?$') {
    [Console]::WriteLine(('{0}.{1}.{2}.{3}' -f $version.FileMajorPart, $version.FileMinorPart, $version.FileBuildPart, $version.FilePrivatePart))
    exit 0
  }
  throw 'Executable has no valid PE version'
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\', '/')
if (Test-Path -LiteralPath $root) {
  $rootItem = Get-Item -LiteralPath $root -Force
  if (!$rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Destination must be a regular directory' }
  if (@(Get-ChildItem -LiteralPath $root -Force).Count -gt 0) { throw 'Extraction destination must be empty' }
}
# Check every existing parent before creating anything. ZIP extraction must
# not traverse an NTFS junction supplied by a previous installation.
$parent = $root
while ($parent) {
  # AppData and valid portable ancestors can be hidden; inspect their attributes
  # without confusing the Hidden flag with a missing or unsafe directory.
  if ((Test-Path -LiteralPath $parent) -and ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Reparse point in extraction destination' }
  $parent = [IO.Path]::GetDirectoryName($parent)
}
$prefix = $root + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead([IO.Path]::GetFullPath($Archive))
try {
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  $entries = New-Object 'System.Collections.Generic.List[object]'
  [long]$expanded = 0
  if ($zip.Entries.Count -gt 100000) { throw 'ZIP contains too many entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('\', '/')
    if (!$name -or $name.StartsWith('/') -or $name.Contains(':') -or $name.Contains([char]0)) { throw 'Unsafe ZIP path' }
    $directory = $name.EndsWith('/')
    $parts = $name.TrimEnd('/').Split('/')
    foreach ($part in $parts) {
      if (!$part -or $part -eq '.' -or $part -eq '..' -or $part -match '[<>"|?*\x00-\x1f]' -or $part -match '[. ]$' -or $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'Unsafe ZIP path component' }
    }
    # Unix symlinks and Windows reparse flags are rejected even though this
    # extractor writes ordinary files; they must not survive as trusted input.
    $kind = (($entry.ExternalAttributes -shr 16) -band 0xF000)
    if (($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) -or ($entry.ExternalAttributes -band 0x400)) { throw 'ZIP links and special files are forbidden' }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, ($parts -join [IO.Path]::DirectorySeparatorChar)))
    if (!$target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or !$names.Add($target)) { throw 'ZIP path escapes destination or is duplicated' }
    $expanded += $entry.Length
    if ($expanded -gt 4294967296) { throw 'Expanded ZIP is too large' }
    $entries.Add(@{ Entry = $entry; Target = $target; Directory = $directory })
  }
  # A file may not be used as a directory by another entry. Validate the
  # complete archive before the first extracted byte reaches the destination.
  $files = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  foreach ($record in $entries) { if (!$record.Directory) { [void]$files.Add($record.Target) } }
  foreach ($record in $entries) {
    $parent = [IO.Path]::GetDirectoryName($record.Target)
    while ($parent -and $parent.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
      if ($files.Contains($parent)) { throw 'Conflicting ZIP file and directory' }
      $parent = [IO.Path]::GetDirectoryName($parent)
    }
  }
  [void][IO.Directory]::CreateDirectory($root)
  foreach ($record in $entries) {
    if ($record.Directory) { [void][IO.Directory]::CreateDirectory($record.Target); continue }
    [void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($record.Target))
    $inputStream = $record.Entry.Open()
    try {
      $outputStream = New-Object IO.FileStream($record.Target, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
      try { $inputStream.CopyTo($outputStream) } finally { $outputStream.Dispose() }
    } finally { $inputStream.Dispose() }
  }
} finally { $zip.Dispose() }
