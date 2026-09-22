!macro customUnInstall
  ${ifNot} ${isUpdated}
    ExecWait 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\resources\remove-qapp-launchers.ps1"'
  ${endIf}
!macroend
