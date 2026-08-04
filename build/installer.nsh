; Adds "Open with Forge" to the Explorer context menu for folders, so the app
; behaves like an IDE people install rather than a binary they run from a
; folder. Registered under HKCU because the installer is per-user by default.

!macro customInstall
  WriteRegStr HKCU "Software\Classes\Directory\shell\ForgeIDE" "" "Open with Forge"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ForgeIDE" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\ForgeIDE\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ForgeIDE" "" "Open with Forge"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ForgeIDE" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\ForgeIDE\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\ForgeIDE"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\ForgeIDE"
!macroend
