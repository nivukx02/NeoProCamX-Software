using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;

namespace CamX
{
    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        [PreserveSig]
        int BindToHandler(
            IntPtr bindContext,
            ref Guid handlerId,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out object value);

        [PreserveSig]
        int GetParent(out IShellItem parent);

        [PreserveSig]
        int GetDisplayName(uint displayNameType, out IntPtr name);

        [PreserveSig]
        int GetAttributes(uint mask, out uint attributes);

        [PreserveSig]
        int Compare(IShellItem other, uint hint, out int order);
    }

    public sealed class MtpCopyResult
    {
        public long Bytes { get; internal set; }
        public long ResumedBytes { get; internal set; }
        public double BytesPerSecond { get; internal set; }
        public string Sha256 { get; internal set; }
    }

    /// <summary>
    /// Reads a Windows Shell item through BHID_Stream instead of routing a large
    /// phone file through Explorer's asynchronous CopyHere broker. This keeps one
    /// bounded transfer buffer, exposes exact progress and permits safe prefix
    /// resume when the phone's MTP stream supports seeking.
    /// </summary>
    public static class MtpStreamCopy
    {
        private const uint SigDnDesktopAbsoluteParsing = 0x80028000;
        private static readonly Guid ShellItemId = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        private static readonly Guid StreamHandlerId = new Guid("1CEBB3AB-7C10-499A-A417-92CA16C4CB83");
        private static readonly Guid StreamInterfaceId = new Guid("0000000C-0000-0000-C000-000000000046");

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindContext,
            ref Guid interfaceId,
            out IShellItem shellItem);

        public static string GetDesktopAbsoluteParsingName(string parsingName)
        {
            IShellItem item = OpenShellItem(parsingName);
            IntPtr value = IntPtr.Zero;
            try
            {
                int result = item.GetDisplayName(SigDnDesktopAbsoluteParsing, out value);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                return Marshal.PtrToStringUni(value) ?? parsingName;
            }
            finally
            {
                if (value != IntPtr.Zero) Marshal.FreeCoTaskMem(value);
                if (Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item);
            }
        }

        public static MtpCopyResult Copy(
            string parsingName,
            string destinationPath,
            long expectedBytes,
            long requestedResumeOffset,
            int bufferBytes,
            Action<long, long, double> progress)
        {
            if (String.IsNullOrWhiteSpace(parsingName))
                throw new NotSupportedException("CAMX_MTP_STREAM_UNAVAILABLE: the phone item has no Shell parsing path");
            if (String.IsNullOrWhiteSpace(destinationPath))
                throw new ArgumentException("A destination path is required", "destinationPath");
            if (expectedBytes < 0)
                throw new ArgumentOutOfRangeException("expectedBytes");

            bufferBytes = Math.Max(256 * 1024, Math.Min(bufferBytes, 16 * 1024 * 1024));
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(destinationPath)));

            object streamObject = null;
            IStream source = null;
            IShellItem item = null;
            SHA256 hash = null;
            FileStream destination = null;
            IntPtr readCountPointer = IntPtr.Zero;
            long resumeOffset = 0;
            var timer = Stopwatch.StartNew();

            try
            {
                item = OpenShellItem(parsingName);
                Guid streamHandlerId = StreamHandlerId;
                Guid streamInterfaceId = StreamInterfaceId;
                int bindResult = item.BindToHandler(
                    IntPtr.Zero,
                    ref streamHandlerId,
                    ref streamInterfaceId,
                    out streamObject);
                if (bindResult < 0 || streamObject == null)
                    throw new NotSupportedException(
                        "CAMX_MTP_STREAM_UNAVAILABLE: the phone driver did not expose a readable stream",
                        Marshal.GetExceptionForHR(bindResult));

                source = streamObject as IStream;
                if (source == null)
                    throw new NotSupportedException("CAMX_MTP_STREAM_UNAVAILABLE: the Shell stream interface is incompatible");

                destination = new FileStream(
                    destinationPath,
                    FileMode.OpenOrCreate,
                    FileAccess.ReadWrite,
                    FileShare.Read,
                    bufferBytes,
                    FileOptions.SequentialScan);
                hash = SHA256.Create();
                resumeOffset = Math.Max(0, Math.Min(requestedResumeOffset, destination.Length));
                if (expectedBytes > 0) resumeOffset = Math.Min(resumeOffset, expectedBytes);

                if (resumeOffset > 0)
                {
                    try
                    {
                        source.Seek(resumeOffset, 0, IntPtr.Zero);
                    }
                    catch (Exception error)
                    {
                        if (error is COMException || error is NotImplementedException)
                        {
                            resumeOffset = 0;
                        }
                        else
                        {
                            throw;
                        }
                    }
                }

                destination.SetLength(resumeOffset);
                destination.Position = 0;
                byte[] buffer = new byte[bufferBytes];
                long prefixRemaining = resumeOffset;
                while (prefixRemaining > 0)
                {
                    int wanted = (int)Math.Min(buffer.Length, prefixRemaining);
                    int read = destination.Read(buffer, 0, wanted);
                    if (read <= 0) throw new EndOfStreamException("The resumable MTP prefix is truncated");
                    hash.TransformBlock(buffer, 0, read, null, 0);
                    prefixRemaining -= read;
                }
                destination.Position = resumeOffset;

                readCountPointer = Marshal.AllocCoTaskMem(sizeof(int));
                long copied = resumeOffset;
                long lastReportedTicks = 0;
                while (expectedBytes == 0 || copied < expectedBytes)
                {
                    int wanted = expectedBytes > 0
                        ? (int)Math.Min(buffer.Length, expectedBytes - copied)
                        : buffer.Length;
                    Marshal.WriteInt32(readCountPointer, 0);
                    source.Read(buffer, wanted, readCountPointer);
                    int read = Marshal.ReadInt32(readCountPointer);
                    if (read <= 0) break;
                    destination.Write(buffer, 0, read);
                    hash.TransformBlock(buffer, 0, read, null, 0);
                    copied += read;

                    long elapsedTicks = timer.ElapsedTicks;
                    if (elapsedTicks - lastReportedTicks >= Stopwatch.Frequency / 4)
                    {
                        double seconds = Math.Max(0.001, timer.Elapsed.TotalSeconds);
                        if (progress != null)
                            progress.Invoke(copied, expectedBytes, (copied - resumeOffset) / seconds);
                        lastReportedTicks = elapsedTicks;
                    }
                }

                if (expectedBytes > 0 && copied != expectedBytes)
                    throw new EndOfStreamException(
                        String.Format("MTP stream ended at {0} of {1} bytes", copied, expectedBytes));

                destination.Flush(true);
                hash.TransformFinalBlock(new byte[0], 0, 0);
                double elapsed = Math.Max(0.001, timer.Elapsed.TotalSeconds);
                if (progress != null)
                    progress.Invoke(copied, expectedBytes, (copied - resumeOffset) / elapsed);
                return new MtpCopyResult
                {
                    Bytes = copied,
                    ResumedBytes = resumeOffset,
                    BytesPerSecond = (copied - resumeOffset) / elapsed,
                    Sha256 = BitConverter.ToString(hash.Hash).Replace("-", "").ToLowerInvariant()
                };
            }
            finally
            {
                if (readCountPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(readCountPointer);
                if (destination != null) destination.Dispose();
                if (hash != null) hash.Dispose();
                if (source != null && Marshal.IsComObject(source)) Marshal.FinalReleaseComObject(source);
                else if (streamObject != null && Marshal.IsComObject(streamObject)) Marshal.FinalReleaseComObject(streamObject);
                if (item != null && Marshal.IsComObject(item)) Marshal.FinalReleaseComObject(item);
            }
        }

        private static IShellItem OpenShellItem(string parsingName)
        {
            IShellItem item;
            Guid shellItemId = ShellItemId;
            int result = SHCreateItemFromParsingName(parsingName, IntPtr.Zero, ref shellItemId, out item);
            if (result < 0 || item == null)
                throw new NotSupportedException(
                    "CAMX_MTP_STREAM_UNAVAILABLE: Windows could not bind the phone item",
                    Marshal.GetExceptionForHR(result));
            return item;
        }
    }
}
