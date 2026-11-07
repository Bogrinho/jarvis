import { spawn as defaultSpawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The text is UTF-8 base64, so it never becomes PowerShell code and Greek survives
// Windows PowerShell 5.1's command-line encoding.
export function notify({ title, body } = {}, { spawn = defaultSpawn } = {}) {
  try {
    if (process.env.JARVIS_NO_NOTIFY === '1' || (process.platform !== 'win32' && spawn === defaultSpawn)) return;
    const encode = (value, max) => Buffer.from(Array.from(String(value ?? '')).slice(0, max).join(''), 'utf8').toString('base64');
    const title64 = encode(title, 60);
    const body64 = encode(body, 180);
    // Register "Jarvis" as a notification sender (harmless to repeat). No IconUri: a path with
    // Greek letters gets garbled and Windows then silently drops the toast.
    const script = `
$k = 'HKCU:\\Software\\Classes\\AppUserModelId\\Jarvis'
if (-not (Test-Path $k)) { New-Item -Path $k -Force > $null }
Set-ItemProperty -Path $k -Name DisplayName -Value 'Jarvis'
Remove-ItemProperty -Path $k -Name IconUri -ErrorAction SilentlyContinue
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$text = $xml.GetElementsByTagName('text')
$text.Item(0).AppendChild($xml.CreateTextNode([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${title64}')))) > $null
$text.Item(1).AppendChild($xml.CreateTextNode([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${body64}')))) > $null
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('Jarvis').Show($toast)
`;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], {
      windowsHide: true, detached: true, stdio: 'ignore',
    });
    child.on('error', () => {});
    child.unref();
  } catch { /* Notifications must never interrupt the caller. */ }
}
