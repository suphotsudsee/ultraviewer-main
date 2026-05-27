using System.Text.Json;

namespace OwnViewAgent;

public sealed class AgentSettings
{
    public string ServerUrl { get; set; } = "http://127.0.0.1:8787";
    public string AgentKey { get; set; } = "";
    public string AgentName { get; set; } = Environment.MachineName;
    public bool RequireVisibleApproval { get; set; } = true;
    public bool AllowRemoteInput { get; set; }

    public static AgentSettings Load()
    {
        const string fileName = "agentsettings.json";
        if (!File.Exists(fileName))
        {
            return new AgentSettings();
        }

        var json = File.ReadAllText(fileName);
        return JsonSerializer.Deserialize<AgentSettings>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
        }) ?? new AgentSettings();
    }
}
