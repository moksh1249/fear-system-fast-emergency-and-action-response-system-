@echo off
rem Stops the FEAR server (same as "Close server" in the GUI).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\fear.ps1" stop
