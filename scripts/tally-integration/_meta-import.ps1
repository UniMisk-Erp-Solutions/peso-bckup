$company = "PesoWise Integration Test"
$c = [System.Security.SecurityElement]::Escape($company)
$token = "PW-META-PS-" + [guid]::NewGuid().ToString("N").Substring(0,8)
$payload = @{
  schema_version = 1
  report_type = "claim_verification"
  roundtrip_token = $token
  fields = @{
    ascii = "plain ASCII"
    note = "Unicode नोट"
    amp = "A & B"
    lt = "<tag>"
    gt = ">x<"
    quotes = '"double"'
    nl = "line1`nline2"
    nested = @{ k = "v" }
  }
} | ConvertTo-Json -Compress -Depth 5
$escaped = [System.Security.SecurityElement]::Escape($payload)
$inner = @"
<TALLYMESSAGE xmlns:UDF="TallyUDF"><VOUCHER ACTION="Create" VCHTYPE="PesoWise Report Meta"><DATE>20260406</DATE><NARRATION>Phase51 metadata $token</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE="String">$escaped</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>
"@
$xml = @"
<?xml version="1.0" encoding="UTF-8"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>$c</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>$inner</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
"@
$r = Invoke-WebRequest -Uri http://127.0.0.1:9000 -Method POST -ContentType "text/xml;charset=utf-8" -Body $xml -TimeoutSec 90 -UseBasicParsing
Write-Output $r.Content
Write-Output "TOKEN=$token"
