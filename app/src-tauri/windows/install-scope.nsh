; Immage scope selection and deferred elevation. MultiUser.InstallMode keeps
; compatibility with Tauri's registry/shortcut code without MultiUser.nsh,
; whose Highest manifest elevates before the scope page is displayed.
!include nsDialogs.nsh
Var MultiUser.InstallMode
Var ImmageAllUsersRadio
Var ImmageNeedsAdmin
Var ImmageRequestedDir
Var ImmageQuote

; Sets OUT to the uninstaller ROOT registers, or to "" when there is no
; registration or its uninstaller no longer exists. Uninstallers from 0.43 and
; earlier could delete themselves but leave the machine registration (#31).
!macro ImmageRegisteredUninstaller ROOT OUT
  ReadRegStr ${OUT} ${ROOT} "${UNINSTKEY}" "UninstallString"
  StrCpy $ImmageQuote ${OUT} 1
  ${If} $ImmageQuote == '$\"'
    StrCpy ${OUT} ${OUT} "" 1
    StrCpy ${OUT} ${OUT} -1
  ${EndIf}
  ${If} ${OUT} != ""
  ${AndIfNot} ${FileExists} "${OUT}"
    StrCpy ${OUT} ""
  ${EndIf}
!macroend

Function ImmageSetScope
  StrCpy $ImmageNeedsAdmin false
  ${If} $MultiUser.InstallMode == "AllUsers"
    SetShellVarContext all
    StrCpy $ImmageNeedsAdmin true
    StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCTNAME}"
  ${Else}
    SetShellVarContext current
    StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCTNAME}"
  ${EndIf}
  Call RestorePreviousInstallLocation
FunctionEnd

Function ImmageScopeInit
  StrCpy $ImmageRequestedDir $INSTDIR
  StrCpy $MultiUser.InstallMode CurrentUser
  ; Prefer the invoking user's install, otherwise the machine install. A
  ; leftover machine registration still selects Everyone, so the reinstall
  ; page can remove it once elevated.
  !insertmacro ImmageRegisteredUninstaller HKCU $0
  ${If} $0 == ""
    ReadRegStr $0 HKLM "${UNINSTKEY}" "UninstallString"
    ${IfThen} $0 != "" ${|} StrCpy $MultiUser.InstallMode AllUsers ${|}
  ${EndIf}
  ; /D from the updater disambiguates machines with both scopes installed.
  ReadRegStr $0 HKLM "${UNINSTKEY}" "InstallLocation"
  ${If} $0 == '$\"$ImmageRequestedDir$\"'
    StrCpy $MultiUser.InstallMode AllUsers
  ${EndIf}
  ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
  ${If} $0 == '$\"$ImmageRequestedDir$\"'
    StrCpy $MultiUser.InstallMode CurrentUser
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/AllUsers" $0
  ${IfNot} ${Errors}
    StrCpy $MultiUser.InstallMode AllUsers
  ${EndIf}
  ClearErrors
  ${GetOptions} $CMDLINE "/CurrentUser" $0
  ${IfNot} ${Errors}
    StrCpy $MultiUser.InstallMode CurrentUser
  ${EndIf}
  ${If} ${UAC_IsInnerInstance}
    !insertmacro UAC_AsUser_GetGlobalVar $MultiUser.InstallMode
    !insertmacro UAC_AsUser_GetGlobal $ImmageRequestedDir $INSTDIR
    ${IfNot} ${UAC_IsAdmin}
      SetErrorLevel 740
      Quit
    ${EndIf}
  ${EndIf}
  Call ImmageSetScope
  ${If} $ImmageRequestedDir != "${PLACEHOLDER_INSTALL_DIR}"
    StrCpy $INSTDIR $ImmageRequestedDir
  ${EndIf}
  ${If} ${Silent}
  ${OrIf} $PassiveMode = 1
    Call ImmageElevate
  ${EndIf}
FunctionEnd

Function ImmageGuiInit
  !insertmacro UAC_PageElevation_OnGuiInit
FunctionEnd

Function ImmageScopePage
  ${If} $PassiveMode = 1
  ${OrIf} ${UAC_IsInnerInstance}
    Abort
  ${EndIf}
  !insertmacro MUI_HEADER_TEXT "Install for whom?" "Choose who can use ${PRODUCTNAME} on this computer."
  nsDialogs::Create 1018
  Pop $0
  ${NSD_CreateRadioButton} 0 20u 100% 20u "Just for me (no administrator permissions required)"
  Pop $1
  ${NSD_CreateRadioButton} 0 50u 100% 20u "Everyone on this computer (requires administrator permissions)"
  Pop $ImmageAllUsersRadio
  ${If} $MultiUser.InstallMode == "AllUsers"
    ${NSD_Check} $ImmageAllUsersRadio
  ${Else}
    ${NSD_Check} $1
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function ImmageScopeLeave
  ${NSD_GetState} $ImmageAllUsersRadio $0
  StrCpy $1 $MultiUser.InstallMode
  StrCpy $MultiUser.InstallMode CurrentUser
  ${IfThen} $0 = ${BST_CHECKED} ${|} StrCpy $MultiUser.InstallMode AllUsers ${|}
  ${If} $1 != $MultiUser.InstallMode
    Call ImmageSetScope
  ${EndIf}
  Call ImmageElevate
