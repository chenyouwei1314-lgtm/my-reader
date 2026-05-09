# ===== AirWei Reader 檔案關聯註冊 =====
# 目的：
# .pdf 使用白底 icon
# .cbz 使用黑底 icon
# 開啟程式使用已安裝的 AirWei Reader.exe

$ErrorActionPreference = "Stop"

# ===== 你的專案 icon 來源 =====
$ProjectRoot = "D:\Youwei Work\my-reader"
$PdfIconSource = Join-Path $ProjectRoot "src\icon_airwei_pdf_white.ico"
$CbzIconSource = Join-Path $ProjectRoot "src\icon_airwei_cbz_black.ico"

# ===== Squirrel 安裝位置 =====
$InstallRoot = Join-Path $env:LOCALAPPDATA "airwei_reader"
$AppExe = Join-Path $InstallRoot "AirWei Reader.exe"

# ===== 把 icon 複製到安裝資料夾底下，避免之後專案搬位置造成 icon 失效 =====
$IconDir = Join-Path $InstallRoot "icons"
$PdfIcon = Join-Path $IconDir "icon_airwei_pdf_white.ico"
$CbzIcon = Join-Path $IconDir "icon_airwei_cbz_black.ico"

if (!(Test-Path $AppExe)) {
  throw "找不到 AirWei Reader.exe：$AppExe"
}

if (!(Test-Path $PdfIconSource)) {
  throw "找不到 PDF icon：$PdfIconSource"
}

if (!(Test-Path $CbzIconSource)) {
  throw "找不到 CBZ icon：$CbzIconSource"
}

New-Item -ItemType Directory -Force -Path $IconDir | Out-Null
Copy-Item -Force $PdfIconSource $PdfIcon
Copy-Item -Force $CbzIconSource $CbzIcon

# ===== ProgID 名稱 =====
$PdfProgId = "AirWeiReader.PDF"
$CbzProgId = "AirWeiReader.CBZ"

# ===== 註冊副檔名與 ProgID =====
New-Item -Force "HKCU:\Software\Classes\.pdf" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\.pdf" -Name "(default)" -Value $PdfProgId | Out-Null
New-Item -Force "HKCU:\Software\Classes\.pdf\OpenWithProgids" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\.pdf\OpenWithProgids" -Name $PdfProgId -Value ([byte[]]@()) -PropertyType Binary | Out-Null

New-Item -Force "HKCU:\Software\Classes\.cbz" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\.cbz" -Name "(default)" -Value $CbzProgId | Out-Null
New-Item -Force "HKCU:\Software\Classes\.cbz\OpenWithProgids" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\.cbz\OpenWithProgids" -Name $CbzProgId -Value ([byte[]]@()) -PropertyType Binary | Out-Null

# ===== PDF ProgID =====
New-Item -Force "HKCU:\Software\Classes\$PdfProgId" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\$PdfProgId" -Name "(default)" -Value "AirWei PDF Document" | Out-Null

New-Item -Force "HKCU:\Software\Classes\$PdfProgId\DefaultIcon" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\$PdfProgId\DefaultIcon" -Name "(default)" -Value "`"$PdfIcon`",0" | Out-Null

New-Item -Force "HKCU:\Software\Classes\$PdfProgId\shell\open\command" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\$PdfProgId\shell\open\command" -Name "(default)" -Value "`"$AppExe`" `"%1`"" | Out-Null

# ===== CBZ ProgID =====
New-Item -Force "HKCU:\Software\Classes\$CbzProgId" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\$CbzProgId" -Name "(default)" -Value "AirWei Comic Book Archive" | Out-Null

New-Item -Force "HKCU:\Software\Classes\$CbzProgId\DefaultIcon" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\$CbzProgId\DefaultIcon" -Name "(default)" -Value "`"$CbzIcon`",0" | Out-Null

New-Item -Force "HKCU:\Software\Classes\$CbzProgId\shell\open\command" | Out-Null
New-ItemProperty -Force "HKCU:\Software\Classes\$CbzProgId\shell\open\command" -Name "(default)" -Value "`"$AppExe`" `"%1`"" | Out-Null

# ===== 讓 Windows 預設應用程式頁面看得到 AirWei Reader =====
$CapabilitiesPath = "HKCU:\Software\AirWei Reader\Capabilities"
New-Item -Force $CapabilitiesPath | Out-Null
New-ItemProperty -Force $CapabilitiesPath -Name "ApplicationName" -Value "AirWei Reader" | Out-Null
New-ItemProperty -Force $CapabilitiesPath -Name "ApplicationDescription" -Value "AirWei Reader for PDF and CBZ files" | Out-Null

New-Item -Force "$CapabilitiesPath\FileAssociations" | Out-Null
New-ItemProperty -Force "$CapabilitiesPath\FileAssociations" -Name ".pdf" -Value $PdfProgId | Out-Null
New-ItemProperty -Force "$CapabilitiesPath\FileAssociations" -Name ".cbz" -Value $CbzProgId | Out-Null

New-Item -Force "HKCU:\Software\RegisteredApplications" | Out-Null
New-ItemProperty -Force "HKCU:\Software\RegisteredApplications" -Name "AirWei Reader" -Value "Software\AirWei Reader\Capabilities" | Out-Null

# ===== 通知 Windows 更新關聯與 icon cache =====
Start-Process "ie4uinit.exe" -ArgumentList "-show" -WindowStyle Hidden -ErrorAction SilentlyContinue

Write-Host "AirWei Reader 檔案關聯註冊完成。"
Write-Host ".pdf icon：$PdfIcon"
Write-Host ".cbz icon：$CbzIcon"
Write-Host "開啟程式：$AppExe"
Write-Host "如果檔案總管圖示沒有馬上變，請重開檔案總管或重新登入。"