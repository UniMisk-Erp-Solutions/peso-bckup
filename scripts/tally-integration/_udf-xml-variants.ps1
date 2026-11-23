$company = "PesoWise Integration Test"
$c = [System.Security.SecurityElement]::Escape($company)
$json = '{"schema_version":1,"test":true}'
$esc = [System.Security.SecurityElement]::Escape($json)

$variants = @{
  "udf_ns" = "<TALLYMESSAGE xmlns:UDF=`"TallyUDF`"><VOUCHER ACTION=`"Create`" VCHTYPE=`"PesoWise Report Meta`"><DATE>20260406</DATE><NARRATION>v1</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE=`"String`">$esc</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>"
  "plain" = "<TALLYMESSAGE><VOUCHER ACTION=`"Create`" VCHTYPE=`"PesoWise Report Meta`"><DATE>20260406</DATE><NARRATION>v2</NARRATION><PESOWISE_METADATA_JSON>$esc</PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>"
  "list" = "<TALLYMESSAGE xmlns:UDF=`"TallyUDF`"><VOUCHER ACTION=`"Create`" VCHTYPE=`"PesoWise Report Meta`"><DATE>20260406</DATE><NARRATION>v3</NARRATION><PESOWISE_METADATA_JSON.LIST><PESOWISE_METADATA_JSON>$esc</PESOWISE_METADATA_JSON></PESOWISE_METADATA_JSON.LIST></VOUCHER></TALLYMESSAGE>"
}

foreach ($k in $variants.Keys) {
  $inner = $variants[$k]
  $xml = @"
<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>$c</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>$inner</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
"@
  try {
    $r = (Invoke-WebRequest -Uri http://127.0.0.1:9000 -Method POST -ContentType "text/xml" -Body $xml -TimeoutSec 30 -UseBasicParsing).Content -replace "\s+"," "
    Write-Output "$k $r"
  } catch {
    Write-Output "$k ERROR $($_.Exception.Message)"
  }
}
