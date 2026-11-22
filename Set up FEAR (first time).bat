@echo off
rem First time on a computer: installs what FEAR needs and makes the desktop shortcuts.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\fear.ps1" setup
