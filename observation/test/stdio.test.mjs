import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const observationRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const stdioPath = join(observationRoot, 'src', 'stdio.mjs');
const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');

async function connect(discoveryPath, profile = 'observation') {
  const client = new Client({ name: 'observation-protocol-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [stdioPath],
    cwd: observationRoot,
    env: { ...process.env, MINECRAFT_MCP_DISCOVERY: discoveryPath, MINECRAFT_MCP_PROFILE: profile }
  }));
  return client;
}

function payload(result) {
  assert.equal(result.content[0].type, 'text');
  return JSON.parse(result.content[0].text);
}

test('real MCP stdio client sees only observation tools and receives structured data plus image', async () => {
  const gameDir = await mkdtemp(join(tmpdir(), 'minecraft-observation-'));
  await mkdir(join(gameDir, 'mcp'));
  await mkdir(join(gameDir, 'screenshots'));
  await writeFile(join(gameDir, 'screenshots', 'test.png'), tinyPng);
  const calls = [];
  let duneAvailable = true;
  let cameraMoveRequested = false;
  const cameras = [
    { name: 'Original', dimension: 'minecraft:overworld', x: 1, y: 80, z: 2, yaw: 90, pitch: 5 },
    { name: 'Far', dimension: 'minecraft:overworld', x: 10, y: 90, z: 20, yaw: -45, pitch: 10 }
  ];
  const http = createHttpServer(async (request, response) => {
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.authorization, 'Bearer local-test-token');
    let body = '';
    for await (const chunk of request) body += chunk;
    const rpc = JSON.parse(body);
    assert.equal(rpc.method, 'tools/call');
    calls.push(rpc.params.name);
    const name = rpc.params.name;
    if (name === 'mc.dune.camera.goto') cameraMoveRequested = true;
    if (name === 'mc.server.call') {
      assert.ok(['mc.dune.world.status', 'mc.dune.terrain.column'].includes(rpc.params.arguments.tool));
      assert.deepEqual(rpc.params.arguments.arguments, rpc.params.arguments.tool === 'mc.dune.world.status' ? {} : { x: 1, y: 80, z: 2 });
      if (rpc.params.arguments.tool === 'mc.dune.terrain.column' && !duneAvailable) {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32603, message: 'Unknown tool: mc.dune.terrain.column' } }));
        return;
      }
    }
    const result = {
      'mc.client.state': { running: true, inWorld: true, rawInWorld: true, playerName: 'Tester', position: { x: 1, y: 80, z: 2 }, rotation: { yaw: 90, pitch: 5 } },
      'mc.player.state': { running: true, inWorld: true, rawInWorld: true, playerName: 'Tester', position: cameraMoveRequested ? { x: 10, y: 90, z: 20 } : { x: 1, y: 80, z: 2 }, rotation: cameraMoveRequested ? { yaw: -45, pitch: 10 } : { yaw: 90, pitch: 5 } },
      'mc.debug.capabilities': { loader: 'neoforge', minecraftVersion: '1.21.1' },
      'mc.world.snapshot': { inWorld: true, dimension: 'minecraft:overworld', gameTime: 120 },
      'mc.block.state': { status: 'loaded', dimension: 'minecraft:overworld', x: 1, y: 80, z: 2, block: 'minecraft:oak_stairs', properties: { facing: 'north', half: 'bottom' } },
      'mc.region.inspect': { status: 'partial', source: 'client_loaded_world', dimension: 'minecraft:overworld', volume: 2, loaded_count: 1, unloaded_count: 1, cells: [{ x: 1, y: 80, z: 2, status: 'loaded', block: 'minecraft:oak_stairs', properties: { facing: 'north' } }, { x: 2, y: 80, z: 2, status: 'unloaded' }] },
      'mc.dune.camera.list': { status: 'available', cameras },
      'mc.dune.camera.goto': { status: 'teleport_requested', accepted: true, camera: cameras[1] },
      'mc.server.call': rpc.params.arguments.tool === 'mc.dune.world.status'
        ? { status: 'available', minecraft_version: '1.21.1', neoforge_version: '21.1.248', dune_version: '0.6.0-dev.4', dimension: 'minecraft:overworld', world_seed: 0, terrain_profile: '6000', terrain_algorithm_revision: 4 }
        : { status: 'available', dimension: 'minecraft:overworld', x: 1, y: 80, z: 2, analytical: { source: 'analytical_generator_prediction', raw_rock_roof: 64 }, loaded_world: { status: 'unloaded' } },
      'mc.screenshot.take': { status: 'saved', path: 'screenshots/test.png', absolutePath: join(gameDir, 'screenshots', 'test.png'), width: 1, height: 1, timestamp: '2026-09-23T00:00:00Z', dimension: 'minecraft:overworld', position: { x: 1, y: 80, z: 2 }, rotation: { yaw: 90, pitch: 5 }, fov: 70 }
    }[name];
    assert.ok(result, `unexpected internal tool ${name}`);
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { isError: false, content: [{ type: 'text', text: JSON.stringify(result) }] } }));
  });
  await new Promise(resolveReady => http.listen(0, '127.0.0.1', resolveReady));
  const port = http.address().port;
  const discovery = join(gameDir, 'mcp', 'server.json');
  await writeFile(discovery, JSON.stringify({ host: '127.0.0.1', port, path: '/mcp', authToken: 'local-test-token' }));
  const client = await connect(discovery);
  try {
    const definitions = (await client.listTools()).tools;
    const tools = definitions.map(tool => tool.name).sort();
    assert.deepEqual(tools, ['capture_screenshot', 'get_player_state', 'get_world_status', 'inspect_loaded_block', 'inspect_region', 'inspect_terrain_column']);
    assert.equal(definitions.find(tool => tool.name === 'inspect_loaded_block').annotations.readOnlyHint, true);
    assert.equal(definitions.find(tool => tool.name === 'capture_screenshot').annotations.readOnlyHint, false);
    const status = payload(await client.callTool({ name: 'get_world_status' }));
    assert.equal(status.status, 'available');
    assert.equal(status.dune.dune_version, '0.6.0-dev.4');
    assert.equal(payload(await client.callTool({ name: 'get_player_state' })).dimension, 'minecraft:overworld');
    const block = payload(await client.callTool({ name: 'inspect_loaded_block', arguments: { x: 1, y: 80, z: 2 } }));
    assert.equal(block.block, 'minecraft:oak_stairs');
    assert.deepEqual(block.properties, { facing: 'north', half: 'bottom' });
    const region = payload(await client.callTool({ name: 'inspect_region', arguments: { min: { x: 1, y: 80, z: 2 }, max: { x: 2, y: 80, z: 2 } } }));
    assert.equal(region.status, 'partial');
    assert.equal(region.unloaded_count, 1);
    const oversized = await client.callTool({ name: 'inspect_region', arguments: { min: { x: 1, y: 80, z: 2 }, max: { x: 17, y: 80, z: 2 } } });
    assert.equal(oversized.isError, true);
    assert.equal(calls.filter(name => name === 'mc.region.inspect').length, 1);
    const terrain = payload(await client.callTool({ name: 'inspect_terrain_column', arguments: { x: 1, y: 80, z: 2 } }));
    assert.equal(terrain.analytical.raw_rock_roof, 64);
    assert.equal(terrain.loaded_world.status, 'unloaded');
    duneAvailable = false;
    const unavailable = await client.callTool({ name: 'inspect_terrain_column', arguments: { x: 1, y: 80, z: 2 } });
    assert.equal(unavailable.isError, true);
    assert.equal(payload(unavailable).status, 'dune_unavailable');
    const screenshot = await client.callTool({ name: 'capture_screenshot' });
    assert.equal(screenshot.content[1].type, 'image');
    assert.equal(screenshot.content[1].mimeType, 'image/png');
    assert.deepEqual(Buffer.from(screenshot.content[1].data, 'base64'), tinyPng);
    assert.equal(payload(screenshot).dimension, 'minecraft:overworld');
    assert.equal(payload(screenshot).absolutePath, undefined);
    assert.equal(payload(screenshot).cameraPreset, 'Original');
    const invalid = await client.callTool({ name: 'inspect_loaded_block', arguments: { x: 'bad', y: 80, z: 2 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.filter(name => name === 'mc.block.state').length, 1);
    const development = await connect(discovery, 'development');
    try {
      const developmentTools = (await development.listTools()).tools;
      assert.deepEqual(developmentTools.map(tool => tool.name).sort(), [...tools, 'go_to_saved_camera', 'list_saved_cameras'].sort());
      assert.equal(developmentTools.find(tool => tool.name === 'go_to_saved_camera').annotations.readOnlyHint, false);
      assert.equal(payload(await development.callTool({ name: 'list_saved_cameras' })).cameras.length, 2);
      const arrival = payload(await development.callTool({ name: 'go_to_saved_camera', arguments: { name: 'Far' } }));
      assert.equal(arrival.status, 'arrived');
      assert.equal(arrival.completed, true);
      assert.deepEqual(arrival.observed.player.position, { x: 10, y: 90, z: 20 });
      assert.equal((await development.callTool({ name: 'go_to_saved_camera', arguments: { name: '../bad' } })).isError, true);
      assert.equal(calls.filter(name => name === 'mc.dune.camera.goto').length, 1);
    } finally {
      await development.close();
    }
    assert.deepEqual([...new Set(calls)].sort(), ['mc.block.state', 'mc.client.state', 'mc.debug.capabilities', 'mc.dune.camera.goto', 'mc.dune.camera.list', 'mc.player.state', 'mc.region.inspect', 'mc.screenshot.take', 'mc.server.call', 'mc.world.snapshot']);
  } finally {
    await client.close();
    await new Promise(resolveClose => http.close(resolveClose));
  }
});

test('MCP discovery works while Minecraft is unavailable and reports failure on call', async () => {
  const missing = join(tmpdir(), `missing-minecraft-${process.pid}`, 'mcp', 'server.json');
  const client = await connect(missing);
  try {
    assert.equal((await client.listTools()).tools.length, 6);
    const result = await client.callTool({ name: 'get_world_status' });
    assert.equal(result.isError, true);
    assert.equal(payload(result).status, 'minecraft_unavailable');
  } finally {
    await client.close();
  }
});

test('non-loopback discovery is rejected before any network request', async () => {
  const gameDir = await mkdtemp(join(tmpdir(), 'minecraft-bad-discovery-'));
  await mkdir(join(gameDir, 'mcp'));
  const discovery = join(gameDir, 'mcp', 'server.json');
  await writeFile(discovery, JSON.stringify({ host: '192.0.2.1', port: 25577, path: '/mcp', authToken: 'test' }));
  const client = await connect(discovery);
  try {
    const result = await client.callTool({ name: 'get_world_status' });
    assert.equal(result.isError, true);
    assert.equal(payload(result).status, 'invalid_discovery');
  } finally {
    await client.close();
  }
});
