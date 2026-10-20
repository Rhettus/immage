; Tauri's NSIS installer hooks (tauri.windows.conf.json, installerHooks)

; the installer asks whether to install for everyone, in Program Files, or
; just for this user, under AppData (installMode both), and looks for an
; earlier install only where the choice registers it: HKLM or HKCU. up to
; 0.31 Immage installed per user only, so installing for everyone over that
; would leave two copies. the per-user one goes first, silently: a silent
; uninstall leaves the user's settings, models and caches in AppData, since
; only its unticked checkbox deletes them
!macro NSIS_HOOK_PREINSTALL
  Push $R0
  Push $R1
  Push $R2
  StrCpy $R0 ""
  ${If} $MultiUser.InstallMode == "AllUsers"
    ReadRegStr $R0 HKCU "${UNINSTKEY}" "UninstallString"
  ${EndIf}
  ReadRegStr $R1 HKCU "${UNINSTKEY}" "InstallLocation"
  ${If} $R0 != ""
  ${AndIf} $R1 != ""
    ; InstallLocation is written in quotes
    StrCpy $R2 $R1 1
    ${If} $R2 == '"'
      StrCpy $R1 $R1 "" 1
      StrCpy $R1 $R1 -1
    ${EndIf}
    DetailPrint "Removing the earlier per-user install in $R1"
    ; _?= runs the uninstaller in place, so ExecWait waits for it; it then
    ; leaves itself and its folder behind
    ExecWait '$R0 /S _?=$R1' $R2
    ${If} $R2 = 0
      Delete "$R1\uninstall.exe"
      RMDir "$R1"
    ${EndIf}
  ${EndIf}
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
