# Deploy isolated Priyanshu HA lab to .46 and .68 (no production touch)
$ErrorActionPreference = "Stop"
$Root = (Resolve-Path (Join-Path $PSScriptRoot "..\..\..")).Path
$Pscp = Join-Path $Root "tools\bin\pscp.exe"
$Plink = Join-Path $Root "tools\bin\plink.exe"
$Tar = Join-Path $Root "tools\pesowise-ha-lab-remote.tar.gz"
$HK46 = "SHA256:/Iwgni07JwhfNlO78ccxDeETYeVy0lvSq2/GddCtLhk"
$HK68 = "SHA256:Jx3adWa5W6WJFhIm4TbPbzCa3fxpZHML0gyd5AvZQA8"

if (-not (Test-Path $Tar)) {
  & "C:\Program Files\Git\bin\bash.exe" -c "tar -czf '$($Tar -replace '\\','/')' -C '$($Root -replace '\\','/')/tools' priyanshu-ha-lab"
}

Write-Host "Upload lab pack + deploy scripts (production NOT stopped)"
& $Pscp -batch -hostkey $HK46 -pw "ChaosInTheWake1!" $Tar "${Root}\scripts\ha\lab\deploy-lab-on-46.sh" "hasto@192.168.23.46:/tmp/"
& $Pscp -batch -hostkey $HK68 -pw "qwertyui" $Tar "${Root}\scripts\ha\lab\deploy-lab-on-68.sh" "${Root}\scripts\ha\lab\run-remote-lab-e2e-on-68.sh" "mithil@192.168.23.68:/tmp/"

& $Plink -batch -hostkey $HK46 -pw "ChaosInTheWake1!" hasto@192.168.23.46 "mkdir -p /tmp/ha; mv /tmp/deploy-lab-on-46.sh /tmp/ha/; sed -i 's/\r$//' /tmp/ha/deploy-lab-on-46.sh; bash /tmp/ha/deploy-lab-on-46.sh"
& $Plink -batch -hostkey $HK68 -pw "qwertyui" mithil@192.168.23.68 "mkdir -p /tmp/ha; mv /tmp/deploy-lab-on-68.sh /tmp/run-remote-lab-e2e-on-68.sh /tmp/ha/ 2>/dev/null; sed -i 's/\r$//' /tmp/ha/*.sh; bash /tmp/ha/deploy-lab-on-68.sh; bash /tmp/ha/run-remote-lab-e2e-on-68.sh"

Write-Host "Done. See docs/ha/PRIYANSHU_HA_REMOTE_LAB.md"