FunctionEnd

Function ImmageElevate
  ${If} $MultiUser.InstallMode == "AllUsers"
  ${AndIfNot} ${UAC_IsAdmin}
    !insertmacro UAC_PageElevation_RunElevated
    ${If} $0 = 0
    ${AndIf} $1 = 1
      SetErrorLevel $2
      Quit
    ${EndIf}
    ${If} $0 != 1223
      MessageBox MB_ICONSTOP|MB_OK "Unable to obtain administrator permissions. Setup has not installed ${PRODUCTNAME}." /SD IDOK
    ${EndIf}
    ${If} ${Silent}
    ${OrIf} $PassiveMode = 1
      SetErrorLevel 740
      Quit
    ${EndIf}
    ; UAC cancellation returns to the scope page without uninstalling anything.
    Abort
  ${EndIf}
FunctionEnd

Function ImmageDisableBack
  ${If} ${UAC_IsInnerInstance}
    GetDlgItem $0 $HWNDPARENT 3
    EnableWindow $0 0
  ${EndIf}
FunctionEnd

Function ImmagePrepare
  ${If} $MultiUser.InstallMode == "AllUsers"
    ; Execute migration in the original user's broker, after UAC succeeds.
    !insertmacro UAC_AsUser_Call Function ImmageRemovePerUser ${UAC_SYNCREGISTERS}
    ${If} $0 != 0
      SetErrorLevel $0
      Abort "Unable to remove the earlier per-user installation. Uninstall it and run setup again."
    ${EndIf}
  ${EndIf}
FunctionEnd

Function ImmageRemovePerUser
  SetShellVarContext current
  ReadRegStr $1 HKCU "${UNINSTKEY}" "UninstallString"
  ReadRegStr $2 HKCU "${UNINSTKEY}" "InstallLocation"
  StrCpy $0 0
  !insertmacro ImmageRegisteredUninstaller HKCU $3
  ${If} $1 != ""
  ${AndIf} $3 == ""
    ; Only the registration is left; its uninstaller is gone.
    DeleteRegKey HKCU "${UNINSTKEY}"
    StrCpy $1 ""
  ${EndIf}
  ${If} $1 != ""
  ${AndIf} $2 != ""
    StrCpy $3 $2 1
    ${If} $3 == '$\"'
      StrCpy $2 $2 "" 1
      StrCpy $2 $2 -1
    ${EndIf}
    ClearErrors
    ; /CurrentUser: see reinst_uninstall in installer.nsi.
    ExecWait '$1 /S /CurrentUser _?=$2' $0
    ${If} ${Errors}
      StrCpy $0 2
    ${EndIf}
    ${If} $0 = 0
      ReadRegStr $3 HKCU "${UNINSTKEY}" "UninstallString"
      ${If} $3 != ""
      ${OrIf} ${FileExists} "$2\${MAINBINARYNAME}.exe"
        StrCpy $0 2
      ${EndIf}
    ${EndIf}
    ${If} $0 = 0
      Delete "$2\uninstall.exe"
      RMDir "$2"
    ${EndIf}
  ${EndIf}
  ; A direct, already elevated invocation has no outer broker to restore it.
  SetShellVarContext all
FunctionEnd

Function un.ImmageScopeInit
  StrCpy $MultiUser.InstallMode CurrentUser
  ReadRegStr $0 HKLM "${UNINSTKEY}" "InstallLocation"
  ${If} $0 == '$\"$INSTDIR$\"'
    StrCpy $MultiUser.InstallMode AllUsers
    SetShellVarContext all
    !insertmacro UAC_RunElevated
    ${If} $0 = 0
    ${AndIf} $1 = 1
      SetErrorLevel $2
      Quit
    ${EndIf}
    ${If} $0 != 0
    ${OrIf} $3 != 1
      SetErrorLevel 740
      Quit
    ${EndIf}
  ${Else}
    ReadRegStr $0 HKCU "${UNINSTKEY}" "InstallLocation"
    ${If} $0 != '$\"$INSTDIR$\"'
      MessageBox MB_ICONSTOP|MB_OK "This installation is not registered for this account." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
    SetShellVarContext current
  ${EndIf}
FunctionEnd

Function un.ImmageCleanupUser
  ; $0 = delete-data checkbox, $1 = update flag, synchronized by UAC.
  SetShellVarContext current
  ${If} $1 != 1
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCTNAME}"
    ${If} $0 = 1
      DeleteRegValue HKCU "${MANUPRODUCTKEY}" "Installer Language"
      DeleteRegKey /ifempty HKCU "${MANUPRODUCTKEY}"
      DeleteRegKey /ifempty HKCU "${MANUKEY}"
      RMDir /r "$APPDATA\${BUNDLEID}"
      RMDir /r "$LOCALAPPDATA\${BUNDLEID}"
    ${EndIf}
  ${EndIf}
FunctionEnd
