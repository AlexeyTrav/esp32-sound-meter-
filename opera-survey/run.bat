@echo off
rem Step 1 + Step 2 in one go. Open "Export Details" in OPERA first.
cd /d "%~dp0"
python extract_emails.py || goto :end
echo.
python send_survey.py
echo.
set /p GO=Send the survey to these guests now? (yes/no): 
if /i "%GO%"=="yes" python send_survey.py --send --yes
:end
pause
