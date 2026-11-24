# Replaces the icon of a Windows .exe with an .ico file, using the Win32 resource API (no downloads).
param(
  [Parameter(Mandatory = $true)][string]$Exe,
  [Parameter(Mandatory = $true)][string]$Ico
)
$ErrorActionPreference = 'Stop'
$Exe = (Resolve-Path $Exe).Path
$Ico = (Resolve-Path $Ico).Path

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;

public static class PandaIcon {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr LoadLibraryEx(string f, IntPtr h, uint flags);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool FreeLibrary(IntPtr h);
  delegate bool EnumNameProc(IntPtr h, IntPtr type, IntPtr name, IntPtr p);
  delegate bool EnumLangProc(IntPtr h, IntPtr type, IntPtr name, ushort lang, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EnumResourceNames(IntPtr h, IntPtr type, EnumNameProc cb, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EnumResourceLanguages(IntPtr h, IntPtr type, IntPtr name, EnumLangProc cb, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr BeginUpdateResource(string f, bool del);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateResource(IntPtr h, IntPtr type, IntPtr name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool UpdateResource(IntPtr h, IntPtr type, string name, ushort lang, byte[] data, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool EndUpdateResource(IntPtr h, bool discard);

  const int RT_ICON = 3, RT_GROUP_ICON = 14;

  class Res { public object Name; public ushort Lang; }

  static object NameOf(IntPtr n) { long v = n.ToInt64(); return (v >> 16) == 0 ? (object)(int)v : Marshal.PtrToStringUni(n); }

  static List<Res> List(IntPtr mod, int type) {
    var result = new List<Res>();
    var names = new List<IntPtr>();
    EnumResourceNames(mod, (IntPtr)type, (h, t, n, p) => {
      object nm = NameOf(n);
      EnumResourceLanguages(h, t, n, (h2, t2, n2, lang, p2) => { result.Add(new Res { Name = nm, Lang = lang }); return true; }, IntPtr.Zero);
      return true;
    }, IntPtr.Zero);
    return result;
  }

  static bool Update(IntPtr h, int type, object name, ushort lang, byte[] data) {
    uint size = data == null ? 0u : (uint)data.Length;
    if (name is int) return UpdateResource(h, (IntPtr)type, (IntPtr)(int)name, lang, data, size);
    return UpdateResource(h, (IntPtr)type, (string)name, lang, data, size);
  }

  public static string Apply(string exe, string ico) {
    byte[] icoBytes = File.ReadAllBytes(ico);
    int count = BitConverter.ToUInt16(icoBytes, 4);

    IntPtr mod = LoadLibraryEx(exe, IntPtr.Zero, 0x2); // LOAD_LIBRARY_AS_DATAFILE
    if (mod == IntPtr.Zero) throw new Exception("Cannot open exe: " + Marshal.GetLastWin32Error());
    List<Res> groups, icons;
    try { groups = List(mod, RT_GROUP_ICON); icons = List(mod, RT_ICON); }
    finally { FreeLibrary(mod); }

    object groupName = groups.Count > 0 ? groups[0].Name : (object)1;
    ushort lang = groups.Count > 0 ? groups[0].Lang : (ushort)1033;

    IntPtr h = BeginUpdateResource(exe, false);
    if (h == IntPtr.Zero) throw new Exception("BeginUpdateResource failed: " + Marshal.GetLastWin32Error());
    try {
      foreach (var g in groups) Update(h, RT_GROUP_ICON, g.Name, g.Lang, null);
      foreach (var i in icons) Update(h, RT_ICON, i.Name, i.Lang, null);

      var grp = new MemoryStream();
      var w = new BinaryWriter(grp);
      w.Write((ushort)0); w.Write((ushort)1); w.Write((ushort)count);
      for (int i = 0; i < count; i++) {
        int e = 6 + i * 16;
        int bytes = BitConverter.ToInt32(icoBytes, e + 8);
        int offset = BitConverter.ToInt32(icoBytes, e + 12);
        byte[] img = new byte[bytes];
        Array.Copy(icoBytes, offset, img, 0, bytes);
        ushort id = (ushort)(i + 1);
        if (!Update(h, RT_ICON, (int)id, lang, img)) throw new Exception("UpdateResource(icon) failed: " + Marshal.GetLastWin32Error());
        w.Write(icoBytes[e]); w.Write(icoBytes[e + 1]); w.Write(icoBytes[e + 2]); w.Write(icoBytes[e + 3]);
        w.Write(BitConverter.ToUInt16(icoBytes, e + 4)); w.Write(BitConverter.ToUInt16(icoBytes, e + 6));
        w.Write(bytes); w.Write(id);
      }
      if (!Update(h, RT_GROUP_ICON, groupName, lang, grp.ToArray())) throw new Exception("UpdateResource(group) failed: " + Marshal.GetLastWin32Error());
    } catch { EndUpdateResource(h, true); throw; }
    if (!EndUpdateResource(h, false)) throw new Exception("EndUpdateResource failed: " + Marshal.GetLastWin32Error());
    return "Replaced " + groups.Count + " icon group(s) / " + icons.Count + " icon(s) with " + count + " panda images (group " + groupName + ", lang " + lang + ")";
  }
}
'@

[PandaIcon]::Apply($Exe, $Ico)
