# ContextPrompt Completions SDK

A unified AI SDK that extends OpenAI's interface to support multiple providers (OpenAI, Claude, Gemini) with seamless Model Context Protocol (MCP) integration for external tools.

## Features

- 🔄 **Multi-Provider**: OpenAI, Anthropic Claude, Google Gemini through one interface
- 🔌 **MCP Integration**: Automatic tool discovery and execution from MCP servers
- 🎯 **Drop-in Replacement**: Works with existing OpenAI SDK code
- 🚀 **Zero Config**: Works out-of-the-box with environment variables
- 🔧 **Per-Request MCP Servers**: Configure different MCP servers for individual requests
- 📊 **Real-time Tool Feedback**: Get live updates on tool execution progress

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

Add external tools to your AI conversations:

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

## Supported Models

| Provider | Models |
|----------|--------|
| **OpenAI** | `gpt-4o`, `gpt-4o-mini`, `gpt-4-turbo`, `gpt-3.5-turbo` |
| **Claude** | `claude-3-5-sonnet-20241022`, `claude-3-sonnet-20240229`, `claude-3-haiku-20240307`, `claude-3-opus-20240229` |
| **Gemini** | `gemini-pro`, `gemini-pro-vision`, `gemini-1.5-pro`, `gemini-1.5-flash` |

## Advanced Usage

### Manual Tool Control

```javascript
// List available tools
const tools = await client.listAvailableTools();

// Call tools directly
const result = await client.callMCPTool('filesystem', 'read_file', {
  path: '/documents/report.txt'
});

// Server management
const status = await client.getMCPServerStatus();
await client.restartMCPServer('filesystem');
```

### Streaming with Tools

```javascript
const stream = await client.chat.completions.create({
  model: 'gpt-4o',
  messages: [{ role: 'user', content: 'Analyze data and create report' }],
  stream: true
});

for await (const chunk of stream) {
  process.stdout.write(chunk.choices[0]?.delta?.content || '');
}
```

### Configuration Options

```javascript
const client = new OpenAI({
  // Basic options
  apiKey: 'sk-...', // Optional if using env vars
  mcpEnabled: true, // Default: true
  timeout: 30000,

  // MCP server configuration
  mcpServers: {
    "server-name": {
      // Command-based server
      command: "node",
      args: ["./server.js"],
      env: { "VAR": "value" },

      // OR HTTP-based server
      type: "streamable-http",
      url: "http://localhost:3001",
      headers: { "Auth": "${TOKEN}" },
      timeout: 15000
    }
  }
});
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
```

## Documentation

- [Full API Reference](https://github.com/contextprompt/completions-sdk/docs)
- [MCP Server Setup Guide](https://github.com/contextprompt/completions-sdk/docs/mcp-setup)
- [Examples Repository](https://github.com/contextprompt/completions-sdk-examples)

## License

MIT License - see [LICENSE](LICENSE) file for details.

---

**Need help?** [Create an issue](https://github.com/contextprompt/completions-sdk/issues) or join our [discussions](https://github.com/contextprompt/completions-sdk/discussions).
