@echo off
rem Installs FEAR / FEAR Command on an Android phone connected by USB.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\launcher\fear.ps1" phone
