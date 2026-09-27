using System.Runtime.InteropServices;

namespace CatDesktop.Host.Native;

// DirectComposition COM interop for the cat window's visual-hosted WebView2 (copied from the verified spike).
// Only the members that are called are typed; the others are placeholders that keep the vtable layout.
// IDCompositionDesktopDevice derives from IDCompositionDevice2, which has EXACTLY 21 methods before
// CreateTargetForHwnd (there is no CreateRoundedRectangleClip): a wrong count calls the wrong slot and crashes.

[ComImport, Guid("5F4633FE-1E08-4CB8-8C75-CE24333F5602"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDCompositionDesktopDevice
{
    [PreserveSig] int Commit();
    [PreserveSig] int WaitForCommitCompletion();
    [PreserveSig] int GetFrameStatistics(IntPtr stats);
    [PreserveSig] int CreateVisual(out IDCompositionVisual2 visual);
    void _CreateSurfaceFactory(); void _CreateSurface(); void _CreateVirtualSurface(); void _CreateTranslateTransform();
    void _CreateScaleTransform(); void _CreateRotateTransform(); void _CreateSkewTransform(); void _CreateMatrixTransform();
    void _CreateTransformGroup(); void _CreateTranslateTransform3D(); void _CreateScaleTransform3D(); void _CreateRotateTransform3D();
    void _CreateMatrixTransform3D(); void _CreateTransform3DGroup(); void _CreateEffectGroup(); void _CreateRectangleClip();
    void _CreateAnimation();
    [PreserveSig] int CreateTargetForHwnd(IntPtr hwnd, [MarshalAs(UnmanagedType.Bool)] bool topmost, out IDCompositionTarget target);
}

[ComImport, Guid("eacdd04c-117e-4e17-88f4-d1b12b0e3d89"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDCompositionTarget
{
    [PreserveSig] int SetRoot(IDCompositionVisual2 visual);
}

/// <summary>Only passed around (to SetRoot and as the WebView2's RootVisualTarget); no member is called.</summary>
[ComImport, Guid("E8DE1639-4331-4B26-BC5F-6A321D347A85"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IDCompositionVisual2
{
}

internal static class DirectComposition
{
    [DllImport("dcomp.dll")]
    private static extern int DCompositionCreateDevice2(IntPtr renderingDevice, ref Guid iid,
        [MarshalAs(UnmanagedType.IUnknown)] out object device);

    /// <summary>A DirectComposition desktop device without a rendering device (WebView2 brings its own).</summary>
    public static IDCompositionDesktopDevice CreateDesktopDevice()
    {
        var iid = typeof(IDCompositionDesktopDevice).GUID;
        Marshal.ThrowExceptionForHR(DCompositionCreateDevice2(IntPtr.Zero, ref iid, out var device));
        return (IDCompositionDesktopDevice)device;
    }
}
