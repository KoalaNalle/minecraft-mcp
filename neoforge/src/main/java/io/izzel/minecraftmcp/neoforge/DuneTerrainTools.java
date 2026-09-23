package io.izzel.minecraftmcp.neoforge;

import io.izzel.minecraftmcp.mcp.McpTool;
import io.izzel.minecraftmcp.mcp.ToolRegistry;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;

import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;

/** Optional Dune integration; minecraft-mcp has no compile or runtime dependency on Dune. */
final class DuneTerrainTools {
    private static final String API_NAME = "com.blackenter.minecraftdune.worldgen.arrakis.ArrakisDiagnosticApi";
    private static final String ACTOR_KEY = "$mcpPlayerUuid";

    private DuneTerrainTools() {}

    static void registerIfPresent(ToolRegistry registry, MinecraftServer server) {
        Method inspect;
        Method status = null;
        try {
            Class<?> api = Class.forName(API_NAME);
            inspect = api.getMethod("inspect", ServerLevel.class, int.class, int.class, int.class);
            if (!Modifier.isStatic(inspect.getModifiers()) || !Map.class.isAssignableFrom(inspect.getReturnType())) {
                throw new IllegalStateException(API_NAME + ".inspect has an incompatible signature");
            }
            try {
                status = api.getMethod("status", ServerLevel.class);
                if (!Modifier.isStatic(status.getModifiers()) || !Map.class.isAssignableFrom(status.getReturnType())) {
                    throw new IllegalStateException(API_NAME + ".status has an incompatible signature");
                }
            } catch (NoSuchMethodException ignored) {
                // Older Dune development builds expose column inspection only.
            }
        } catch (ClassNotFoundException | NoSuchMethodException e) {
            return;
        }

        registry.register(new McpTool() {
            public String name() { return "mc.dune.terrain.column"; }
            public String description() { return "Read Dune's authoritative terrain diagnostic for a coordinate in the requesting player's dimension"; }
            public Map<String, Object> inputSchema() {
                return Map.of("type", "object", "required", java.util.List.of("x", "y", "z"), "properties", Map.of(
                        "x", Map.of("type", "integer"), "y", Map.of("type", "integer"), "z", Map.of("type", "integer")));
            }
            public Object call(Map<String, Object> arguments) throws Exception {
                int x = coordinate(arguments, "x", -30000000, 30000000);
                int y = coordinate(arguments, "y", -2048, 2048);
                int z = coordinate(arguments, "z", -30000000, 30000000);
                String actor = String.valueOf(arguments.getOrDefault(ACTOR_KEY, ""));
                if (actor.isBlank()) return Map.of("status", "player_unavailable");
                if (server.isSameThread()) return inspect(server, inspect, actor, x, y, z);
                return CompletableFuture.supplyAsync(() -> inspect(server, inspect, actor, x, y, z), server).get(10, TimeUnit.SECONDS);
            }
        });
        if (status != null) {
            Method statusMethod = status;
            registry.register(new McpTool() {
                public String name() { return "mc.dune.world.status"; }
                public String description() { return "Read Dune world, profile, revision and version status in the requesting player's dimension"; }
                public Map<String, Object> inputSchema() { return Map.of("type", "object"); }
                public Object call(Map<String, Object> arguments) throws Exception {
                    String actor = String.valueOf(arguments.getOrDefault(ACTOR_KEY, ""));
                    if (actor.isBlank()) return Map.of("status", "player_unavailable");
                    if (server.isSameThread()) return worldStatus(server, statusMethod, actor);
                    return CompletableFuture.supplyAsync(() -> worldStatus(server, statusMethod, actor), server).get(10, TimeUnit.SECONDS);
                }
            });
        }
    }

    private static int coordinate(Map<String, Object> arguments, String key, int min, int max) {
        Object value = arguments.get(key);
        if (!(value instanceof Number number) || number.doubleValue() != number.intValue() || number.intValue() < min || number.intValue() > max) {
            throw new IllegalArgumentException(key + " must be an integer from " + min + " to " + max);
        }
        return number.intValue();
    }

    private static Map<String, Object> inspect(MinecraftServer server, Method method, String actor, int x, int y, int z) {
        ServerPlayer player;
        try {
            player = server.getPlayerList().getPlayer(UUID.fromString(actor));
        } catch (IllegalArgumentException e) {
            return Map.of("status", "player_unavailable");
        }
        if (player == null) return Map.of("status", "player_offline");
        try {
            Object raw = method.invoke(null, player.serverLevel(), x, y, z);
            if (!(raw instanceof Map<?, ?> map)) throw new IllegalStateException("Dune diagnostic returned no map");
            Map<String, Object> result = new LinkedHashMap<>();
            for (var entry : map.entrySet()) result.put(String.valueOf(entry.getKey()), entry.getValue());
            result.put("dimension", player.serverLevel().dimension().location().toString());
            result.put("x", x);
            result.put("y", y);
            result.put("z", z);
            result.put("status", "available");
            return result;
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("Dune diagnostic method is inaccessible", e);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw new IllegalStateException("Dune diagnostic failed: " + (cause == null ? e.getMessage() : cause.getMessage()), cause);
        }
    }

    private static Map<String, Object> worldStatus(MinecraftServer server, Method method, String actor) {
        ServerPlayer player;
        try {
            player = server.getPlayerList().getPlayer(UUID.fromString(actor));
        } catch (IllegalArgumentException e) {
            return Map.of("status", "player_unavailable");
        }
        if (player == null) return Map.of("status", "player_offline");
        try {
            Object raw = method.invoke(null, player.serverLevel());
            if (!(raw instanceof Map<?, ?> map)) throw new IllegalStateException("Dune status returned no map");
            Map<String, Object> result = new LinkedHashMap<>();
            for (var entry : map.entrySet()) result.put(String.valueOf(entry.getKey()), entry.getValue());
            result.put("dimension", player.serverLevel().dimension().location().toString());
            result.put("status", "available");
            return result;
        } catch (IllegalAccessException e) {
            throw new IllegalStateException("Dune status method is inaccessible", e);
        } catch (InvocationTargetException e) {
            Throwable cause = e.getCause();
            throw new IllegalStateException("Dune status failed: " + (cause == null ? e.getMessage() : cause.getMessage()), cause);
        }
    }
}
