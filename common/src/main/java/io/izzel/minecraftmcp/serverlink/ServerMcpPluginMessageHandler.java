package io.izzel.minecraftmcp.serverlink;

import io.izzel.minecraftmcp.json.Json;
import io.izzel.minecraftmcp.mcp.ToolRegistry;

import java.util.LinkedHashMap;
import java.util.Map;

public final class ServerMcpPluginMessageHandler {
    public interface Sender { void send(String payload); }

    private final ToolRegistry tools;

    public ServerMcpPluginMessageHandler(ToolRegistry tools) {
        this.tools = tools;
    }

    public void receive(String payload, Sender sender) {
        receive(payload, sender, null);
    }

    @SuppressWarnings("unchecked")
    public void receive(String payload, Sender sender, String playerUuid) {
        Object parsed = Json.parse(payload);
        if (!(parsed instanceof Map<?, ?> raw)) return;
        Map<String, Object> message = (Map<String, Object>) raw;
        if (!"request".equals(String.valueOf(message.get("type")))) return;
        Object id = message.get("id");
        String tool = String.valueOf(message.get("tool"));
        Map<String, Object> supplied = message.get("arguments") instanceof Map<?, ?> map ? (Map<String, Object>) map : Map.of();
        Map<String, Object> arguments = new LinkedHashMap<>(supplied);
        arguments.remove("$mcpPlayerUuid");
        if (playerUuid != null) arguments.put("$mcpPlayerUuid", playerUuid);
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("type", "response");
        response.put("id", id);
        try {
            response.put("result", tools.call(tool, arguments));
            response.put("ok", true);
        } catch (Exception e) {
            response.put("ok", false);
            response.put("error", e.getMessage());
        }
        sender.send(Json.stringify(response));
    }
}
