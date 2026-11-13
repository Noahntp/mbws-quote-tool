@echo off
rem Go bo tu chay bo quet Viet Nam khi dang nhap Windows (bo quet dang chay: dong cua so cua no).
set "VBS=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\MBWS-bo-quet.vbs"
if exist "%VBS%" (del "%VBS%" && echo Da go tu chay.) else (echo Chua cai tu chay.)
pause
