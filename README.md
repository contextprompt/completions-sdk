# ContextPrompt Completions SDK

A unified AI SDK that extends OpenAI's interface to support multiple providers (OpenAI, Claude, Gemini) with seamless Model Context Protocol (MCP) integration for external tools.

## Features

- 🔄 **Multi-Provider**: OpenAI, Anthropic Claude, Google Gemini through one interface
- 🔌 **MCP Integration**: Automatic tool discovery and execution from MCP servers
- 🎯 **Drop-in Replacement**: Works with existing OpenAI SDK code
- 🚀 **Zero Config**: Works out-of-the-box with environment variables
- 🔧 **Per-Request MCP Servers**: Configure different MCP servers for individual requests
- 📊 **Real-time Tool Feedback**: Get live updates on tool execution progress
- ⚡ **Dynamic Tool Loading**: Connect MCP servers on-demand for specific conversations

## Installation

```bash
npm install @contextprompt/completions-sdk
```

## Quick Start

```javascript
import OpenAI from '@contextprompt/completions-sdk';

// Works with any supported model
const client = new OpenAI();

// OpenAI
const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Hello!' }]
});

// Claude
const claude = await client.chat.completions.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Explain quantum computing' }]
});

// Gemini
const gemini = await client.chat.completions.create({
  model: 'gemini-pro',
  messages: [{ role: 'user', content: 'Write a poem' }]
});
```

## Environment Setup

```bash
# API Keys (at least one required)
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=AI...

# Optional: Enable debug logging
DEBUG=true
```

## MCP Integration

### Global MCP Servers

Configure MCP servers at the client level for use across all requests:

```javascript
const client = new OpenAI({
  mcpServers: {
    // File system access
    "filesystem": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/docs"]
    },

    // HTTP API
    "api": {
      type: "streamable-http",
      url: "https://api.example.com/mcp",
      headers: { "Authorization": "Bearer ${API_TOKEN}" }
    }
  }
});

// Tools automatically available in conversations
const response = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Search files for "budget" and save summary' }]
  // MCP tools are automatically included and executed
});
```

### Per-Request MCP Servers

Configure MCP servers for individual requests, allowing different tool sets for different conversations:

```javascript
const client = new OpenAI(); // No global MCP servers

// Request with file system tools
const fileResponse = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Analyze the project files' }],
  mcpServers: {
    "filesystem": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/project/src"]
    }
  }
});

// Different request with database tools
const dbResponse = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Query user data' }],
  mcpServers: {
    "database": {
      type: "streamable-http",
      url: "${DB_MCP_SERVER_URL}",
      headers: { "Authorization": "Bearer ${DB_API_KEY}" }
    }
  }
});

// Request with multiple per-request servers
const multiResponse = await client.chat.completions.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Process data and update files' }],
  mcpServers: {
    "data-processor": {
      command: "python",
      args: ["-m", "data_server"],
      env: { "DATA_PATH": "/tmp/data" }
    },
    "file-api": {
      type: "streamable-http",
      url: "http://localhost:3001/mcp"
    }
  }
});
```

### Benefits of Per-Request MCP Servers

- **Request-Specific Tools**: Different conversations can use different tool sets
- **Dynamic Configuration**: Server configs determined at runtime based on user needs
- **Resource Efficiency**: Servers only spun up when needed
- **Automatic Cleanup**: Servers automatically cleaned up after request completion
- **Security**: Limit tool access to specific requests rather than global access

## Supported Models

| Provider | Models |
|----------|--------|
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo` |
| **Claude** | `claude-3-5-sonnet-20241022`, `claude-3-sonnet-20240229`, `claude-3-haiku-20240307`, `claude-3-opus-20240229` |
| **Gemini** | `gemini-pro`, `gemini-pro-vision`, `gemini-1.5-pro`, `gemini-1.5-flash` |

## Advanced Usage

### Manual Tool Control

```javascript
// List available tools from global servers
const tools = await client.listAvailableTools();

// List tools from specific server
const serverTools = await client.listAvailableTools('filesystem');

