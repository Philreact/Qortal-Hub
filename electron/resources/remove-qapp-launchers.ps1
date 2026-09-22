# Remove only Q-App links created by Hub. Run by the NSIS uninstaller, not updates.
$ErrorActionPreference = 'Continue'
$profiles = @($env:USERPROFILE)
Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\*' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.ProfileImagePath) {
    $profiles += [Environment]::ExpandEnvironmentVariables($_.ProfileImagePath)
  }
}

$shell = New-Object -ComObject WScript.Shell
foreach ($profile in ($profiles | Sort-Object -Unique)) {
  $roaming = Join-Path $profile 'AppData\Roaming'
  $links = Join-Path $roaming 'Microsoft\Windows\Start Menu\Programs\Qortal Hub'
  $icons = Join-Path $roaming 'qortal-hub\qapp-launchers'
  if (!(Test-Path -LiteralPath $links -PathType Container)) { continue }

  Get-ChildItem -LiteralPath $links -Filter '*.lnk' -File -ErrorAction SilentlyContinue | ForEach-Object {
    $link = $_
    try {
      $shortcut = $shell.CreateShortcut($link.FullName)
      if ($shortcut.Arguments -notmatch '(?:^|\s)--open-qapp=qortal://APP/[^\s]+') { return }

      $iconPath = ($shortcut.IconLocation -replace ',\d+$', '')
      $iconName = Split-Path $iconPath -Leaf
      $ownedIcon = $iconName -match '^qortal-qapp-[a-z0-9-]+-[a-f0-9]{16}\.ico$' -and
        [string]::Equals((Split-Path $iconPath -Parent), $icons, [StringComparison]::OrdinalIgnoreCase)
      if (!$ownedIcon) { return }

      Remove-Item -LiteralPath $link.FullName -Force -ErrorAction Stop
      Remove-Item -LiteralPath $iconPath -Force -ErrorAction SilentlyContinue
    } catch {
      # A damaged or inaccessible shortcut must not interrupt Hub removal.
    }
  }
  if (!(Get-ChildItem -LiteralPath $links -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    Remove-Item -LiteralPath $links -Force -ErrorAction SilentlyContinue
  }
  if ((Test-Path -LiteralPath $icons -PathType Container) -and
      !(Get-ChildItem -LiteralPath $icons -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {
    Remove-Item -LiteralPath $icons -Force -ErrorAction SilentlyContinue
  }
}
