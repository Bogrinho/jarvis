# Jarvis setup (Windows PowerShell 5.1). Safe to run many times.
param([switch]$NonInteractive)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Step($n, $text) { Write-Host ""; Write-Host "[$n] $text" -ForegroundColor Cyan }
function Ok($text)   { Write-Host "    OK: $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    ΠΡΟΣΟΧΗ: $text" -ForegroundColor Yellow }
function Fail($text) { Write-Host "    ΣΦΑΛΜΑ: $text" -ForegroundColor Red }

Write-Host "=== Εγκατάσταση Jarvis ===" -ForegroundColor Cyan
Write-Host "Φάκελος: $root"

# 1. Node
Step 1 "Έλεγχος Node.js (χρειάζεται έκδοση 20 ή νεότερη)"
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
    Fail "Δεν βρέθηκε το Node.js. Κατεβάστε το από https://nodejs.org (έκδοση LTS), εγκαταστήστε το και τρέξτε ξανά αυτό το script."
    exit 1
}
$nodeVer = (& node --version).Trim()
$nodeMajor = [int](($nodeVer -replace '^v', '').Split('.')[0])
if ($nodeMajor -lt 20) {
    Fail "Το Node.js είναι $nodeVer. Χρειάζεται 20 ή νεότερο. Κατεβάστε νέο από https://nodejs.org"
    exit 1
}
Ok "Node.js $nodeVer"

# 2. npm install
Step 2 "Εγκατάσταση πακέτων του Jarvis (npm install)"
& npm.cmd install --no-audit --no-fund
if ($LASTEXITCODE -ne 0) {
    Fail "Το npm install απέτυχε. Αν ο φάκελος είναι στο OneDrive, δοκιμάστε να παύσετε προσωρινά τον συγχρονισμό και τρέξτε ξανά."
    exit 1
}
Ok "Τα πακέτα είναι έτοιμα"

# 3. CLIs
Step 3 "Έλεγχος των εργαλείων Codex, Claude και Gemini"
$clis = @(
    @{ Name = 'codex';  Pkg = '@openai/codex' },
    @{ Name = 'claude'; Pkg = '@anthropic-ai/claude-code' },
    @{ Name = 'gemini'; Pkg = '@google/gemini-cli' }
)
foreach ($c in $clis) {
    if (Get-Command $c.Name -ErrorAction SilentlyContinue) {
        Ok "$($c.Name) είναι ήδη εγκατεστημένο"
    } else {
        Write-Host "    Εγκατάσταση $($c.Name) ..."
        & npm.cmd install -g $c.Pkg --no-audit --no-fund
        if ($LASTEXITCODE -eq 0) { Ok "$($c.Name) εγκαταστάθηκε" }
        else { Warn "Δεν εγκαταστάθηκε το $($c.Name). Δοκιμάστε χειροκίνητα: npm install -g $($c.Pkg)" }
    }
}

# 4. Codex personal home
Step 4 "Φάκελος για τον προσωπικό λογαριασμό Codex"
$codexPersonal = Join-Path $HOME '.codex-personal'
if (-not (Test-Path -LiteralPath $codexPersonal)) {
    New-Item -ItemType Directory -Path $codexPersonal | Out-Null
    Ok "Δημιουργήθηκε: $codexPersonal"
} else {
    Ok "Υπάρχει ήδη: $codexPersonal"
}

# 5. Desktop shortcut
Step 5 "Συντόμευση «Jarvis» στην Επιφάνεια εργασίας"
try {
    $desktop = [Environment]::GetFolderPath('Desktop')
    $lnkPath = Join-Path $desktop 'Jarvis.lnk'
    # WScript.Shell stores paths in the ANSI code page, which breaks Greek folder names,
    # so the shortcut is written through the Unicode IShellLink interface instead.
    if (-not ('JarvisShortcut' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class JarvisShortcut {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, IntPtr fd, int fl);
        void GetIDList(out IntPtr p);
        void SetIDList(IntPtr p);
        void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c);
        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string d);
        void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c);
        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string d);
        void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c);
        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string a);
        void GetHotkey(out short h);
        void SetHotkey(short h);
        void GetShowCmd(out int s);
        void SetShowCmd(int s);
        void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder f, int c, out int i);
        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string f, int i);
        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string p, int r);
        void Resolve(IntPtr h, int f);
        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string p);
    }
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    class ShellLink { }
    public static void Create(string lnk, string target, string args, string workDir, string desc) {
        IShellLinkW l = (IShellLinkW)new ShellLink();
        l.SetPath(target);
        l.SetArguments(args);
        l.SetWorkingDirectory(workDir);
        l.SetDescription(desc);
        ((System.Runtime.InteropServices.ComTypes.IPersistFile)l).Save(lnk, true);
    }
}
"@
    }
    $wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $vbs = Join-Path $root 'Jarvis.vbs'
    [JarvisShortcut]::Create($lnkPath, $wscript, ('"' + $vbs + '"'), $root, 'Jarvis')
    Ok "Συντόμευση: $lnkPath"
} catch {
    Warn "Δεν δημιουργήθηκε η συντόμευση: $($_.Exception.Message)"
}

