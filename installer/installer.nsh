!macro customInstall
  DetailPrint "Registering AirWei Thumbnail Provider..."

  ExecWait '"$INSTDIR\resources\thumbnail-provider\ServerRegistrationManager.exe" install "$INSTDIR\resources\thumbnail-provider\AirWeiThumbnailProvider.dll" -codebase -os64'

  WriteRegStr HKCR ".cbz\shellex\{e357fccd-a995-4576-b01f-234630154e96}" "" "{17D4BEEF-136F-38F6-9A11-D6BEF64E7412}"
  WriteRegStr HKCR ".pdf\shellex\{e357fccd-a995-4576-b01f-234630154e96}" "" "{011456D4-476E-3852-AD94-91D93B645522}"

  WriteRegStr HKCR ".cbz" "" "AirWeiReader.CBZ"
  WriteRegStr HKCR "AirWeiReader.CBZ" "" "AirWei Comic Book Archive"
  WriteRegStr HKCR "AirWeiReader.CBZ\DefaultIcon" "" "$INSTDIR\resources\thumbnail-provider\AirWeiThumbnailProvider.dll,0"
  WriteRegStr HKCR "AirWeiReader.CBZ\shell\open\command" "" '"$INSTDIR\AirWei Reader.exe" "%1"'

  WriteRegStr HKCR ".pdf" "" "AirWeiReader.PDF"
  WriteRegStr HKCR "AirWeiReader.PDF" "" "AirWei PDF Document"
  WriteRegStr HKCR "AirWeiReader.PDF\DefaultIcon" "" "$INSTDIR\resources\thumbnail-provider\AirWeiThumbnailProvider.dll,0"
  WriteRegStr HKCR "AirWeiReader.PDF\shell\open\command" "" '"$INSTDIR\AirWei Reader.exe" "%1"'

  ExecWait 'ie4uinit.exe -show'
!macroend

!macro customUnInstall
  DetailPrint "Unregistering AirWei Thumbnail Provider..."

  ExecWait '"$INSTDIR\resources\thumbnail-provider\ServerRegistrationManager.exe" uninstall "$INSTDIR\resources\thumbnail-provider\AirWeiThumbnailProvider.dll"'

  DeleteRegKey HKCR ".cbz\shellex\{e357fccd-a995-4576-b01f-234630154e96}"
  DeleteRegKey HKCR ".pdf\shellex\{e357fccd-a995-4576-b01f-234630154e96}"

  DeleteRegKey HKCR "AirWeiReader.CBZ"
  DeleteRegKey HKCR "AirWeiReader.PDF"

  ExecWait 'ie4uinit.exe -show'
!macroend