import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const coord = z.number().int().min(-30000000).max(30000000);
const point = z.object({ x: coord, y: coord, z: coord });
const region = z.object({ min: point, max: point }).superRefine(({ min, max }, context) => {
  const lengths = ['x', 'y', 'z'].map(axis => max[axis] - min[axis] + 1);
  if (lengths.some(length => length < 1 || length > 16) || lengths.reduce((a, b) => a * b, 1) > 256) {
    context.addIssue({ code: 'custom', message: 'Region bounds must be ordered, each side at most 16 blocks, and volume at most 256 blocks' });
  }
});

function textResult(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], isError };
}

function guarded(action) {
  return async (...args) => {
    try {
      return await action(...args);
    } catch (error) {
      return textResult({ status: error.code ?? 'observation_error', message: error.message }, true);
    }
  };
}

export function createServer(backend, { profile = 'observation' } = {}) {
  if (!['observation', 'development'].includes(profile)) throw new Error('Unknown observation profile');
  const server = new McpServer({ name: 'minecraft-mcp-observation', version: '0.1.0' });
  let cameraMovementActive = false;

  server.registerTool('get_world_status', {
    description: 'Read connected Minecraft client and current world status. No world is created or loaded.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, guarded(async () => {
    const [client, capabilities, world] = await Promise.all([
      backend.call('mc.client.state'), backend.call('mc.debug.capabilities'), backend.call('mc.world.snapshot')
    ]);
    let dune = { status: 'not_in_world' };
    if (world.inWorld) {
      try {
        dune = await backend.call('mc.server.call', {
          tool: 'mc.dune.world.status', arguments: {}, timeoutMs: 10000
        }, 15000);
      } catch (error) {
        dune = { status: serverToolErrorStatus(error, 'mc.dune.world.status'), message: error.message };
      }
    }
    return textResult({ status: world.inWorld ? 'available' : 'not_in_world', client, capabilities, world, dune });
  }));

  server.registerTool('get_player_state', {
    description: 'Read current player position, rotation, name, and dimension if connected.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, guarded(async () => {
    const [player, world] = await Promise.all([
      backend.call('mc.player.state'), backend.call('mc.world.snapshot')
    ]);
    return textResult({ status: player.rawInWorld && world.inWorld ? 'available' : 'not_in_world', player, dimension: world.dimension ?? null });
  }));

  server.registerTool('inspect_loaded_block', {
    description: 'Read one loaded client-world block, including registry ID and block-state properties. Unloaded chunks stay unloaded.',
    inputSchema: z.object({ x: coord, y: coord, z: coord }),
    annotations: { readOnlyHint: true }
  }, guarded(async ({ x, y, z }) => textResult(await backend.call('mc.block.state', { x, y, z }))));

  server.registerTool('inspect_region', {
    description: 'Inspect up to 256 client-visible blocks within an ordered 16-by-16-by-16 bound. Unloaded chunks remain unloaded.',
    inputSchema: region,
    annotations: { readOnlyHint: true }
  }, guarded(async ({ min, max }) => textResult(await backend.call('mc.region.inspect', {
    minX: min.x, minY: min.y, minZ: min.z, maxX: max.x, maxY: max.y, maxZ: max.z
  }, 15000))));

  server.registerTool('inspect_terrain_column', {
    description: 'Read Dune generator diagnostics for one column in the connected player dimension. The result distinguishes analytical prediction from loaded blocks.',
    inputSchema: z.object({ x: coord, y: coord, z: coord }),
    annotations: { readOnlyHint: true }
  }, guarded(async ({ x, y, z }) => {
    let result;
    try {
      result = await backend.call('mc.server.call', {
        tool: 'mc.dune.terrain.column', arguments: { x, y, z }, timeoutMs: 10000
      }, 15000);
    } catch (error) {
      error.code = serverToolErrorStatus(error, 'mc.dune.terrain.column');
      throw error;
    }
    return textResult(result, result.status !== 'available');
  }));

  server.registerTool('capture_screenshot', {
    description: 'Capture the visible Minecraft client frame and return PNG image content with camera metadata.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: false, destructiveHint: false }
  }, guarded(async () => {
    const result = await backend.call('mc.screenshot.take', {}, 30000);
    if (result.status !== 'saved' || typeof result.path !== 'string' || isAbsolute(result.path)) {
      throw Object.assign(new Error('Client did not return a saved relative screenshot path'), { code: 'invalid_screenshot' });
    }
    const screenshotRoot = await realpath(resolve(backend.gameDirectory, 'screenshots'));
    const target = await realpath(resolve(backend.gameDirectory, result.path));
    const relativePath = relative(screenshotRoot, target);
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw Object.assign(new Error('Screenshot path escapes game screenshots directory'), { code: 'invalid_screenshot' });
    }
    const info = await stat(target);
    if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES) {
      throw Object.assign(new Error('Screenshot has invalid size'), { code: 'invalid_screenshot' });
    }
    const image = await readFile(target);
    if (!image.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw Object.assign(new Error('Screenshot is not PNG'), { code: 'invalid_screenshot' });
    }
    const { absolutePath: _discard, ...metadata } = result;
    if (metadata.dimension && metadata.position && metadata.rotation) {
      try {
        const saved = await backend.call('mc.dune.camera.list', {}, 5000);
        metadata.cameraPreset = saved.cameras?.find(camera => atCamera(metadata.position, metadata.rotation, metadata.dimension, camera))?.name ?? null;
      } catch {
        metadata.cameraPreset = null;
      }
    }
    return {
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }
      ]
    };
  }));

  if (profile === 'development') {
    server.registerTool('list_saved_cameras', {
      description: 'List Dune debug camera presets from Dune’s authoritative in-memory camera store.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true }
    }, guarded(async () => {
      const result = await backend.call('mc.dune.camera.list');
      return textResult(result, result.status !== 'available');
    }));

    server.registerTool('go_to_saved_camera', {
      description: 'Travel only to a previously saved Dune camera and confirm observed arrival. Requires the development profile and server teleport permission.',
      inputSchema: z.object({ name: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/) }),
      annotations: { readOnlyHint: false, destructiveHint: false }
    }, guarded(async ({ name }) => {
      if (cameraMovementActive) return textResult({ status: 'camera_busy', accepted: false, completed: false }, true);
      cameraMovementActive = true;
      try {
        const request = await backend.call('mc.dune.camera.goto', { name }, 15000);
        if (request.status !== 'teleport_requested' || request.accepted !== true) {
          return textResult({ ...request, accepted: false, completed: false }, true);
        }
        const target = request.camera;
        if (!target || !Number.isFinite(target.x) || !Number.isFinite(target.y) || !Number.isFinite(target.z)) {
          return textResult({ status: 'invalid_camera_result', accepted: true, completed: false }, true);
        }
        const deadline = Date.now() + 30000;
        let lastObservation = null;
        while (Date.now() < deadline) {
          const remaining = deadline - Date.now();
          try {
            const [player, world] = await Promise.all([
              backend.call('mc.player.state', {}, Math.min(5000, remaining)),
              backend.call('mc.world.snapshot', {}, Math.min(5000, remaining))
            ]);
            lastObservation = { player, dimension: world.dimension ?? null };
            if (player.rawInWorld && world.inWorld && atCamera(player.position, player.rotation, world.dimension, target)) {
              return textResult({ status: 'arrived', accepted: true, completed: true, camera: target, observed: lastObservation });
            }
          } catch (error) {
            return textResult({ status: error.code ?? 'camera_observation_failed', accepted: true, completed: false, message: error.message }, true);
          }
          await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
        }
        return textResult({ status: 'arrival_timeout', accepted: true, completed: false, camera: target, observed: lastObservation }, true);
      } finally {
        cameraMovementActive = false;
      }
    }));
  }

  return server;
}

function angleDifference(a, b) {
  return Math.abs((((a - b) % 360) + 540) % 360 - 180);
}

function atCamera(position, rotation, dimension, camera) {
  return position && rotation && dimension === camera.dimension
    && Math.abs(position.x - camera.x) <= 0.25
    && Math.abs(position.y - camera.y) <= 0.25
    && Math.abs(position.z - camera.z) <= 0.25
    && angleDifference(rotation.yaw, camera.yaw) <= 0.5
    && Math.abs(rotation.pitch - camera.pitch) <= 0.5;
}

function serverToolErrorStatus(error, tool) {
  if (error.code === 'client_tool_error' && error.message.includes(`Unknown tool: ${tool}`)) return 'dune_unavailable';
  if (error.code === 'client_tool_error' && error.message.includes('server MCP is not available')) return 'server_unavailable';
  return error.code ?? 'observation_error';
}
