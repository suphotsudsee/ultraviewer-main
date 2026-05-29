using System.Drawing.Imaging;
using System.Net.WebSockets;

namespace OwnViewAgent;

public sealed class ScreenCaptureService : IDisposable
{
    private const int MaxFrameWidth = 1920;
    private const int MaxJpegBytes = 2_200_000;
    private const long PreferredJpegQuality = 82L;
    private const long MinimumJpegQuality = 68L;
    private static readonly TimeSpan FrameInterval = TimeSpan.FromMilliseconds(350);

    private readonly AgentClient _client;
    private readonly ConsentForm _form;
    private CancellationTokenSource? _captureCancellation;

    public ScreenCaptureService(AgentClient client, ConsentForm form)
    {
        _client = client;
        _form = form;
    }

    public void Start(CancellationToken applicationCancellation)
    {
        if (_captureCancellation is not null)
        {
            return;
        }

        _captureCancellation = CancellationTokenSource.CreateLinkedTokenSource(applicationCancellation);
        _ = Task.Run(() => CaptureLoopAsync(_captureCancellation.Token), _captureCancellation.Token);
    }

    public void Stop()
    {
        if (_captureCancellation is null)
        {
            return;
        }

        _captureCancellation.Cancel();
        _captureCancellation.Dispose();
        _captureCancellation = null;
    }

    private async Task CaptureLoopAsync(CancellationToken cancellationToken)
    {
        _form.SetStatus("Native screen sharing is active. Use Reject / Stop to end the session.");

        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                var frame = CaptureVirtualScreen();
                await _client.SendScreenFrameAsync(
                    frame.JpegBytes,
                    frame.Width,
                    frame.Height,
                    frame.VirtualScreen,
                    frame.Monitors,
                    cancellationToken);
                await Task.Delay(FrameInterval, cancellationToken);
            }
            catch (OperationCanceledException)
            {
                return;
            }
            catch (WebSocketException ex)
            {
                _form.SetStatus($"Screen sharing stopped: {ex.Message}");
                return;
            }
            catch (Exception ex)
            {
                _form.AppendLog($"Screen frame failed: {ex.Message}");
                await Task.Delay(TimeSpan.FromSeconds(2), cancellationToken);
            }
        }
    }

    private static ScreenFrame CaptureVirtualScreen()
    {
        var bounds = SystemInformation.VirtualScreen;
        using var screenshot = new Bitmap(bounds.Width, bounds.Height);
        using (var graphics = Graphics.FromImage(screenshot))
        {
            graphics.CopyFromScreen(bounds.Location, Point.Empty, bounds.Size);
        }

        var scale = bounds.Width > MaxFrameWidth ? MaxFrameWidth / (double)bounds.Width : 1.0;
        var width = Math.Max(1, (int)(bounds.Width * scale));
        var height = Math.Max(1, (int)(bounds.Height * scale));

        var encoder = ImageCodecInfo.GetImageEncoders().First(codec => codec.MimeType == "image/jpeg");
        var jpegBytes = EncodeJpegBytes(screenshot, width, height, PreferredJpegQuality, encoder);
        if (jpegBytes.Length > MaxJpegBytes)
        {
            jpegBytes = EncodeJpegBytes(screenshot, width, height, MinimumJpegQuality, encoder);
        }

        while (jpegBytes.Length > MaxJpegBytes && width > 1280)
        {
            width = Math.Max(1280, (int)(width * 0.88));
            height = Math.Max(1, (int)(height * 0.88));
            jpegBytes = EncodeJpegBytes(screenshot, width, height, MinimumJpegQuality, encoder);
        }

        return new ScreenFrame(
            jpegBytes,
            width,
            height,
            new
            {
                x = bounds.Left,
                y = bounds.Top,
                width = bounds.Width,
                height = bounds.Height,
            },
            Screen.AllScreens.Select((screen, index) => new
            {
                id = screen.DeviceName,
                name = $"Display {index + 1}",
                x = screen.Bounds.Left,
                y = screen.Bounds.Top,
                width = screen.Bounds.Width,
                height = screen.Bounds.Height,
                primary = screen.Primary,
            }).Cast<object>().ToArray());
    }

    private static byte[] EncodeJpegBytes(Bitmap source, int width, int height, long quality, ImageCodecInfo encoder)
    {
        using var resized = new Bitmap(width, height);
        using (var graphics = Graphics.FromImage(resized))
        {
            graphics.CompositingQuality = System.Drawing.Drawing2D.CompositingQuality.HighQuality;
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;
            graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.HighQuality;
            graphics.DrawImage(source, 0, 0, width, height);
        }

        using var stream = new MemoryStream();
        using var encoderParameters = new EncoderParameters(1);
        encoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, quality);
        resized.Save(stream, encoder, encoderParameters);

        return stream.ToArray();
    }

    public void Dispose()
    {
        Stop();
    }

    private sealed record ScreenFrame(byte[] JpegBytes, int Width, int Height, object VirtualScreen, object[] Monitors);
}
