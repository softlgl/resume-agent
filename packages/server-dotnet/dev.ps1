# .NET server 开发启动脚本：加载根目录 .env 环境变量后 dotnet run
# 等价 Node 版的 --env-file=../../.env
$ErrorActionPreference = 'Continue'

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$envFile = Join-Path $repoRoot '.env'
if (Test-Path $envFile)
{
    Get-Content $envFile -Encoding UTF8 | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$')
        {
            [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'))
        }
    }
}
else
{
    Write-Warning "未找到 $envFile"
}

Set-Location (Join-Path $PSScriptRoot 'ResumeAgent.Api')
# --no-launch-profile：不读 launchSettings.json，端口统一由 PORT 环境变量控制（默认 4000）
dotnet run --no-launch-profile
