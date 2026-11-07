$ErrorActionPreference = 'Stop'
$package = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
$version = [string]$package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a stable three-part package version.' }
$bundle = Join-Path $PWD 'dist/CIKE-win32-x64'
foreach ($relative in @('CIKE.exe','resources/app/package.json','resources/app/electron/main.js','resources/app/electron/portable.js','resources/app/electron/windows-update.ps1','resources/app/src/windows-runtime.ps1','resources/app/src/windows-permissions.ps1','resources/app/node_modules/playwright-core/browsers.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $bundle $relative) -PathType Leaf)) { throw "Incomplete package: $relative" }
}
foreach ($reserved in @('data','browsers','Downloads','.ci-runtime','.workflow-publish')) {
  if ((Test-Path -LiteralPath (Join-Path $bundle $reserved)) -or (Test-Path -LiteralPath (Join-Path $bundle "resources/app/$reserved"))) { throw "User/test data entered the package: $reserved" }
}
$packaged = Get-Content -LiteralPath (Join-Path $bundle 'resources/app/package.json') -Raw | ConvertFrom-Json
if ($packaged.version -ne $version) { throw 'Packaged version mismatch.' }
$commit = git rev-parse HEAD
if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[a-f0-9]{40}$') { throw 'Cannot identify build commit.' }
$artifactDir = Join-Path $PWD 'artifacts'
New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
$notes = @(
  "CIKE $version - Windows x64",
  "Source: https://github.com/hanxin1997/cike/commit/$commit",
  "Build: $($env:GITHUB_SERVER_URL)/$($env:GITHUB_REPOSITORY)/actions/runs/$($env:GITHUB_RUN_ID)",
  'Extract the entire ZIP into a dedicated writable directory and run CIKE.exe.',
  'Default user folders beside CIKE.exe: data, browsers, Downloads.',
  'Keep these user folders when installing a new version manually.',
  'The app checks hanxin1997/cike Releases; installation requires confirmation.',
  'This build is unsigned. SHA256 checks file integrity, not publisher identity.'
)
$notes | Set-Content -LiteralPath (Join-Path $bundle 'BUILD-INFO.txt') -Encoding utf8
$notes | Set-Content -LiteralPath (Join-Path $artifactDir 'BUILD-INFO.txt') -Encoding utf8
$zipName = "CIKE-$version-win-x64.zip"
$zipPath = Join-Path $artifactDir $zipName
# The updater validates program files at ZIP root; do not add an outer bundle folder.
$programItems = @(Get-ChildItem -LiteralPath $bundle -Force | Select-Object -ExpandProperty FullName)
Compress-Archive -LiteralPath $programItems -DestinationPath $zipPath -CompressionLevel Optimal -Force
$hash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $zipName" | Set-Content -LiteralPath (Join-Path $artifactDir 'SHA256SUMS-win-x64.txt') -Encoding ascii
if ($env:GITHUB_OUTPUT) { "version=$version" >> $env:GITHUB_OUTPUT }
if ($env:GITHUB_STEP_SUMMARY) {
  @("## Windows $version",'',"Source commit: $commit",'',"Package: $zipName",'Windows regression and packaged application tests completed before archiving.','Default data, kernel and downloads stay beside CIKE.exe.') >> $env:GITHUB_STEP_SUMMARY
}
