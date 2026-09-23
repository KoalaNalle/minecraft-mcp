import { resolve } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { MinecraftBackend } from './backend.mjs';
import { createServer } from './server.mjs';

const discovery = process.env.MINECRAFT_MCP_DISCOVERY || process.argv[2];
if (!discovery) {
  console.error('Set MINECRAFT_MCP_DISCOVERY or pass the Minecraft gameDir/mcp/server.json path.');
  process.exit(2);
}

const backend = new MinecraftBackend(resolve(discovery));
const profile = process.env.MINECRAFT_MCP_PROFILE || 'observation';
if (!['observation', 'development'].includes(profile)) {
  console.error('MINECRAFT_MCP_PROFILE must be observation or development.');
  process.exit(2);
}
await serveStdio(() => createServer(backend, { profile }));
