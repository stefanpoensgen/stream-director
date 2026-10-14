// Plays the PCM relayed by the renderer (audio-relay.js) from this process, so the sound belongs to
// StreamDirector.exe — WebView2's own audio processes are invisible to OBS's "Capture Audio".

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

namespace StreamDirector;

internal sealed class AudioRenderer : IDisposable
{
    private const int SampleRate = 48_000;
    private const int Channels = 2;
    private const int BytesPerFrame = Channels * sizeof(short);
    private const int PrerollFrames = SampleRate / 100; // 10 ms jitter buffer before (re)starting
    private const int MaxBufferedFrames = SampleRate * 40 / 1000; // more is trimmed back to the preroll — clock drift must not pile up latency
    private const int MaxQueuedFrames = SampleRate / 10; // hard cap of the ring buffer
    private const int DeviceRetryDelayMs = 1000;
    private const int EventTimeoutMs = 200;

    private const int ShareModeShared = 0;
    private const int StreamFlagsEventCallback = 0x00040000;
    private const int StreamFlagsAutoConvertPcm = unchecked((int)0x80000000);
    private const int StreamFlagsSrcDefaultQuality = 0x08000000;
    private const int RenderDevice = 0;
    private const int MultimediaRole = 1;
    private const int ClassContextAll = 23;

    private readonly PcmQueue _queue = new(MaxQueuedFrames * BytesPerFrame);
    private readonly Thread _thread;
    private volatile bool _isStopping;

    public AudioRenderer()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "AudioRenderer", Priority = ThreadPriority.Highest };
        _thread.Start();
    }

    public void Enqueue(byte[] pcm) => _queue.Write(pcm);

    public void Dispose()
    {
        _isStopping = true;
        _thread.Join(EventTimeoutMs * 2);
    }

    /// <summary>Keeps playing on the default device; reopens it after errors (device unplugged or changed).</summary>
    private void Run()
    {
        while (!_isStopping)
        {
            try
            {
                RenderUntilDeviceFails();
            }
            catch (Exception error)
            {
                Trace.WriteLine($"Audio output failed, reopening: {error.Message}");
            }

            if (!_isStopping) Thread.Sleep(DeviceRetryDelayMs);
        }
    }

    private void RenderUntilDeviceFails()
    {
        var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        Check(enumerator.GetDefaultAudioEndpoint(RenderDevice, MultimediaRole, out var device));
        var clientIid = typeof(IAudioClient).GUID;
        Check(device.Activate(ref clientIid, ClassContextAll, IntPtr.Zero, out var clientObject));
        var client = (IAudioClient)clientObject;

        var format = new WaveFormat
        {
            FormatTag = 1,
            Channels = Channels,
            SamplesPerSec = SampleRate,
            AvgBytesPerSec = SampleRate * BytesPerFrame,
            BlockAlign = BytesPerFrame,
            BitsPerSample = 16,
        };
        var formatPointer = Marshal.AllocHGlobal(Marshal.SizeOf<WaveFormat>());

        try
        {
            Marshal.StructureToPtr(format, formatPointer, false);
            const int flags = StreamFlagsEventCallback | StreamFlagsAutoConvertPcm | StreamFlagsSrcDefaultQuality;
            Check(client.Initialize(ShareModeShared, flags, 0, 0, formatPointer, IntPtr.Zero));
        }
        finally
        {
            Marshal.FreeHGlobal(formatPointer);
        }

        using var bufferReady = new AutoResetEvent(false);
        Check(client.SetEventHandle(bufferReady.SafeWaitHandle.DangerousGetHandle()));
        Check(client.GetBufferSize(out var bufferFrames));
        var renderIid = typeof(IAudioRenderClient).GUID;
        Check(client.GetService(ref renderIid, out var renderObject));
        var render = (IAudioRenderClient)renderObject;
        Check(client.Start());

        var isPlaying = false;
        try
        {
            while (!_isStopping)
            {
                bufferReady.WaitOne(EventTimeoutMs);
                Check(client.GetCurrentPadding(out var padding));

                var freeFrames = (int)(bufferFrames - padding);
                if (freeFrames == 0) continue;

                // Wait for a small cushion before (re)starting, then play what arrived; gaps become silence
                if (!isPlaying) isPlaying = _queue.Count >= PrerollFrames * BytesPerFrame;
                if (_queue.Count > MaxBufferedFrames * BytesPerFrame) _queue.TrimTo(PrerollFrames * BytesPerFrame);

                Check(render.GetBuffer((uint)freeFrames, out var data));
                var copiedBytes = isPlaying ? _queue.Read(data, freeFrames * BytesPerFrame) : 0;
                var silent = copiedBytes == 0;
                if (copiedBytes < freeFrames * BytesPerFrame) isPlaying = false;

                const int silentFlag = 0x2;
                Check(render.ReleaseBuffer((uint)freeFrames, silent ? silentFlag : 0));
            }
        }
        finally
        {
            client.Stop();
        }
    }

    private static void Check(int result)
    {
        if (result < 0) Marshal.ThrowExceptionForHR(result);
    }

    /// <summary>Byte ring buffer; a full queue drops the oldest audio to keep the latency bounded.</summary>
    private sealed class PcmQueue(int capacity)
    {
        private readonly byte[] _buffer = new byte[capacity];
        private int _start;
        private int _count;

        public int Count
        {
            get { lock (_buffer) return _count; }
        }

        public void Write(byte[] data)
        {
            lock (_buffer)
            {
                foreach (var value in data)
                {
                    _buffer[(_start + _count) % _buffer.Length] = value;
                    if (_count < _buffer.Length) _count++;
                    else _start = (_start + 1) % _buffer.Length;
                }
            }
        }

        /// <summary>Drops the oldest bytes so that <paramref name="keepBytes"/> (whole frames) remain.</summary>
        public void TrimTo(int keepBytes)
        {
            lock (_buffer)
            {
                var dropBytes = Math.Max(0, _count - keepBytes);
                dropBytes -= dropBytes % BytesPerFrame;
                _start = (_start + dropBytes) % _buffer.Length;
                _count -= dropBytes;
            }
        }

        /// <summary>Copies up to <paramref name="maxBytes"/> (whole frames) to unmanaged memory, zero-filling the rest.</summary>
        public int Read(IntPtr destination, int maxBytes)
        {
            lock (_buffer)
            {
                var bytes = Math.Min(maxBytes, _count - _count % BytesPerFrame);
                var firstPart = Math.Min(bytes, _buffer.Length - _start);
                Marshal.Copy(_buffer, _start, destination, firstPart);
                Marshal.Copy(_buffer, 0, destination + firstPart, bytes - firstPart);
                _start = (_start + bytes) % _buffer.Length;
                _count -= bytes;

                for (var offset = bytes; offset < maxBytes; offset++) Marshal.WriteByte(destination, offset, 0);

                return bytes;
            }
        }
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    private struct WaveFormat
    {
        public ushort FormatTag;
        public ushort Channels;
        public int SamplesPerSec;
        public int AvgBytesPerSec;
        public ushort BlockAlign;
        public ushort BitsPerSample;
        public ushort ExtraSize;
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    private class MMDeviceEnumerator
    {
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int classContext, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object result);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closestMatch);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr eventHandle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("F294ACFC-3146-4483-A7BF-ADDCA7C260E2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAudioRenderClient
    {
        [PreserveSig] int GetBuffer(uint frames, out IntPtr data);
        [PreserveSig] int ReleaseBuffer(uint frames, int flags);
    }
}
