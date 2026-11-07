param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][ValidateSet('Directory', 'File')][string]$Kind
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Paths arrive as separate argv values. Never interpolate a caller-controlled
# path into PowerShell source, and never modify permissions of parent folders.
$resolved = [IO.Path]::GetFullPath($TargetPath)
if ($resolved.TrimEnd('\') -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\')) {
  throw 'A drive root cannot be used as a private data directory.'
}
$cursor = $resolved
while ($cursor) {
  $item = Get-Item -LiteralPath $cursor -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Private data paths cannot contain a reparse point.'
  }
  $next = [IO.Path]::GetDirectoryName($cursor)
  if ($next -eq $cursor) { break }
  $cursor = $next
}
$item = Get-Item -LiteralPath $resolved -Force
$directory = $Kind -eq 'Directory'
if ($item.PSIsContainer -ne $directory) { throw 'Unexpected private path type.' }

# SID values work on every Windows display language. A fresh protected DACL
# removes both inherited and explicit access for unrelated accounts/groups.
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = @($user.Value, 'S-1-5-18', 'S-1-5-32-544') | Select-Object -Unique
$acl = if ($directory) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($directory) {
  [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in $trusted) {
  $identity = New-Object Security.Principal.SecurityIdentifier($sid)
  $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $resolved -AclObject $acl

# Fail closed on unsupported filesystems, denied changes, or partial ACL writes.
$actual = Get-Acl -LiteralPath $resolved
if (-not $actual.AreAccessRulesProtected) { throw 'Private ACL inheritance remained enabled.' }
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Private path owner verification failed.' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or $rule.IdentityReference.Value -notin $trusted -or $rule.IsInherited) {
    throw 'Private ACL contains an unexpected permission.'
  }
}
foreach ($sid in $trusted) {
  $matches = @($rules | Where-Object {
    $_.IdentityReference.Value -eq $sid -and
    $_.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
    $_.InheritanceFlags -eq $inheritance -and
    $_.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None
  })
  if ($matches.Count -ne 1) { throw 'Private ACL required permission verification failed.' }
}