# 6. Claude status line
Step 6 "Μέτρηση χρήσης Claude (προαιρετικό)"
$settingsPath = Join-Path $HOME '.claude\settings.json'
$statusScript = Join-Path $root 'scripts\statusline.js'
$settings = $null
$hasStatus = $false
$settingsOk = $true
if (Test-Path -LiteralPath $settingsPath) {
    try {
        $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($settings -and $settings.PSObject.Properties['statusLine']) { $hasStatus = $true }
    } catch {
        $settingsOk = $false
        Warn "Δεν διαβάστηκε το $settingsPath. Δεν θα αλλάξει τίποτα."
    }
}
if (-not $settingsOk) {
    # leave settings untouched
} elseif ($hasStatus) {
    Ok "Το Claude έχει ήδη δική του status line. Δεν αλλάζω τίποτα (η χρήση θα φαίνεται σε tokens)."
} elseif ($NonInteractive) {
    Write-Host "    Παραλείπεται (-NonInteractive). Η χρήση του Claude θα φαίνεται σε tokens."
} else {
    $ans = Read-Host "    Να προστεθεί ο βοηθός που δείχνει το % χρήσης του Claude; (Y/N)"
    if ($ans -match '^[YyΝν]') {
        try {
            $dir = Split-Path -Parent $settingsPath
            if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
            if ($null -eq $settings) { $settings = New-Object PSObject }
            if (Test-Path -LiteralPath $settingsPath) {
                Copy-Item -LiteralPath $settingsPath -Destination ($settingsPath -replace 'settings\.json$', 'settings.json.bak') -Force
            }
            $statusObj = New-Object PSObject -Property @{ type = 'command'; command = ('node "' + $statusScript + '"') }
            $settings | Add-Member -NotePropertyName statusLine -NotePropertyValue $statusObj
            $json = $settings | ConvertTo-Json -Depth 32
            [System.IO.File]::WriteAllText($settingsPath, $json, (New-Object System.Text.UTF8Encoding($false)))
            Ok "Προστέθηκε στο $settingsPath (αντίγραφο ασφαλείας: settings.json.bak)"
        } catch {
            Warn "Δεν προστέθηκε: $($_.Exception.Message)"
        }
    } else {
        Write-Host "    Εντάξει, παραλείπεται."
    }
}

# 7. Codex Work status
Step 7 "Έλεγχος σύνδεσης Codex (λογαριασμός Work)"
$codexWorkOk = $false
if (Get-Command codex -ErrorAction SilentlyContinue) {
    try {
        $out = & codex login status 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0 -and $out -match 'Logged in') { $codexWorkOk = $true }
    } catch { }
}
if ($codexWorkOk) { Ok "Το Codex Work είναι ήδη συνδεδεμένο" }
else { Warn "Το Codex Work δεν φαίνεται συνδεδεμένο. Τρέξτε:  codex login" }

# Login instructions
Write-Host ""
Write-Host "=== Μία φορά: συνδέσεις (τρέξτε τις μόνοι σας, ένα-ένα) ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Codex Personal (λογαριασμός Plus):"
Write-Host '  $env:CODEX_HOME="$HOME\.codex-personal"; codex login' -ForegroundColor White
if (-not $codexWorkOk) {
    Write-Host "Codex Work:"
    Write-Host "  codex login" -ForegroundColor White
}
Write-Host "Claude:"
Write-Host "  claude    (και μετά πληκτρολογήστε /login)" -ForegroundColor White
Write-Host "Gemini (προαιρετικό):"
Write-Host "  gemini    (και επιλέξτε σύνδεση με Google)" -ForegroundColor White
Write-Host ""
Write-Host "Έτοιμο! Ανοίξτε το Jarvis με διπλό κλικ στη συντόμευση «Jarvis» της Επιφάνειας εργασίας." -ForegroundColor Green
exit 0
