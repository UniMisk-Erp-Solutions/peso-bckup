$company = "PesoWise Integration Test"
$c = [System.Security.SecurityElement]::Escape($company)
$json = '{"schema_version":1,"probe":"journal_udf"}'
$esc = [System.Security.SecurityElement]::Escape($json)
$inner = "<TALLYMESSAGE xmlns:UDF=`"TallyUDF`"><VOUCHER ACTION=`"Create`" VCHTYPE=`"Journal`"><DATE>20260406</DATE><NARRATION>udf probe journal</NARRATION><UDF:PESOWISE_METADATA_JSON TYPE=`"String`">$esc</UDF:PESOWISE_METADATA_JSON></VOUCHER></TALLYMESSAGE>"
$xml = @"
<?xml version="1.0"?><ENVELOPE><HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER><BODY><IMPORTDATA><REQUESTDESC><REPORTNAME>All Masters</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>$c</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC><REQUESTDATA>$inner</REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>
"@
(Invoke-WebRequest -Uri http://127.0.0.1:9000 -Method POST -ContentType "text/xml" -Body $xml -TimeoutSec 90 -UseBasicParsing).Content
