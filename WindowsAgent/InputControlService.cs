using System.Runtime.InteropServices;
using System.Text.Json;

namespace OwnViewAgent;

public sealed class InputControlService
{
    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint MouseEventLeftDown = 0x0002;
    private const uint MouseEventLeftUp = 0x0004;
    private const uint MouseEventRightDown = 0x0008;
    private const uint MouseEventRightUp = 0x0010;
    private const uint MouseEventMiddleDown = 0x0020;
    private const uint MouseEventMiddleUp = 0x0040;
    private const uint MouseEventWheel = 0x0800;
    private const uint KeyEventUp = 0x0002;

    private readonly AgentSettings _settings;
    private readonly ConsentForm _form;
    private bool _sessionApproved;

    public InputControlService(AgentSettings settings, ConsentForm form)
    {
        _settings = settings;
        _form = form;
    }

    public void SetSessionApproved(bool approved)
    {
        _sessionApproved = approved;
    }

    public void Apply(JsonElement input)
    {
        if (!_sessionApproved || !_settings.AllowRemoteInput)
        {
            return;
        }

        if (!input.TryGetProperty("kind", out var kindElement))
        {
            return;
        }

        switch (kindElement.GetString())
        {
            case "mouse":
                ApplyMouse(input);
                break;
            case "keyboard":
                ApplyKeyboard(input);
                break;
        }
    }

    private static void ApplyMouse(JsonElement input)
    {
        var action = input.TryGetProperty("action", out var actionElement) ? actionElement.GetString() : "";
        var x = input.TryGetProperty("x", out var xElement) ? xElement.GetDouble() : 0;
        var y = input.TryGetProperty("y", out var yElement) ? yElement.GetDouble() : 0;
        var button = input.TryGetProperty("button", out var buttonElement) ? buttonElement.GetString() : "left";
        var deltaY = input.TryGetProperty("deltaY", out var deltaElement) ? deltaElement.GetDouble() : 0;

        var bounds = SystemInformation.VirtualScreen;
        var screenX = bounds.Left + (int)Math.Round(Math.Clamp(x, 0, 1) * Math.Max(1, bounds.Width - 1));
        var screenY = bounds.Top + (int)Math.Round(Math.Clamp(y, 0, 1) * Math.Max(1, bounds.Height - 1));
        SetCursorPos(screenX, screenY);

        if (action == "move")
        {
            return;
        }

        if (action == "wheel")
        {
            SendMouse(MouseEventWheel, 0, 0, (int)Math.Clamp(-deltaY, -1200, 1200));
            return;
        }

        uint flags = (button, action) switch
        {
            ("right", "down") => MouseEventRightDown,
            ("right", "up") => MouseEventRightUp,
            ("middle", "down") => MouseEventMiddleDown,
            ("middle", "up") => MouseEventMiddleUp,
            (_, "down") => MouseEventLeftDown,
            (_, "up") => MouseEventLeftUp,
            _ => 0U,
        };

        if (flags != 0)
        {
            SendMouse(flags, 0, 0, 0);
        }
    }

    private static void ApplyKeyboard(JsonElement input)
    {
        var action = input.TryGetProperty("action", out var actionElement) ? actionElement.GetString() : "";
        var keyCode = input.TryGetProperty("keyCode", out var keyCodeElement) ? keyCodeElement.GetInt32() : 0;

        if (keyCode is < 1 or > 255)
        {
            return;
        }

        SendKeyboard((ushort)keyCode, action == "up");
    }

    private static void SendMouse(uint flags, int dx, int dy, int data)
    {
        var input = new Input
        {
            type = InputMouse,
            U = new InputUnion
            {
                mi = new MouseInput
                {
                    dx = dx,
                    dy = dy,
                    mouseData = data,
                    dwFlags = flags,
                },
            },
        };
        SendInput(1, [input], Marshal.SizeOf<Input>());
    }

    private static void SendKeyboard(ushort keyCode, bool keyUp)
    {
        var input = new Input
        {
            type = InputKeyboard,
            U = new InputUnion
            {
                ki = new KeyboardInput
                {
                    wVk = keyCode,
                    dwFlags = keyUp ? KeyEventUp : 0,
                },
            },
        };
        SendInput(1, [input], Marshal.SizeOf<Input>());
    }

    [DllImport("user32.dll")]
    private static extern bool SetCursorPos(int x, int y);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, Input[] pInputs, int cbSize);

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint type;
        public InputUnion U;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MouseInput mi;

        [FieldOffset(0)]
        public KeyboardInput ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int dx;
        public int dy;
        public int mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }
}
