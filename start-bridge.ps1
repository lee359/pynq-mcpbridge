$ErrorActionPreference = "Stop"

if (Test-Path ".env") {
    Get-Content ".env" | Where-Object { $_ -match '^[^#].+=' } | ForEach-Object {
        $name, $value = $_.Split('=', 2)
        Set-Item -Path "Env:$name" -Value $value
    }
}

if (-not $env:JUPYTER_TOKEN -and -not $env:JUPYTER_PASSWORD) {
    Write-Warning "Set JUPYTER_TOKEN or JUPYTER_PASSWORD in .env. This Jupyter server rejects unauthenticated notebook API requests."
}

npm start
