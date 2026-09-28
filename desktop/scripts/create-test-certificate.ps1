param(
  [string]$OutputDirectory = (Join-Path $env:LOCALAPPDATA 'Copilotix\Signing'),
  [string]$Subject = 'CN=Copilotix Development (Self-Signed Test Only)'
)
$ErrorActionPreference = 'Stop'
# Deliberately do not install into Trusted Root or Trusted Publishers.
# Private key stays non-exportable in this Windows user's certificate store.
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$certificate = New-SelfSignedCertificate -Type CodeSigningCert -Subject $Subject `
  -FriendlyName 'Copilotix development signing - NOT for public releases' `
  -CertStoreLocation 'Cert:\CurrentUser\My' -KeyAlgorithm RSA -KeyLength 3072 `
  -HashAlgorithm SHA256 -KeyExportPolicy NonExportable -NotAfter (Get-Date).AddYears(1)
$publicPath = Join-Path $OutputDirectory ($certificate.Thumbprint + '.cer')
Export-Certificate -Cert $certificate -FilePath $publicPath | Out-Null
$probePath = Join-Path $OutputDirectory ($certificate.Thumbprint + '-probe.ps1')
[IO.File]::WriteAllText($probePath, "Write-Output 'Copilotix signing verification probe'`r`n", [Text.Encoding]::ASCII)
$signature = Set-AuthenticodeSignature -LiteralPath $probePath -Certificate $certificate -HashAlgorithm SHA256
if ($signature.SignerCertificate.Thumbprint -ne $certificate.Thumbprint) {
  throw 'Signing probe did not contain the expected certificate.'
}
$metadata = [ordered]@{
  purpose = 'LOCAL TEST ONLY - not publicly trusted'
  subject = $certificate.Subject
  thumbprint = $certificate.Thumbprint
  expires = $certificate.NotAfter.ToUniversalTime().ToString('o')
  store = 'Cert:\CurrentUser\My'
  publicCertificate = $publicPath
  probe = $probePath
  probeStatus = [string]$signature.Status
  privateKeyExportable = $false
  trustedRootInstalled = $false
}
$metadata | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $OutputDirectory 'development-certificate.json') -Encoding UTF8
$metadata | ConvertTo-Json
