# Codex observation connection

This fork is [KoalaNalle/minecraft-mcp](https://github.com/KoalaNalle/minecraft-mcp), based on [ArclightPowered/minecraft-mcp](https://github.com/ArclightPowered/minecraft-mcp). The local starting revision for this integration was `d9387740f005fb5f3fe3c4d2cc97787588448f36`. Keep `origin` pointed at the KoalaNalle fork and `upstream` pointed at ArclightPowered. The original copyright and license file are retained; the upstream license text itself is abbreviated and should be completed by the copyright holder before redistribution.

## Install

1. Build and install the NeoForge client mod into the Minecraft 1.21.1 client that will display the Dune world. The mod writes `mcp/server.json` under that client's **game directory** after startup. The file contains a rotating local bearer token; keep it out of version control.
2. Install the local adapter dependencies from `C:/Modding/Minecraft/minecraft-mcp/observation` with `pnpm install --frozen-lockfile`. Node.js 20 or newer is required.
3. Add only the following entry to a project-scoped `.codex/config.toml`, replacing the discovery path if your game directory differs:

```toml
[mcp_servers.minecraft_dune_observation]
command = "C:/Users/Koala/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe"
args = ["C:/Modding/Minecraft/minecraft-mcp/observation/src/stdio.mjs"]
env = { MINECRAFT_MCP_DISCOVERY = "C:/Modding/Minecraft/Minecraft-Dune/run/mcp/server.json" }
startup_timeout_sec = 10
tool_timeout_sec = 40
```

Use the actual client game directory, not a server-only directory. Codex's [MCP configuration instructions](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) describe project settings and desktop discovery. If the current Codex session does not discover a newly added server, restart Codex manually after saving the config; do not terminate an active development task just for discovery.

This adapter is a real MCP SDK stdio server. Its connection to the mod uses the existing authenticated localhost JSON-RPC endpoint as an internal implementation detail. It refuses discovery entries outside `127.0.0.1` or `::1` and does not publish a network MCP endpoint. No OpenAI or Anthropic API key is used. It does not alter global Codex configuration.

## Observation tools

| Tool | Result |
| --- | --- |
| `get_world_status` | Client state, dimension and world snapshot, plus optional Dune server status with Minecraft, NeoForge and Dune versions, seed, terrain profile and algorithm revision. Returns `not_in_world` on title/loading screens and a separate Dune unavailable status if the optional server hook is absent. |
| `get_player_state` | Player name, position, rotation and dimension when present. |
| `inspect_loaded_block` | Exact block registry ID and state properties for one position in a loaded client chunk. Returns `unloaded` without requesting chunk generation, `out_of_build_height`, or `not_in_world` as applicable. |
| `inspect_region` | Up to 256 client-visible block positions inside ordered bounds with sides at most 16. Returns exact block states for loaded positions and explicit unloaded/out-of-height cells, counts, and a block palette; never requests chunk generation. |
| `inspect_terrain_column` | Dune's authoritative analytical generator fields in the connected player's actual server dimension. Requires the optional Dune diagnostic API on the server and the NeoForge server mod; this does not inspect actual blocks. |
| `capture_screenshot` | PNG image content, size, timestamp, dimension, position, rotation and configured FOV. The client saves a local screenshot, and the adapter reads it into the MCP result; consumers need no filesystem access. |

The normal tool list contains no command execution, camera movement, inventory changes, WorldEdit, world creation or block placement. The five state queries carry read-only annotations. Screenshot capture is marked as a nondestructive state change because it writes a file under the game directory, though it does not modify the world. When a saved Dune preset matches the captured camera transform, screenshot metadata includes its name. The fixed allowlist in the adapter is the effective restriction. The client mod's generic server proxy is only called internally with fixed Dune diagnostic targets; it is never advertised to Codex.

## Development camera profile

To expose saved-camera inspection and movement, add `MINECRAFT_MCP_PROFILE = "development"` to the project-scoped entry's `env` map, and set `tool_timeout_sec = 60` so the 30-second arrival check can finish after command dispatch. Restart Codex manually if discovery does not update. This adds `list_saved_cameras` and `go_to_saved_camera` while retaining the observation tools. The default remains `observation`.

For example, replace the entry's `env` and `tool_timeout_sec` lines with:

```toml
env = { MINECRAFT_MCP_DISCOVERY = "C:/Modding/Minecraft/Minecraft-Dune/run/mcp/server.json", MINECRAFT_MCP_PROFILE = "development" }
tool_timeout_sec = 60
```

The camera list and target come from Dune's existing debug camera store through an optional Java API. The adapter never accepts arbitrary teleport coordinates or a generic command. Movement requests only a named saved preset, then polls player position, rotation and dimension for up to 30 seconds. It reports `arrived` only after observing the target; otherwise it reports rejection, failure or timeout. Server teleport permission is still required. Camera movement can load chunks, so leave this profile disabled during generation-speed baselines.

The NeoForge client mod exposes internal region and Dune camera tools on its authenticated localhost endpoint. The profile restriction applies to this Codex stdio adapter, not to other local clients with the endpoint token. Do not share the discovery file or token.

If the game is closed or the discovery file is absent, MCP initialization and tool discovery still succeed; a tool call returns `minecraft_unavailable`. Authentication errors and malformed discovery are reported separately. The adapter checks the saved screenshot stays inside the game directory's `screenshots` folder, is PNG, and is at most 16 MiB. Tool calls have bounded timeouts.

## Verification and limits

`pnpm test` starts a real MCP SDK client over stdio against a mock localhost game endpoint. It checks initialization, exact profile-specific tool lists, calls, loaded/unloaded region results, camera request and observed arrival, block-state properties, image content, invalid arguments and game-unavailable behavior. This is protocol testing against a mock game endpoint, not a live Minecraft or Codex test.

The adapter reports client-visible loaded blocks. The optional terrain tool calls the Dune-side diagnostic API and reports its analytical prediction separately from the API's loaded-server-world observation. The optional status tool exposes the Dune world seed for the connected player; use it only in a development world where the seed may be disclosed. The current mod's HTTP endpoint remains available to other local clients with its bearer token and still offers its original broader tool set; use this observation adapter as the Codex entry point for terrain debugging.
