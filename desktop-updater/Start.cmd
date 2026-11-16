@echo off
setlocal
set PYTHONDONTWRITEBYTECODE=1
where py >nul 2>nul
if not errorlevel 1 (
    py -3 "%~dp0app.py" %*
    if errorlevel 1 pause
    exit /b
)
where python >nul 2>nul
if not errorlevel 1 (
    python "%~dp0app.py" %*
    if errorlevel 1 pause
    exit /b
)
echo Python 3.10 or newer is required. Install Python with Tcl/Tk support.
pause
