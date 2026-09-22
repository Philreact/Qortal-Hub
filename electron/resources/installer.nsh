!macro customInstall
  DetailPrint "Adding Windows Firewall rule for Qortal Hub Reticulum..."
  ExecWait 'netsh advfirewall firewall delete rule name="Qortal Hub Reticulum" program="$INSTDIR\resources\reticulum\rnsd.exe"'
  ExecWait 'netsh advfirewall firewall add rule name="Qortal Hub Reticulum" dir=in action=allow program="$INSTDIR\resources\reticulum\rnsd.exe" enable=yes profile=private,public'
!macroend

!macro customUnInstall
  DetailPrint "Removing Windows Firewall rule for Qortal Hub Reticulum..."
  ExecWait 'netsh advfirewall firewall delete rule name="Qortal Hub Reticulum" program="$INSTDIR\resources\reticulum\rnsd.exe"'
  ${ifNot} ${isUpdated}
    ExecWait 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\remove-qapp-launchers.ps1"'
  ${endIf}
!macroend
