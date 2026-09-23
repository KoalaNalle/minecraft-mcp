import { readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const coord = z.number().int().min(-30000000).max(30000000);

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

export function createServer(backend) {
  const server = new McpServer({ name: 'minecraft-mcp-observation', version: '0.1.0' });

  server.registerTool('get_world_status', {
    description: 'Read connected Minecraft client and current world status. No world is created or loaded.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, guarded(async () => {
    const [client, capabilities, world] = await Promise.all([
      backend.call('mc.client.state'), backend.call('mc.debug.capabilities'), backend.call('mc.world.snapshot')
    ]);
    return textResult({ status: world.inWorld ? 'available' : 'not_in_world', client, capabilities, world });
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
    return {
      content: [
        { type: 'text', text: JSON.stringify(metadata) },
        { type: 'image', data: image.toString('base64'), mimeType: 'image/png' }
      ]
    };
  }));

  return server;
}