// Call tools directly
const result = await client.callMCPTool('filesystem', 'read_file', {
  path: '/documents/report.txt'
});

// Server management
const status = await client.getMCPServerStatus();
await client.restartMCPServer('filesystem');
const capabilities = await client.getMCPServerCapabilities('api');
```

### Streaming with Tools and Real-time Feedback

```javascript
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Analyze data and create report' }],
  stream: true,
  toolExecutionFeedback: true, // Enable real-time tool execution events
  mcpServers: {
    "analyzer": {
      type: "streamable-http",
      url: "http://localhost:3002/mcp"
    }
  }
});

for await (const chunk of stream) {
  if (chunk.type === 'tool_execution_event') {
    // Handle tool execution events
    console.log(`Tool Event: ${chunk.event.message}`);
  } else {
    // Handle regular content
    process.stdout.write(chunk.choices[0]?.delta?.content || '');
  }
}
```

### Configuration Options

```javascript
const client = new OpenAI({
  // Basic options
  apiKey: 'sk-...', // Optional if using env vars
  mcpEnabled: true, // Default: true
  timeout: 30000,

  // Global MCP server configuration
  mcpServers: {
    "server-name": {
      // Command-based server
      command: "node",
      args: ["./server.js"],
      env: { "VAR": "value" },

      // OR HTTP-based server
      type: "streamable-http", // or "http"
      url: "http://localhost:3001",
      headers: { "Auth": "${TOKEN}" },
      timeout: 15000
    }
  }
});
```

### Variable Substitution

Both global and per-request MCP servers support environment variable substitution:

```javascript
mcpServers: {
  "dynamic-server": {
    type: "streamable-http",
    url: "${MCP_SERVER_URL}", // Substitutes from process.env.MCP_SERVER_URL
    headers: {
      "Authorization": "Bearer {{API_TOKEN}}" // Alternative syntax
    },
    args: ["--config", "${CONFIG_PATH}"] // Works in command args too
  }
}
```

## Error Handling

```javascript
try {
  const response = await client.chat.completions.create({...});
} catch (error) {
  if (error.code === 'insufficient_quota') {
    console.error('API quota exceeded');
  } else if (error.code?.startsWith('mcp_')) {
    console.error('MCP error:', error.message);
  } else if (error.message.includes('MCP server not found')) {
    console.error('MCP server connection failed');
  }
}
```

## Popular MCP Servers

```bash
# File system access
npx @modelcontextprotocol/server-filesystem /path/to/directory

# Web browsing
npx @modelcontextprotocol/server-puppeteer

# Database queries
npx @modelcontextprotocol/server-sqlite /path/to/database.db

# Git operations
npx @modelcontextprotocol/server-git /path/to/repo

# Brave search
npx @modelcontextprotocol/server-brave-search

# Time/calendar
npx @modelcontextprotocol/server-time
```

## Use Cases

### Request-Specific Tool Access

```javascript
// Customer support: File access + CRM tools
const supportResponse = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Help customer #12345' }],
  mcpServers: {
    "knowledge-base": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/kb"]
    },
    "crm": {
      type: "streamable-http",
      url: "${CRM_MCP_URL}"
    }
  }
});

// Development: Code analysis + Git tools
const devResponse = await client.chat.completions.create({
  model: 'claude-3-5-sonnet-20241022',
  messages: [{ role: 'user', content: 'Review this PR' }],
  mcpServers: {
    "git": {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-git", "/repo"]
    },
    "code-analysis": {
      type: "streamable-http",
      url: "http://localhost:3003/mcp"
    }
  }
});
```

## Documentation

- [Full API Reference](https://github.com/contextprompt/completions-sdk/docs)
- [MCP Server Setup Guide](https://github.com/contextprompt/completions-sdk/docs/mcp-setup)
- [Per-Request MCP Guide](https://github.com/contextprompt/completions-sdk/docs/per-request-mcp)
- [Examples Repository](https://github.com/contextprompt/completions-sdk-examples)

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Need help?** [Create an issue](https://github.com/contextprompt/completions-sdk/issues) or join our [discussions](https://github.com/contextprompt/completions-sdk/discussions).
