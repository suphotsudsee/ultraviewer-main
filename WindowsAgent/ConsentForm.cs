namespace OwnViewAgent;

public sealed class ConsentForm : Form
{
    private readonly Label _statusLabel = new();
    private readonly Label _requestLabel = new();
    private readonly TextBox _logBox = new();
    private readonly Button _approveButton = new();
    private readonly Button _rejectButton = new();

    public event Action? ApproveRequested;
    public event Action? RejectRequested;

    public ConsentForm()
    {
        Text = "OwnView Agent";
        Width = 520;
        Height = 360;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;

        var title = new Label
        {
            Text = "OwnView Agent is visible and waiting for approval.",
            AutoSize = false,
            Left = 18,
            Top = 18,
            Width = 460,
            Height = 36,
            Font = new Font(Font.FontFamily, 11, FontStyle.Bold),
        };

        _statusLabel.Left = 18;
        _statusLabel.Top = 62;
        _statusLabel.Width = 460;
        _statusLabel.Height = 28;
        _statusLabel.Text = "Not connected";

        _requestLabel.Left = 18;
        _requestLabel.Top = 92;
        _requestLabel.Width = 460;
        _requestLabel.Height = 38;
        _requestLabel.Text = "No pending support request.";

        _logBox.Left = 18;
        _logBox.Top = 136;
        _logBox.Width = 464;
        _logBox.Height = 114;
        _logBox.Multiline = true;
        _logBox.ReadOnly = true;
        _logBox.ScrollBars = ScrollBars.Vertical;

        _approveButton.Text = "Approve visible support";
        _approveButton.Left = 18;
        _approveButton.Top = 270;
        _approveButton.Width = 220;
        _approveButton.Height = 36;
        _approveButton.Enabled = false;

        _rejectButton.Text = "Reject / Stop";
        _rejectButton.Left = 262;
        _rejectButton.Top = 270;
        _rejectButton.Width = 220;
        _rejectButton.Height = 36;
        _rejectButton.Enabled = false;

        _approveButton.Click += (_, _) => ApproveRequested?.Invoke();
        _rejectButton.Click += (_, _) => RejectRequested?.Invoke();

        Controls.AddRange([title, _statusLabel, _requestLabel, _logBox, _approveButton, _rejectButton]);
    }

    public void SetStatus(string status)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetStatus(status));
            return;
        }

        _statusLabel.Text = status;
        AppendLog(status);
    }

    public void AppendLog(string message)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => AppendLog(message));
            return;
        }

        _logBox.AppendText($"[{DateTime.Now:T}] {message}{Environment.NewLine}");
    }

    public void ShowSupportRequest(string requesterLabel)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ShowSupportRequest(requesterLabel));
            return;
        }

        _requestLabel.Text = $"Support request from {requesterLabel}. Approve only if you trust this person.";
        _approveButton.Enabled = true;
        _rejectButton.Enabled = true;
        AppendLog($"Support request from {requesterLabel}");
    }

    public void ClearSupportRequest(string status)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => ClearSupportRequest(status));
            return;
        }

        _requestLabel.Text = status;
        _approveButton.Enabled = false;
        _rejectButton.Enabled = false;
        AppendLog(status);
    }

    public void SetActiveSession(string status)
    {
        if (InvokeRequired)
        {
            BeginInvoke(() => SetActiveSession(status));
            return;
        }

        _requestLabel.Text = status;
        _approveButton.Enabled = false;
        _rejectButton.Enabled = true;
        AppendLog(status);
    }
}
