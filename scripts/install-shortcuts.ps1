param(
    [switch]$AutoStart,
    [switch]$NoAutoStart
)

$ErrorActionPreference = 'Stop'
if ($AutoStart -and $NoAutoStart) {
    throw 'Επιλέξτε μόνο μία από τις παραμέτρους -AutoStart και -NoAutoStart.'
}

$root = Split-Path -Parent $PSScriptRoot
# Use the short (8.3) path: shortcuts can lose the Greek letters in "Έγγραφα".
try { $root = (New-Object -ComObject Scripting.FileSystemObject).GetFolder($root).ShortPath } catch { }
$shell = New-Object -ComObject WScript.Shell

function New-JarvisShortcut($folder) {
    $shortcut = $shell.CreateShortcut((Join-Path $folder 'Jarvis.lnk'))
    $shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
    $shortcut.Arguments = '"' + (Join-Path $root 'Jarvis.vbs') + '"'
    $shortcut.WorkingDirectory = $root
    $shortcut.IconLocation = (Join-Path $root 'public\jarvis.ico') + ',0'
    $shortcut.Description = 'Jarvis'
    $shortcut.Save()
    Write-Host "OK: Δημιουργήθηκε η συντόμευση στον φάκελο $folder" -ForegroundColor Green
}

New-JarvisShortcut ([Environment]::GetFolderPath('Desktop'))
New-JarvisShortcut ([Environment]::GetFolderPath('Programs'))

try {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;

public static class JarvisShortcutAppId
{
    [ComImport, Guid("00021401-0000-0000-C000-000000000046")]
    private class ShellLink { }

    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }

    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public uint PropertyId;
    }

    [StructLayout(LayoutKind.Explicit, Size = 24)]
    private struct PropVariant
    {
        [FieldOffset(0)] public ushort VariantType;
        [FieldOffset(8)] public IntPtr Pointer;
    }

    [DllImport("ole32.dll")]
    private static extern int PropVariantClear(ref PropVariant value);

    private static PropertyKey AppIdKey()
    {
        return new PropertyKey { FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), PropertyId = 5 };
    }

    public static void Set(string path, string appId)
    {
        object link = new ShellLink();
        try
        {
            IPersistFile file = (IPersistFile)link;
            file.Load(path, 2); // STGM_READWRITE
            IPropertyStore store = (IPropertyStore)link;
            PropertyKey key = AppIdKey();
            PropVariant value = new PropVariant();
            try
            {
                value.VariantType = 31; // VT_LPWSTR
                value.Pointer = Marshal.StringToCoTaskMemUni(appId);
                store.SetValue(ref key, ref value);
                store.Commit();
                file.Save(path, true);
            }
            finally { PropVariantClear(ref value); }
        }
        finally { Marshal.FinalReleaseComObject(link); }
    }

    public static string Get(string path)
    {
        object link = new ShellLink();
        try
        {
            ((IPersistFile)link).Load(path, 0); // STGM_READ
            IPropertyStore store = (IPropertyStore)link;
            PropertyKey key = AppIdKey();
            PropVariant value = new PropVariant();
            try
            {
                store.GetValue(ref key, out value);
                return value.VariantType == 31 ? Marshal.PtrToStringUni(value.Pointer) : null;
            }
            finally { PropVariantClear(ref value); }
        }
        finally { Marshal.FinalReleaseComObject(link); }
    }
}
'@
    $startShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Jarvis.lnk'
    [JarvisShortcutAppId]::Set($startShortcut, 'Jarvis')
    $appId = [JarvisShortcutAppId]::Get($startShortcut)
    if ($appId -ne 'Jarvis') { throw 'Η τιμή AppUserModel ID δεν επαληθεύτηκε.' }
    Write-Host "OK: Το AppUserModel ID της συντόμευσης είναι $appId" -ForegroundColor Green
} catch {
    Write-Warning "Δεν ήταν δυνατή η ρύθμιση του AppUserModel ID: $_"
}

if (-not $AutoStart -and -not $NoAutoStart) {
    do {
        $answer = (Read-Host 'Να ξεκινά το Jarvis αυτόματα με τα Windows; (Ν = Ναι / Ο = Όχι)').Trim().ToUpperInvariant()
    } until ($answer -in @('Ν', 'N', 'Y', 'Ο', 'O'))
    # Greek or Latin N means "Ναι"; Greek or Latin O means "Όχι".
    $AutoStart = $answer -in @('Ν', 'N', 'Y')
}

$startup = [Environment]::GetFolderPath('Startup')
if ($AutoStart) {
    New-JarvisShortcut $startup
} else {
    $startupShortcut = Join-Path $startup 'Jarvis.lnk'
    if (Test-Path -LiteralPath $startupShortcut) {
        Remove-Item -LiteralPath $startupShortcut
    }
    Write-Host 'OK: Η αυτόματη εκκίνηση είναι απενεργοποιημένη.' -ForegroundColor Green
}

Write-Host ''
Write-Host 'Έτοιμο! Το Jarvis είναι στην επιφάνεια εργασίας και στο μενού Έναρξη.' -ForegroundColor Cyan
Read-Host 'Πάτα Enter για να κλείσει το παράθυρο' | Out-Null
