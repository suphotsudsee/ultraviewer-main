using System.Drawing.Imaging;
using System.Net.WebSockets;

namespace OwnViewAgent;

public sealed class ScreenCaptureService : IDisposable
{
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
        Stop();
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
                await _client.SendScreenFrameAsync(frame.Image, frame.Width, frame.Height, cancellationToken);
                await Task.Delay(TimeSpan.FromMilliseconds(900), cancellationToken);
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

        const int maxWidth = 1280;
        var scale = bounds.Width > maxWidth ? maxWidth / (double)bounds.Width : 1.0;
        var width = Math.Max(1, (int)(bounds.Width * scale));
        var height = Math.Max(1, (int)(bounds.Height * scale));

        using var resized = new Bitmap(width, height);
        using (var graphics = Graphics.FromImage(resized))
        {
            graphics.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            graphics.DrawImage(screenshot, 0, 0, width, height);
        }

        using var stream = new MemoryStream();
        var encoder = ImageCodecInfo.GetImageEncoders().First(codec => codec.MimeType == "image/jpeg");
        using var encoderParameters = new EncoderParameters(1);
        encoderParameters.Param[0] = new EncoderParameter(Encoder.Quality, 55L);
        resized.Save(stream, encoder, encoderParameters);

        return new ScreenFrame(
            $"data:image/jpeg;base64,{Convert.ToBase64String(stream.ToArray())}",
            width,
            height);
    }

    public void Dispose()
    {
        Stop();
    }

    private sealed record ScreenFrame(string Image, int Width, int Height);
}
