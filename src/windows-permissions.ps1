param(
  [Parameter(Mandatory = $true)][string]$TargetPath,
  [Parameter(Mandatory = $true)][ValidateSet('Directory', 'File')][string]$Kind
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$PSModuleAutoLoadingPreference = 'None'

# Windows PowerShell starts cold on a new hosted runner. Use .NET directly so
# protecting files never requires module discovery or loading user modules.
# Stages are captured by Node and appear only if the helper fails or times out.
[Console]::Error.WriteLine('[private-acl] inspecting paths')

# Paths arrive as separate argv values. Never interpolate a caller-controlled
# path into PowerShell source, and never modify permissions of parent folders.
$resolved = [IO.Path]::GetFullPath($TargetPath)
if ($resolved.TrimEnd('\') -eq [IO.Path]::GetPathRoot($resolved).TrimEnd('\')) {
  throw 'A drive root cannot be used as a private data directory.'
}
$cursor = $resolved
while ($cursor) {
  $attributes = [IO.File]::GetAttributes($cursor)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Private data paths cannot contain a reparse point.'
  }
  $next = [IO.Path]::GetDirectoryName($cursor)
  if ($next -eq $cursor) { break }
  $cursor = $next
}
$attributes = [IO.File]::GetAttributes($resolved)
$directory = $Kind -eq 'Directory'
if ((($attributes -band [IO.FileAttributes]::Directory) -ne 0) -ne $directory) { throw 'Unexpected private path type.' }

# SID values work on every Windows display language. A fresh protected DACL
# removes both inherited and explicit access for unrelated accounts/groups.
[Console]::Error.WriteLine('[private-acl] constructing SID permissions')
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted = [Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
foreach ($sid in @($user.Value, 'S-1-5-18', 'S-1-5-32-544')) { [void]$trusted.Add($sid) }
$acl = if ($directory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
$inheritance = if ($directory) {
  [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
} else { [Security.AccessControl.InheritanceFlags]::None }
foreach ($sid in $trusted) {
  $identity = [Security.Principal.SecurityIdentifier]::new($sid)
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
  [void]$acl.AddAccessRule($rule)
}
[Console]::Error.WriteLine('[private-acl] setting ACL')
if ($directory) { [IO.Directory]::SetAccessControl($resolved, $acl) }
else { [IO.File]::SetAccessControl($resolved, $acl) }

# Fail closed on unsupported filesystems, denied changes, or partial ACL writes.
[Console]::Error.WriteLine('[private-acl] verifying ACL')
$actual = if ($directory) { [IO.Directory]::GetAccessControl($resolved) } else { [IO.File]::GetAccessControl($resolved) }
if (-not $actual.AreAccessRulesProtected) { throw 'Private ACL inheritance remained enabled.' }
if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'Private path owner verification failed.' }
$rules = @($actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
foreach ($rule in $rules) {
  if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow -or !$trusted.Contains($rule.IdentityReference.Value) -or $rule.IsInherited) {
    throw 'Private ACL contains an unexpected permission.'
  }
}
foreach ($sid in $trusted) {
  $matchCount = 0
  foreach ($rule in $rules) {
    if ($rule.IdentityReference.Value -eq $sid -and
        $rule.FileSystemRights -eq [Security.AccessControl.FileSystemRights]::FullControl -and
        $rule.InheritanceFlags -eq $inheritance -and
        $rule.PropagationFlags -eq [Security.AccessControl.PropagationFlags]::None) { $matchCount++ }
  }
  if ($matchCount -ne 1) { throw 'Private ACL required permission verification failed.' }
}
[Console]::Error.WriteLine('[private-acl] verified')
