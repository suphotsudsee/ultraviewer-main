using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace OwnViewAgent;

public sealed class AgentClient : IDisposable
{
    private readonly AgentSettings _settings;
    private readonly ClientWebSocket _socket = new();
    private readonly SemaphoreSlim _sendLock = new(1, 1);

    public AgentClient(AgentSettings settings)
    {
        _settings = settings;
    }

    public event Action<string>? StatusChanged;
    public event Action<string>? MessageReceived;

    public async Task ConnectAsync(CancellationToken cancellationToken)
    {
        var baseUri = new Uri(_settings.ServerUrl);
        var scheme = baseUri.Scheme == "https" ? "wss" : "ws";
        var builder = new UriBuilder(baseUri)
        {
            Scheme = scheme,
            Path = "/ws",
            Query = BuildQuery(),
        };

        StatusChanged?.Invoke("Connecting to OwnView server...");
        await _socket.ConnectAsync(builder.Uri, cancellationToken);
        StatusChanged?.Invoke("Connected. Waiting for approved support request.");

        await SendAsync(new
        {
            type = "agent.hello",
            name = _settings.AgentName,
            requireVisibleApproval = _settings.RequireVisibleApproval,
            allowRemoteInput = _settings.AllowRemoteInput,
        }, cancellationToken);

        _ = Task.Run(() => ReceiveLoopAsync(cancellationToken), cancellationToken);
        _ = Task.Run(() => HeartbeatLoopAsync(cancellationToken), cancellationToken);
    }

    private async Task HeartbeatLoopAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested && _socket.State == WebSocketState.Open)
        {
            await SendAsync(new
            {
                type = "agent.heartbeat",
                at = DateTimeOffset.UtcNow,
            }, cancellationToken);
            await Task.Delay(TimeSpan.FromSeconds(15), cancellationToken);
        }
    }

    private async Task ReceiveLoopAsync(CancellationToken cancellationToken)
    {
        var buffer = new byte[8192];
        while (!cancellationToken.IsCancellationRequested && _socket.State == WebSocketState.Open)
        {
            using var messageBuffer = new MemoryStream();
            WebSocketReceiveResult result;
            do
            {
                result = await _socket.ReceiveAsync(buffer, cancellationToken);
                if (result.MessageType == WebSocketMessageType.Close)
                {
                    StatusChanged?.Invoke("Disconnected from server.");
                    return;
                }

                messageBuffer.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);

            if (result.MessageType == WebSocketMessageType.Close)
            {
                StatusChanged?.Invoke("Disconnected from server.");
                return;
            }

            var message = Encoding.UTF8.GetString(messageBuffer.ToArray());
            MessageReceived?.Invoke(message);
        }
    }

    public Task ApproveAsync(CancellationToken cancellationToken)
    {
        return SendAsync(new { type = "agent.approve" }, cancellationToken);
    }

    public Task RejectAsync(CancellationToken cancellationToken)
    {
        return SendAsync(new { type = "agent.reject" }, cancellationToken);
    }

    public Task SendScreenFrameAsync(
        byte[] jpegBytes,
        int width,
        int height,
        object virtualScreen,
        object[] monitors,
        CancellationToken cancellationToken)
    {
        var metadataJson = JsonSerializer.Serialize(new
        {
            type = "agent.screen.frame",
            width,
            height,
            virtualScreen,
            monitors,
            capturedAt = DateTimeOffset.UtcNow,
            encoding = "jpeg",
        });
        var metadataBytes = Encoding.UTF8.GetBytes(metadataJson);
        var payload = new byte[sizeof(int) + metadataBytes.Length + jpegBytes.Length];
        BitConverter.GetBytes(metadataBytes.Length).CopyTo(payload, 0);
        metadataBytes.CopyTo(payload, sizeof(int));
        jpegBytes.CopyTo(payload, sizeof(int) + metadataBytes.Length);

        return SendBinaryAsync(payload, cancellationToken);
    }

    private string BuildQuery()
    {
        var query = $"agent=1&name={Uri.EscapeDataString(_settings.AgentName)}";
        if (!string.IsNullOrWhiteSpace(_settings.AgentKey))
        {
            query += $"&agentKey={Uri.EscapeDataString(_settings.AgentKey)}";
        }

        return query;
    }

    private async Task SendAsync(object payload, CancellationToken cancellationToken)
    {
        var json = JsonSerializer.Serialize(payload);
        var bytes = Encoding.UTF8.GetBytes(json);
        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            await _socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancellationToken);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    private async Task SendBinaryAsync(byte[] payload, CancellationToken cancellationToken)
    {
        await _sendLock.WaitAsync(cancellationToken);
        try
        {
            await _socket.SendAsync(payload, WebSocketMessageType.Binary, true, cancellationToken);
        }
        finally
        {
            _sendLock.Release();
        }
    }

    public void Dispose()
    {
        _sendLock.Dispose();
        _socket.Dispose();
    }
}
