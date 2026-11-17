# Etsy Shop Agent — Windows VPS kurulumu (yönetici PowerShell'de bir kez çalıştırılır)
#
#   .\vps-kurulum.ps1 -ExtensionId abcdefghijklmnopabcdefghijklmnop `
#       -CommandCenter https://magaza-crm.fly.dev `
#       -ShopTag oldcitycherry -Token tok_xxx `
#       -EnrollmentToken <Chrome Enterprise Core kayıt kodu>
#
# Yaptıkları:
#   1. Chrome'u ücretsiz Chrome Enterprise Core'a kaydeder (Web Store dışı eklentiyi
#      zorunlu kurmak için Chrome'un istediği koşul).
#   2. (Zorunlu kurulum Yönetici Konsolu'ndan; burada yalnız eski yerel kaydı temizler.)
#   3. Mağazaya özel ayarları (merkez adresi, token, mağaza etiketi) politika
#      olarak yazar — eklentinin ayar sayfasına girmeye gerek kalmaz.
#   4. Arka plan sekmelerinin dakikada bire kısılmasını kapatır (ajanın çalıştığı
#      Etsy sekmesi arka planda yavaşlamasın).
param(
  [Parameter(Mandatory = $true)][string]$ExtensionId,
  [Parameter(Mandatory = $true)][string]$CommandCenter,
  [Parameter(Mandatory = $true)][string]$ShopTag,
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$EnrollmentToken = ""
)
$ErrorActionPreference = "Stop"
$CommandCenter = $CommandCenter.TrimEnd("/")
$chrome = "HKLM:\SOFTWARE\Policies\Google\Chrome"

New-Item -Path $chrome -Force | Out-Null
if ($EnrollmentToken) {
  New-Item -Path "HKLM:\SOFTWARE\Policies\Google\Chrome" -Force | Out-Null
  Set-ItemProperty -Path $chrome -Name "CloudManagementEnrollmentToken" -Value $EnrollmentToken
  Set-ItemProperty -Path $chrome -Name "CloudManagementEnrollmentMandatory" -Value 1 -Type DWord
}

# Zorunlu kurulum Google Yönetici Konsolu'ndan yapılır (Apps & extensions → ID + özel URL → Force install).
# Chrome, etki alanına bağlı olmayan Windows'ta Web Store dışı eklentiyi YEREL kayıt defteri politikasıyla
# kurmaz ("[BLOCKED]"); bulut politikasıyla kurar. Eski sürümün yazdığı yerel kaydı temizle.
Remove-Item -Path "$chrome\ExtensionInstallForcelist" -Recurse -ErrorAction SilentlyContinue
Remove-Item -Path "$chrome\ExtensionInstallSources" -Recurse -ErrorAction SilentlyContinue

# Mağazaya özel ayarlar (chrome.storage.managed)
$ext = "$chrome\3rdparty\extensions\$ExtensionId\policy"
New-Item -Path $ext -Force | Out-Null
Set-ItemProperty -Path $ext -Name "apiHost" -Value $CommandCenter
Set-ItemProperty -Path $ext -Name "apiToken" -Value $Token
Set-ItemProperty -Path $ext -Name "shopTag" -Value $ShopTag
Set-ItemProperty -Path $ext -Name "vpsHost" -Value $env:COMPUTERNAME
Set-ItemProperty -Path $ext -Name "forwardEnabled" -Value 1 -Type DWord
Set-ItemProperty -Path $ext -Name "agentEnabled" -Value 1 -Type DWord

# Arka plan sekmesi kısıtlamasını kapat
Set-ItemProperty -Path $chrome -Name "IntensiveWakeUpThrottlingEnabled" -Value 0 -Type DWord

Write-Host "Tamam. Chrome'u tamamen kapatıp açın, sonra chrome://policy sayfasında 'Politikaları yeniden yükle'ye basın."
Write-Host "Kontrol: chrome://extensions → 'Etsy Shop Agent' görünmeli; ayrıntılarda 'Kullanıcı komut dosyalarına izin ver' açılırsa uzaktan mantık güncellemeleri de aktif olur."
