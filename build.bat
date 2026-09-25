@echo off
REM Build single-file portable exe (PrintShare <version>.exe)
REM Use npmmirror for builder binaries and keep build cache inside project.
setlocal
set "ROOT=%~dp0"
set "ELECTRON_BUILDER_CACHE=%ROOT%.buildcache"
set "electron_config_cache=%ROOT%.buildcache"
set "ELECTRON_CACHE=%ROOT%.buildcache\electron"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
set "ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/"

echo [1/2] Generate icon...
node "%ROOT%node_modules\make-icon.js" 2>nul || node "%ROOT%make-icon.js"

echo [2/2] Start packaging -> dist\PrintShare *.exe ...
node "%ROOT%node_modules\electron-builder\cli.js" --win portable %*

echo Done. Exit code: %ERRORLEVEL%
endlocal