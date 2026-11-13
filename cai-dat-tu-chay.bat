@echo off
rem Cai bo quet Viet Nam TU CHAY moi khi dang nhap Windows (khong can quyen admin).
rem Bam dup 1 lan. Muon go: bam dup go-tu-chay.bat.
cd /d %~dp0
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "VBS=%STARTUP%\MBWS-bo-quet.vbs"

if not exist .env.worker (
  echo Chua co file .env.worker. Bam dup chay-bo-quet.bat mot lan truoc de lay ket noi co so du lieu.
  pause
  exit /b 1
)

rem Chay thu nho (cua so thu nho tren thanh tac vu), khong lam phien nguoi dung
> "%VBS%" echo CreateObject("WScript.Shell").Run """%~dp0chay-bo-quet.bat""", 7, False
echo Da cai tu chay: %VBS%
echo.
echo Bat bo quet ngay bay gio...
wscript "%VBS%"
echo.
echo Xong. Bo quet se tu chay moi khi dang nhap Windows (cua so thu nho tren thanh tac vu).
echo Nho tat che do ngu: Settings - System - Power - Sleep: Never.
pause
