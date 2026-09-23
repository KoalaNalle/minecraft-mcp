import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export class BackendError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BackendError';
    this.code = code;
  }
}

export class MinecraftBackend {
  constructor(discoveryPath) {
    this.discoveryPath = resolve(discoveryPath);
    this.gameDirectory = dirname(dirname(this.discoveryPath));
    this.nextId = 1;
  }

  async discovery() {
    let contents;
    try {
      contents = await readFile(this.discoveryPath, 'utf8');
    } catch (error) {
      throw new BackendError('minecraft_unavailable', `Client discovery file unavailable: ${error.code ?? error.message}`);
    }
    let discovery;
    try {
      discovery = JSON.parse(contents);
    } catch {
      throw new BackendError('invalid_discovery', 'Client discovery file is not JSON');
    }
    if (!discovery || typeof discovery !== 'object' || Array.isArray(discovery)) {
      throw new BackendError('invalid_discovery', 'Client discovery file must be an object');
    }
    const { host, port, path, authToken } = discovery;
    if (host !== '127.0.0.1' && host !== '::1') {
      throw new BackendError('invalid_discovery', 'Client endpoint must be loopback-only');
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535 || path !== '/mcp' || typeof authToken !== 'string' || !authToken) {
      throw new BackendError('invalid_discovery', 'Client discovery file has invalid endpoint data');
    }
    const hostname = host === '::1' ? '[::1]' : host;
    return { url: `http://${hostname}:${port}${path}`, authToken };
  }

  async call(name, args = {}, timeoutMs = 10000) {
    const { url, authToken } = await this.discovery();
    let response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${authToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: 'tools/call', params: { name, arguments: args } }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new BackendError(error.name === 'TimeoutError' ? 'client_timeout' : 'minecraft_unavailable', error.message);
    }
    if (!response.ok) {
      throw new BackendError(response.status === 401 ? 'client_auth_failed' : 'client_http_error', `Client returned HTTP ${response.status}`);
    }
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new BackendError('invalid_client_response', 'Client response was not JSON');
    }
    if (envelope.error) {
      throw new BackendError('client_tool_error', String(envelope.error.message ?? 'Client tool failed'));
    }
    if (envelope.result?.isError || envelope.result?.content?.[0]?.type !== 'text') {
      throw new BackendError('invalid_client_response', 'Client returned an invalid tool result');
    }
    try {
      return JSON.parse(envelope.result.content[0].text);
    } catch {
      throw new BackendError('invalid_client_response', 'Client tool result was not JSON');
    }
  }
}
