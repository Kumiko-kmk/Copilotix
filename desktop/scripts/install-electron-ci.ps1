$ErrorActionPreference = 'Stop'
# Finish the lazy Electron download before parallel test workers import it.
Push-Location (Split-Path -Parent $PSScriptRoot)
try {
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    & node -e "require('electron')"
    if ($LASTEXITCODE -eq 0) { exit 0 }
    if ($attempt -eq 3) { throw 'Electron runtime download failed after three attempts.' }
    Write-Warning "Electron runtime preparation failed (attempt $attempt/3); retrying download."
    Start-Sleep -Seconds (5 * $attempt)
  }
} finally {
  Pop-Location
}
