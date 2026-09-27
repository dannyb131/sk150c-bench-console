$projectDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$siteDirectory = Join-Path $projectDirectory 'dist'

Write-Host 'SK150C Bench Console'
Write-Host 'Open http://127.0.0.1:4173 in Chrome or Edge, then choose Connect PSU.'
Write-Host 'Press Ctrl+C to stop the local server.'

python -m http.server 4173 --bind 127.0.0.1 --directory $siteDirectory
