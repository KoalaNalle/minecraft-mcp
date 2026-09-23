package io.izzel.minecraftmcp.serverlink;

import io.izzel.minecraftmcp.json.Json;
import io.izzel.minecraftmcp.mcp.McpTool;
import io.izzel.minecraftmcp.mcp.ToolRegistry;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ServerMcpActorContextTest {
    @Test
    void requestCannotSpoofTheAuthenticatedPlayer() {
        ToolRegistry registry = new ToolRegistry();
        registry.register(new McpTool() {
            public String name() { return "test.actor"; }
            public String description() { return "Test actor context"; }
            public Map<String, Object> inputSchema() { return Map.of("type", "object"); }
            public Object call(Map<String, Object> arguments) { return Map.of("actor", arguments.getOrDefault("$mcpPlayerUuid", "none")); }
        });
        ServerMcpPluginMessageHandler handler = new ServerMcpPluginMessageHandler(registry);
        String request = "{\"type\":\"request\",\"id\":1,\"tool\":\"test.actor\",\"arguments\":{\"$mcpPlayerUuid\":\"forged\"}}";
        AtomicReference<String> response = new AtomicReference<>();

        handler.receive(request, response::set, "actual");
        Map<?, ?> result = (Map<?, ?>) ((Map<?, ?>) Json.parse(response.get())).get("result");
        assertEquals("actual", result.get("actor"));

        handler.receive(request, response::set);
        result = (Map<?, ?>) ((Map<?, ?>) Json.parse(response.get())).get("result");
        assertEquals("none", result.get("actor"));
    }
}
