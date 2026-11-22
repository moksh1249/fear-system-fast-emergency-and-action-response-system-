@echo off
rem Starts the FEAR server and opens it. Double-click me, or use the "Start FEAR" desktop icon.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\fear.ps1" start
