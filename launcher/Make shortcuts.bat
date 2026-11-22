@echo off
rem Puts "Start FEAR" and "Stop FEAR" on the desktop and a FEAR folder in the Start menu.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0fear.ps1" shortcuts
