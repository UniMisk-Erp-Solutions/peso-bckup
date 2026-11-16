$company = "PesoWise Integration Test"
$c = [System.Security.SecurityElement]::Escape($company)
$inner = "<TALLYMESSAGE xmlns:UDF=`"TallyUDF`"><VOUCHER ACTION=`"Create`" VCHTYPE=`"Journal`"><DATE>20260406</DATE><NARRATION>reportname test</NARRATION></VOUCHER></TALLYMESSAGE>"
foreach ($report in @("All Masters", "Voucher", "All Vouchers")) {
  $xml = @"
<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>$report</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>$c</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>$inner</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
"@
  $r = (Invoke-WebRequest -Uri http://127.0.0.1:9000 -Method POST -ContentType "text/xml" -Body $xml -TimeoutSec 90 -UseBasicParsing).Content -replace "\s+"," "
  Write-Output "$report -> $r"
}
