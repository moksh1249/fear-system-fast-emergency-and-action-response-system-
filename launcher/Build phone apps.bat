@echo off
rem Developers: rebuilds both Android apps and the Command web dashboard (needs Flutter),
rem then copies the apps into "Android apps" for the download page.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fear.ps1" build
