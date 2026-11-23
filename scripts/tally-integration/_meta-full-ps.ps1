$ErrorActionPreference = "Stop"
$company = "PesoWise Integration Test"
$c = [System.Security.SecurityElement]::Escape($company)

function Tally-Post([string]$Inner, [string]$Report = "All Masters") {
  $xml = @"
<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>$Report</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>$c</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>$Inner</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
"@
  return (Invoke-WebRequest -Uri http://127.0.0.1:9000 -Method POST -ContentType "text/xml;charset=utf-8" -Body $xml -TimeoutSec 90 -UseBasicParsing).Content
}

function Tally-Export([string]$CollectionId) {
  $xml = @"
<?xml version="1.0"?><ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>$CollectionId</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>$c</SVCURRENTCOMPANY><SVEXPORTFORMAT>`$`$SysName:XML</SVEXPORTFORMAT></STATICVARIABLES></DESC></BODY></ENVELOPE>
"@
  return (Invoke-WebRequest -Uri http://127.0.0.1:9000 -Method POST -ContentType "text/xml;charset=utf-8" -Body $xml -TimeoutSec 90 -UseBasicParsing).Content
}

Write-Output "=== company check ==="
$comp = Tally-Export "Company"
Write-Output ("company_ok=" + ($comp -match "PesoWise Integration Test"))

Write-Output "=== ensure voucher types ==="
foreach ($vt in @(
  @{ n = "PesoWise Expense"; p = "Payment" },
  @{ n = "PesoWise Report Meta"; p = "Journal" }
)) {
  $inner = "<TALLYMESSAGE><VOUCHERTYPE ACTION=`"Create`"><NAME>$($vt.n)</NAME><PARENT>$($vt.p)</PARENT><NUMBERINGMETHOD>Manual</NUMBERINGMETHOD></VOUCHERTYPE></TALLYMESSAGE>"
  $r = Tally-Post $inner
  Write-Output "$($vt.n): $r"
}

Write-Output "=== metadata import ==="
$token = "PW-META-PS-" + [guid]::NewGuid().ToString("N").Substring(0, 8)
$payloadObj = [ordered]@{
  schema_version = 1
  report_type    = "claim_verification"
  roundtrip_token = $token
  fields         = [ordered]@{
    ascii  = "plain ASCII"
    note   = "Unicode नोट"
    amp    = "A & B"
    lt     = "<tag>"
    gt     = ">x<"
    quotes = '"double"'
    nl     = "line1`nline2"
    nested = @{ k = "v"; n = 1 }
  }
}
$payload = ($payloadObj | ConvertTo-Json -Compress -Depth 6)
$escaped = [System.Security.SecurityElement]::Escape($payload)
$metaInner = "<TALLYMESSAGE xmlns:UDF=`"TallyUDF`"><VOUCHER ACTION=`"Create`" VCHTYPE=`"PesoWise Report Meta`"><DATE>20260406</DATE><NARRATION>Phase51 metadata $token</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE=`"String`">$escaped</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>"
$imp = Tally-Post $metaInner
Write-Output $imp
Write-Output "TOKEN=$token"
Write-Output "EXPECTED_JSON=$payload"

if ($imp -notmatch "<CREATED>1</CREATED>" -and $imp -notmatch "<ALTERED>1</ALTERED>") {
  Write-Output "IMPORT_BLOCKED"
  exit 1
}

Write-Output "=== readback export ==="
$ex = Tally-Export "VOUCHER"
$hasToken = $ex -match [regex]::Escape($token)
Write-Output "export_has_token=$hasToken export_len=$($ex.Length)"
if ($ex -match "<PESOWISE_METADATA_JSON[^>]*>([^<]*)</PESOWISE_METADATA_JSON>") {
  $raw = $Matches[1]
  $decoded = [System.Security.SecurityElement]::Unescape($raw)
  Write-Output "READBACK_JSON=$decoded"
  if ($decoded -eq $payload) { Write-Output "METADATA ROUND-TRIP PASS" ; exit 0 }
}
Write-Output "METADATA ROUND-TRIP BLOCKED"
