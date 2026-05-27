namespace OwnViewAgent;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();

        var settings = AgentSettings.Load();
        using var cancellation = new CancellationTokenSource();
        using var client = new AgentClient(settings);
        var form = new ConsentForm();
        using var screenCapture = new ScreenCaptureService(client, form);
        var inputControl = new InputControlService(settings, form);

        form.FormClosing += (_, _) =>
        {
            screenCapture.Stop();
            inputControl.SetSessionApproved(false);
            cancellation.Cancel();
        };
        client.StatusChanged += form.SetStatus;
        client.MessageReceived += message => HandleAgentMessage(form, screenCapture, inputControl, message);
        form.ApproveRequested += async () =>
        {
            try
            {
                await client.ApproveAsync(cancellation.Token);
                form.SetActiveSession("Support request approved. Native screen sharing is active.");
                screenCapture.Start(cancellation.Token);
                inputControl.SetSessionApproved(true);
            }
            catch (Exception ex)
            {
                form.SetStatus($"Approve failed: {ex.Message}");
            }
        };
        form.RejectRequested += async () =>
        {
            try
            {
                await client.RejectAsync(cancellation.Token);
                screenCapture.Stop();
                inputControl.SetSessionApproved(false);
                form.ClearSupportRequest("Support request rejected.");
            }
            catch (Exception ex)
            {
                form.SetStatus($"Reject failed: {ex.Message}");
            }
        };

        _ = Task.Run(async () =>
        {
            try
            {
                await client.ConnectAsync(cancellation.Token);
            }
            catch (Exception ex)
            {
                form.SetStatus($"Agent connection failed: {ex.Message}");
            }
        });

        Application.Run(form);
    }

    private static void HandleAgentMessage(
        ConsentForm form,
        ScreenCaptureService screenCapture,
        InputControlService inputControl,
        string message)
    {
        form.AppendLog(message);

        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(message);
            var root = document.RootElement;
            if (!root.TryGetProperty("type", out var typeElement))
            {
                return;
            }

            switch (typeElement.GetString())
            {
                case "agent.registered":
                    var deviceLabel = root.TryGetProperty("deviceLabel", out var deviceElement)
                        ? deviceElement.GetString()
                        : "unknown";
                    form.SetStatus($"Agent registered. Device ID: {deviceLabel}");
                    break;
                case "support.request":
                    var requester = root.TryGetProperty("requesterLabel", out var requesterElement)
                        ? requesterElement.GetString()
                        : "unknown";
                    form.ShowSupportRequest(requester ?? "unknown");
                    break;
                case "support.approved":
                    form.SetActiveSession("Support request approved. Native screen sharing is active.");
                    screenCapture.Start(CancellationToken.None);
                    inputControl.SetSessionApproved(true);
                    break;
                case "support.rejected":
                    screenCapture.Stop();
                    inputControl.SetSessionApproved(false);
                    form.ClearSupportRequest("Support request rejected.");
                    break;
                case "agent.input":
                    if (root.TryGetProperty("input", out var inputElement))
                    {
                        inputControl.Apply(inputElement);
                    }
                    break;
                case "agent.error":
                    var error = root.TryGetProperty("error", out var errorElement)
                        ? errorElement.GetString()
                        : "unknown server error";
                    form.SetStatus($"Server error: {error}");
                    break;
            }
        }
        catch (System.Text.Json.JsonException)
        {
            form.AppendLog("Received an unreadable server message.");
        }
    }
}
