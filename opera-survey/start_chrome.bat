@echo off
rem Opens a separate Chrome window the scripts are allowed to read.
rem Log in to OPERA Cloud in THIS window (with MFA) and work as usual.
rem Chrome needs its own profile folder for this; your normal Chrome is not affected.
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
start "" %CHROME% --remote-debugging-port=9222 --user-data-dir="%LOCALAPPDATA%\opera-chrome" "https://mtcu9.oraclehospitality.us-ashburn-1.ocs.oraclecloud.com/ECHOICE1/operacloud/faces/opera-cloud-index/OperaCloud"
