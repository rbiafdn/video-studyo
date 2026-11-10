@echo off
chcp 65001 >nul
title Video Stüdyo
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js bulunamadi. Once https://nodejs.org adresinden LTS surumunu kurun, sonra bu dosyayi tekrar calistirin.
  pause
  exit /b 1
)

if not exist ".env" (
  echo .env dosyasi yok. .env.example dosyasini .env olarak kopyalayip anahtarlari doldurun.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Ilk kurulum: paketler yukleniyor, 1-2 dakika surebilir...
  call npm install
  if errorlevel 1 (
    echo npm install basarisiz oldu.
    pause
    exit /b 1
  )
)

echo Video Studyo baslatiliyor... Bu pencereyi kapatmayin; kapatinca uygulama durur.
start "" http://localhost:3000
call npm start
pause
