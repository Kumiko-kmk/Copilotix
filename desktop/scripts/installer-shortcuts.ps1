# Shell links may expose a DOS short path; compare the actual filesystem target.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class InstallerFilePath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
    public static string Canonical(string path) {
        IntPtr file=CreateFile(path,0,7,IntPtr.Zero,3,0,IntPtr.Zero);
        if(file==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandle(file,result,(uint)result.Capacity,0);
            if(length==0 || length>=result.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return result.ToString();
        } finally { CloseHandle(file); }
    }
}
[
    ComImport,
    Guid("000214F9-0000-0000-C000-000000000046"),
    InterfaceType(ComInterfaceType.InterfaceIsIUnknown)
]
interface IShellLinkW {
    [PreserveSig]
    int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int length, IntPtr findData, uint flags);
}
[
    ComImport,
    Guid("0000010b-0000-0000-C000-000000000046"),
    InterfaceType(ComInterfaceType.InterfaceIsIUnknown)
]
interface IPersistFile {
    [PreserveSig] int GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
}
public static class InstallerShortcut {
    static readonly Guid ShellLinkClass = new Guid("00021401-0000-0000-C000-000000000046");
    public static string GetTarget(string shortcutPath) {
        object link = Activator.CreateInstance(Type.GetTypeFromCLSID(ShellLinkClass, true));
        try {
            int loadResult = ((IPersistFile)link).Load(shortcutPath, 0);
            if (loadResult < 0) Marshal.ThrowExceptionForHR(loadResult);
            var target = new StringBuilder(32768);
            int pathResult = ((IShellLinkW)link).GetPath(target, target.Capacity, IntPtr.Zero, 0);
            if (pathResult < 0) Marshal.ThrowExceptionForHR(pathResult);
            return target.ToString();
        } finally {
            Marshal.ReleaseComObject(link);
        }
    }
}
'@
