@echo off
rem Bat bo quet tai Viet Nam cho cong cu bao gia tren Vercel (xem docs/bo-quet-viet-nam.md).
rem Bam dup file nay. De nguyen cua so; dong cua so = tat bo quet (Vercel se quet thay).
cd /d %~dp0

if not exist node_modules (
  echo [1/3] Cai thu vien lan dau...
  call npm ci || goto :fail
  call npx playwright install chromium || goto :fail
)

if not exist .env.worker (
  echo [2/3] Lay chuoi ket noi co so du lieu tu Vercel ^(file .env.worker, khong dua len git^)...
  call vercel env pull .env.worker --environment=production --yes || (
    echo.
    echo Khong lay duoc. Chay lenh "vercel login" de dang nhap Vercel roi bam dup lai file nay.
    goto :fail
  )
)

echo [3/3] Chay bo quet...
:loop
call npm run scan-worker
echo.
echo Bo quet da dung. Tu chay lai sau 10 giay - dong cua so de tat han.
timeout /t 10 >nul
goto loop

:fail
echo.
pause
exit /b 1
