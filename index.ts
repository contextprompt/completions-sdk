import OpenAI from "openai";
import dotenv from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { spawn, ChildProcess } from "child_process";
dotenv.config();

// ============================================================================
// TYPES & INTERFACES
// ============================================================================

interface MCPServerDefinition {
  // For command-based servers (spawned processes)
  command?: string;
  args?: string[];

  // For HTTP-based servers
  type?: "http" | "streamable-http";
  url?: string;
  headers?: Record<string, string>;
  timeout?: number;

  // Additional options
  serverInstructions?: boolean;
  env?: Record<string, string>;
}

interface MCPServerConfig {
  [serverName: string]: MCPServerDefinition;
}

interface MCPServerStatus {
  name: string;
  type: "command" | "http" | "streamable-http";
  status: "connected" | "disconnected" | "error" | "starting";
  pid?: number;
  url?: string;
  lastError?: string;
  uptime?: number;
}

interface MCPServerInstance {
  name: string;
  config: MCPServerDefinition;
  type: "command" | "http" | "streamable-http";
  process?: ChildProcess;
  sessionId?: string;
  initialized: boolean;
  lastError?: string;
  startTime?: number;
}

interface ToolExecutionEvent {
  type:
    | "tool_call_detected"
    | "tool_execution_start"
    | "tool_executing"
    | "tool_completed"
    | "tool_error"
    | "tools_completed"
    | "final_response_start";
  message: string;
  toolName?: string;
  tools?: string[];
  progress?: number;
  duration?: number;
  success?: boolean;
  error?: string;
  totalTools?: number;
  successful?: number;
}

// ============================================================================
// CONFIGURATION & UTILITIES
// ============================================================================

const logger = {
  debug: (message, data = {}) => {
    if (process.env.DEBUG === "true") {
      console.debug(`[DEBUG] ${message}`, data);
    }
  },
  info: (message, data = {}) => {
    console.info(`[INFO] ${message}`, data);
  },
  error: (message, error = {}) => {
    console.error(`[ERROR] ${message}`, error);
  },
};

const PROVIDER_CONFIGS = {
  "claude-": {
    name: "Anthropic Claude",
    baseURL: "https://api.anthropic.com/v1/",
    apiKeyEnv: "ANTHROPIC_API_KEY",
  },
  "gemini-": {
    name: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    apiKeyEnv: "GEMINI_API_KEY",
  },
};

const providerClients = new Map();

// ============================================================================
// ENVIRONMENT VARIABLE & TEMPLATE SUBSTITUTION
// ============================================================================

function substituteVariables(value: string): string {
  if (typeof value !== "string") return value;

  // Replace ${VAR} with environment variables
  let result = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return process.env[varName] || match;
  });

  // Replace {{VAR}} with template variables (also from env for now)
  result = result.replace(/\{\{([^}]+)\}\}/g, (match, varName) => {
    return process.env[varName] || match;
  });

  return result;
}

function processServerConfig(config: MCPServerDefinition): MCPServerDefinition {
  const processed: MCPServerDefinition = { ...config };

  // Process URL
  if (processed.url) {
    processed.url = substituteVariables(processed.url);
  }

  // Process headers
  if (processed.headers) {
    processed.headers = Object.fromEntries(
      Object.entries(processed.headers).map(([key, value]) => [
        key,
        substituteVariables(value),
      ]),
    );
  }

  // Process args
  if (processed.args) {
    processed.args = processed.args.map((arg) => substituteVariables(arg));
  }

  return processed;
}

function getProviderConfig(modelName) {
  for (const [prefix, config] of Object.entries(PROVIDER_CONFIGS)) {
    if (modelName.startsWith(prefix)) {
      logger.info(`Model ${modelName} matched provider: ${config.name}`);
      return config;
    }
  }
  logger.info(`Model ${modelName} using default OpenAI provider`);
  return null;
}

function getProviderClient(providerConfig) {
  const key = providerConfig.baseURL;
  if (!providerClients.has(key)) {
    const apiKey = process.env[providerConfig.apiKeyEnv];
    if (!apiKey) {
      throw new Error(
        `Missing API key for ${providerConfig.name}. Please set ${providerConfig.apiKeyEnv} environment variable.`,
      );
    }
    logger.debug(`Creating new client for ${providerConfig.name}`);
    providerClients.set(
      key,
      new OpenAI({ apiKey, baseURL: providerConfig.baseURL }),
    );
  }
  return providerClients.get(key);
}

// ============================================================================
// PROVIDER OPTIMIZATION
// ============================================================================

function optimizeParametersForProvider(options, modelName) {
  const optimized = { ...options };

  if (modelName.startsWith("gemini-")) {
    // Gemini requires max_tokens to be removed for proper content generation
    delete optimized.max_tokens;

    // Ensure stream parameter is properly set for Gemini
    if (optimized.stream) {
      optimized.stream = true;
    }

    logger.debug(
      `Gemini optimization: Removed max_tokens${optimized.stream ? ", configured streaming" : ""}`,
    );
  }

  return optimized;
}

function sanitizeToolSchemaForGemini(tool) {
  const sanitized = JSON.parse(JSON.stringify(tool));
  delete sanitized._mcpServerUrl;

  if (!sanitized.function.parameters) {
    sanitized.function.parameters = {
      type: "object",
      properties: {},
      required: [],
    };
    return sanitized;
  }

  const params = sanitized.function.parameters;

  // Remove JSON Schema metadata that Gemini doesn't like
  delete params.$schema;
  delete params.additionalProperties;

  // Clean nested properties recursively
  function cleanSchemaProperties(obj) {
    if (typeof obj !== "object" || obj === null) return obj;

    const cleaned = {};
    for (const [key, value] of Object.entries(obj)) {
      // Skip problematic JSON Schema keywords
      if (
        [
          "anyOf",
          "oneOf",
          "allOf",
          "not",
          "$ref",
          "const",
          "examples",
          "default",
          "$schema",
          "additionalProperties",
        ].includes(key)
      ) {
        continue;
      }

      if (typeof value === "object" && value !== null) {
        cleaned[key] = Array.isArray(value)
          ? value.map((item) =>
              typeof item === "object" ? cleanSchemaProperties(item) : item,
            )
          : cleanSchemaProperties(value);
      } else {
        cleaned[key] = value;
      }
    }
    return cleaned;
  }

  if (params.properties) {
    params.properties = cleanSchemaProperties(params.properties);
  }

  if (!Array.isArray(params.required)) {
    params.required = [];
  }

  // Ensure basic types for Gemini compatibility
  if (params.properties) {
    for (const [propName, propSchema] of Object.entries(params.properties)) {
      if (
        (propSchema as any).type &&
        !["string", "number", "boolean", "array", "object"].includes(
          (propSchema as any).type,
        )
      ) {
        (propSchema as any).type = "string";
      }
    }
  }

  return sanitized;
}

function optimizeToolsForProvider(tools, modelName) {
  if (!modelName.startsWith("gemini-") || !tools || tools.length === 0) {
    return tools;
  }

  const sanitizedTools = tools.map((tool) => sanitizeToolSchemaForGemini(tool));
  logger.debug(
    `Sanitized ${sanitizedTools.length} tool(s) for Gemini compatibility`,
  );
  console.log(
    `✅ Gemini: Using ${sanitizedTools.length} tool(s) (schema sanitized)`,
  );

  return sanitizedTools;
}

// ============================================================================
// STREAMING NORMALIZATION
// ============================================================================

async function* normalizeStream(stream, modelName) {
  try {
    for await (const chunk of stream) {
      if (modelName.startsWith("claude-")) {
        // Skip Claude ping chunks, pass through others
        if (chunk.type === "ping") continue;
        yield chunk;
      } else {
        // OpenAI and Gemini use the same format
        yield chunk;
      }
    }
  } catch (error) {
    logger.error("Stream processing error:", error);
    throw error;
  }
}

// ============================================================================
// MAIN SDK CLASS
// ============================================================================

class MultiProviderOpenAI extends OpenAI {
  mcpServersConfig: MCPServerConfig;
  mcpEnabled: boolean;
  mcpServerInstances: Map<string, MCPServerInstance>;
  mcpToolsCache: any;
  mcpLastCacheTime: number;
  CACHE_DURATION: number;
  toolToServerMap: Map<string, string>;
  originalOpenAIOptions: any;
  mcpInitializationPromise: Promise<any>;
  mcpClient: any;

  constructor(options: any = {}) {
    super({ apiKey: process.env["OPENAI_API_KEY"], ...options });

    // MCP configuration - support both new and legacy formats
    this.mcpServersConfig = options.mcpServers || {};

    // Legacy support for mcpServerUrls
    if (options.mcpServerUrls && Array.isArray(options.mcpServerUrls)) {
      options.mcpServerUrls.forEach((url: string, index: number) => {
        this.mcpServersConfig[`legacy_server_${index}`] = {
          type: "streamable-http",
          url: url,
        };
      });
    }

    // Legacy support for single mcpServerUrl
    if (options.mcpServerUrl && typeof options.mcpServerUrl === "string") {
      this.mcpServersConfig["legacy_server"] = {
        type: "streamable-http",
        url: options.mcpServerUrl,
      };
    }

    this.mcpEnabled = options.mcpEnabled !== false;
    this.mcpServerInstances = new Map();
    this.mcpToolsCache = null;
    this.mcpLastCacheTime = 0;
    this.CACHE_DURATION = 30000;
    this.toolToServerMap = new Map();
    this.originalOpenAIOptions = {
      apiKey: process.env["OPENAI_API_KEY"],
      ...options,
    };

    // Initialize MCP and override chat completions
    this.mcpInitializationPromise = this.initializeMCP().catch((error) => {
      logger.error("MCP initialization failed:", error.message);
      return Promise.resolve();
    });

    this._overrideChatCompletions();
  }

  _overrideChatCompletions() {
    const originalChat = this.chat;
    (this.chat as any) = {
      ...originalChat,
      completions: {
        ...originalChat.completions,
        create: async (options: any) => this.createWithMCPTools(options),
        createWithMCPTools: async (options: any) =>
          this.createWithMCPTools(options),
      },
    };
  }

  // ============================================================================
  // MCP METHODS
  // ============================================================================

  async ensureMCPInitialized() {
    if (this.mcpInitializationPromise) {
      logger.debug("Waiting for MCP initialization to complete");
      await this.mcpInitializationPromise;
      logger.debug("MCP initialization completed");
    }
  }

  async initializeMCP() {
    if (!this.mcpEnabled || Object.keys(this.mcpServersConfig).length === 0)
      return;

    try {
      this.mcpClient = new Client(
        { name: "multi-agent-client", version: "1.0.0" },
        { capabilities: { tools: {} } },
      );

      const serverNames = Object.keys(this.mcpServersConfig);
      logger.debug(`Initializing ${serverNames.length} MCP servers`);

      const initPromises = serverNames.map((serverName) =>
        this._initializeMCPServer(serverName),
      );
      await Promise.allSettled(initPromises);

      const connectedServers = Array.from(
        this.mcpServerInstances.entries(),
      ).filter(([, instance]) => instance.initialized);

      if (connectedServers.length > 0) {
        try {
          const tools = await this._getMCPToolsInternal();
          if (tools.length > 0) {
            console.log(
              `🔌 Connected to ${connectedServers.length} MCP server(s)`,
            );
            this._displayToolList(tools);
          } else {
            logger.debug(
              `Connected to ${connectedServers.length} MCP servers but no tools available`,
            );
          }
        } catch (error) {
          logger.debug(`Failed to display MCP tools: ${error.message}`);
        }
      } else {
        logger.debug("No MCP servers connected");
      }
    } catch (error) {
      logger.error("Failed to initialize MCP", { error: error.message });
    }
  }

  async _initializeMCPServer(serverName: string) {
    const config = this.mcpServersConfig[serverName];
    if (!config) {
      logger.error(`Server configuration not found: ${serverName}`);
      return;
    }

    const processedConfig = processServerConfig(config);
    const serverType = this._getServerType(processedConfig);

    const instance: MCPServerInstance = {
      name: serverName,
      config: processedConfig,
      type: serverType,
      initialized: false,
      startTime: Date.now(),
    };

    this.mcpServerInstances.set(serverName, instance);

    try {
      if (serverType === "command") {
        await this._initializeCommandServer(instance);
      } else {
        await this._initializeHttpServer(instance);
      }
    } catch (error) {
      instance.lastError = error.message;
      logger.debug(`Failed to initialize ${serverName}: ${error.message}`);
    }
  }

  _getServerType(
    config: MCPServerDefinition,
  ): "command" | "http" | "streamable-http" {
    if (config.command) {
      return "command";
    } else if (config.type) {
      return config.type;
    } else if (config.url) {
      return "streamable-http"; // Default for URL-based servers
    }
    throw new Error(
      "Invalid server configuration: must specify either command or url/type",
    );
  }

  async _initializeCommandServer(instance: MCPServerInstance) {
    const { config, name } = instance;

    logger.debug(`Starting command-based MCP server: ${name}`);

    const args = config.args || [];
    const env = { ...process.env, ...config.env };

    const childProcess = spawn(config.command!, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    instance.process = childProcess;

    // Wait for the process to start
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(
          new Error(`Command server ${name} failed to start within timeout`),
        );
      }, 10000);

      childProcess.on("spawn", () => {
        clearTimeout(timeout);
        instance.initialized = true;
        logger.debug(
          `Command MCP server ${name} started with PID ${childProcess.pid}`,
        );
        resolve(void 0);
      });

      childProcess.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
    });
  }

  async _initializeHttpServer(instance: MCPServerInstance) {
    const { config, name, type } = instance;

    logger.debug(`Initializing HTTP MCP server: ${name} (${type})`);

    try {
      const response = await this._mcpRequest(name, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "multi-agent-client", version: "1.0.0" },
      });

      const sessionId = response.response?.headers?.get?.("mcp-session-id");

      if (response.data.result) {
        try {
          await this._mcpRequest(
            name,
            "notifications/initialized",
            {},
            sessionId,
          );
        } catch (error) {
          logger.debug(`Notification failed but continuing: ${error.message}`);
        }

        instance.sessionId = sessionId;
        instance.initialized = true;
        logger.debug(`HTTP MCP server ${name} initialized`);
      }
    } catch (error) {
      throw new Error(
        `Failed to initialize HTTP server ${name}: ${error.message}`,
      );
    }
  }

  async _mcpRequest(
    serverName: string,
    method: string,
    params = {},
    sessionId = null,
    customInstance?: MCPServerInstance,
  ) {
    const instance = customInstance || this.mcpServerInstances.get(serverName);
    if (!instance) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    if (instance.type === "command") {
      throw new Error(
        `Direct MCP requests not supported for command-based servers: ${serverName}`,
      );
    }

    const url = instance.config.url!;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(sessionId && { "mcp-session-id": sessionId }),
      ...(instance.config.headers || {}),
    };

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: Date.now(),
        method,
        ...(Object.keys(params).length > 0 && { params }),
      }),
      signal: instance.config.timeout
        ? AbortSignal.timeout(instance.config.timeout)
        : undefined,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const text = await response.text();
    const lines = text.trim().split("\n");
    const dataLine = lines
      .find((line) => line.startsWith("data: "))
      ?.substring(6);

    if (!dataLine) {
      throw new Error(`Invalid SSE response format: ${text}`);
    }

    const data = JSON.parse(dataLine);
    if (data.error) {
      throw new Error(`MCP Error: ${data.error.message}`);
    }

    return { data, response };
  }

  async getMCPTools() {
    await this.ensureMCPInitialized();

    const now = Date.now();
    if (
      this.mcpToolsCache &&
      now - this.mcpLastCacheTime < this.CACHE_DURATION
    ) {
      return this.mcpToolsCache;
    }

    if (!this.mcpEnabled || this.mcpServerInstances.size === 0) {
      logger.debug(
        `getMCPTools: enabled=${this.mcpEnabled}, servers=${this.mcpServerInstances.size}`,
      );
      return [];
    }

    const allTools = await this._getMCPToolsInternal();
    this.mcpToolsCache = allTools;
    this.mcpLastCacheTime = now;

    return allTools;
  }

  async _getMCPToolsInternal() {
    const allTools = [];
    this.toolToServerMap.clear();

    for (const [serverName, instance] of this.mcpServerInstances.entries()) {
      if (!instance.initialized) continue;

      try {
        if (instance.type === "command") {
          // For command-based servers, we'd need to implement stdio communication
          logger.debug(
            `Command-based servers not yet implemented for ${serverName}`,
          );
          continue;
        }

        const { data } = await this._mcpRequest(
          serverName,
          "tools/list",
          {},
          instance.sessionId,
        );
        const tools = data.result?.tools || [];

        logger.debug(`Retrieved ${tools.length} tools from ${serverName}`);

        const formattedTools = tools.map((tool) => {
          this.toolToServerMap.set(tool.name, serverName);
          return {
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
            _mcpServerName: serverName,
          };
        });

        allTools.push(...formattedTools);
      } catch (error) {
        logger.debug(
          `Failed to get tools from ${serverName}: ${error.message}`,
        );
      }
    }

    logger.debug(
      `Retrieved ${allTools.length} total tools from ${this.mcpServerInstances.size} servers`,
    );
    return allTools;
  }

  _displayToolList(tools) {
    console.log(`🛠️  Available MCP tools (${tools.length}):`);
    tools.forEach((tool, index) => {
      console.log(
        `  ${index + 1}. ${tool.function.name} - ${tool.function.description}`,
      );
    });
    console.log("");
  }

  // Legacy method signature
  async callMCPTool(name: string, args: any): Promise<any>;
  // New method signature with server name
  async callMCPTool(
    serverName: string,
    toolName: string,
    args: any,
  ): Promise<any>;
  async callMCPTool(
    nameOrServer: string,
    argsOrToolName: any,
    args?: any,
  ): Promise<any> {
    // Determine which signature is being used
    if (args !== undefined) {
      // New signature: callMCPTool(serverName, toolName, args)
      return this._callToolOnServer(nameOrServer, argsOrToolName, args);
    } else {
      // Legacy signature: callMCPTool(toolName, args)
      return this._callToolByName(nameOrServer, argsOrToolName);
    }
  }

  private async _callToolByName(toolName: string, args: any): Promise<any> {
    const serverName = this.toolToServerMap?.get(toolName);
    if (!serverName) {
      throw new Error(`Tool ${toolName} not found on any connected MCP server`);
    }
    return this._callToolOnServer(serverName, toolName, args);
  }

  private async _callToolOnServer(
    serverName: string,
    toolName: string,
    args: any,
  ): Promise<any> {
    const instance = this.mcpServerInstances.get(serverName);
    if (!instance) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    if (!instance.initialized) {
      throw new Error(`Server ${serverName} is not initialized`);
    }

    try {
      if (instance.type === "command") {
        throw new Error(
          `Command-based tool calling not yet implemented for ${serverName}`,
        );
      }

      const { data } = await this._mcpRequest(
        serverName,
        "tools/call",
        { name: toolName, arguments: args },
        instance.sessionId,
      );
      logger.debug(`Tool ${toolName} called successfully on ${serverName}`);
      return data.result;
    } catch (error) {
      logger.error(
        `Failed to call tool ${toolName} on ${serverName}: ${error.message}`,
      );
      throw error;
    }
  }

  // New methods from README
  async listAvailableTools(serverName?: string): Promise<any[]> {
    if (serverName) {
      return this._getToolsFromServer(serverName);
    }
    return this.getMCPTools();
  }

  private async _getToolsFromServer(serverName: string): Promise<any[]> {
    const instance = this.mcpServerInstances.get(serverName);
    if (!instance) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    if (!instance.initialized) {
      throw new Error(`Server ${serverName} is not initialized`);
    }

    if (instance.type === "command") {
      throw new Error(
        `Tool listing not yet implemented for command-based servers: ${serverName}`,
      );
    }

    try {
      const { data } = await this._mcpRequest(
        serverName,
        "tools/list",
        {},
        instance.sessionId,
      );
      const tools = data.result?.tools || [];

      return tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
        _mcpServerName: serverName,
      }));
    } catch (error) {
      logger.error(`Failed to get tools from ${serverName}: ${error.message}`);
      throw error;
    }
  }

  async getMCPServerStatus(
    serverName?: string,
  ): Promise<MCPServerStatus | MCPServerStatus[]> {
    if (serverName) {
      return this._getServerStatus(serverName);
    }

    const statuses: MCPServerStatus[] = [];
    for (const [name, instance] of this.mcpServerInstances.entries()) {
      statuses.push(this._getServerStatus(name));
    }
    return statuses;
  }

  private _getServerStatus(serverName: string): MCPServerStatus {
    const instance = this.mcpServerInstances.get(serverName);
    if (!instance) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    const status: MCPServerStatus = {
      name: serverName,
      type: instance.type,
      status: instance.initialized
        ? "connected"
        : instance.lastError
          ? "error"
          : "disconnected",
      lastError: instance.lastError,
      uptime: instance.startTime ? Date.now() - instance.startTime : undefined,
    };

    if (instance.type === "command" && instance.process) {
      status.pid = instance.process.pid;
    } else if (instance.type !== "command") {
      status.url = instance.config.url;
    }

    return status;
  }

  async restartMCPServer(serverName: string): Promise<void> {
    const instance = this.mcpServerInstances.get(serverName);
    if (!instance) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    logger.info(`Restarting MCP server: ${serverName}`);

    // Stop the current instance
    if (instance.type === "command" && instance.process) {
      instance.process.kill();
    }

    // Reset instance state
    instance.initialized = false;
    instance.lastError = undefined;
    instance.startTime = Date.now();

    // Restart
    await this._initializeMCPServer(serverName);
  }

  async getMCPServerCapabilities(serverName: string): Promise<any> {
    const instance = this.mcpServerInstances.get(serverName);
    if (!instance) {
      throw new Error(`MCP server not found: ${serverName}`);
    }

    if (!instance.initialized) {
      throw new Error(`Server ${serverName} is not initialized`);
    }

    if (instance.type === "command") {
      throw new Error(
        `Capabilities querying not yet implemented for command-based servers: ${serverName}`,
      );
    }

    try {
      const { data } = await this._mcpRequest(
        serverName,
        "initialize",
        {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          clientInfo: { name: "multi-agent-client", version: "1.0.0" },
        },
        instance.sessionId,
      );
      return data.result?.capabilities || {};
    } catch (error) {
      logger.error(
        `Failed to get capabilities from ${serverName}: ${error.message}`,
      );
      throw error;
    }
  }

  // ============================================================================
  // PER-REQUEST MCP SERVER METHODS
  // ============================================================================

  async _initializePerRequestServers(
    mcpServersConfig: MCPServerConfig,
  ): Promise<Map<string, MCPServerInstance>> {
    const perRequestServers = new Map<string, MCPServerInstance>();

    for (const [serverName, config] of Object.entries(mcpServersConfig)) {
      const tempServerName = `temp_${serverName}_${Date.now()}`;
      const processedConfig = processServerConfig(config);
      const serverType = this._getServerType(processedConfig);

      const instance: MCPServerInstance = {
        name: tempServerName,
        config: processedConfig,
        type: serverType,
        initialized: false,
        startTime: Date.now(),
      };

      perRequestServers.set(tempServerName, instance);

      try {
        if (serverType === "command") {
          await this._initializeCommandServer(instance);
        } else {
          await this._initializeHttpServer(instance);
        }
        logger.debug(
          `Per-request server ${tempServerName} initialized successfully`,
        );
      } catch (error) {
        instance.lastError = error.message;
        logger.debug(
          `Failed to initialize per-request server ${tempServerName}: ${error.message}`,
        );
      }
    }

    return perRequestServers;
  }

  async _getToolsFromPerRequestServers(
    perRequestServers: Map<string, MCPServerInstance>,
  ): Promise<any[]> {
    const allTools = [];

    for (const [serverName, instance] of perRequestServers.entries()) {
      if (!instance.initialized) continue;

      try {
        if (instance.type === "command") {
          logger.debug(
            `Command-based servers not yet implemented for per-request ${serverName}`,
          );
          continue;
        }

        const { data } = await this._mcpRequest(
          serverName,
          "tools/list",
          {},
          instance.sessionId,
          instance,
        );
        const tools = data.result?.tools || [];

        logger.debug(
          `Retrieved ${tools.length} tools from per-request server ${serverName}`,
        );

        const formattedTools = tools.map((tool) => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
          _mcpServerName: serverName,
          _isPerRequest: true,
        }));

        allTools.push(...formattedTools);
      } catch (error) {
        logger.debug(
          `Failed to get tools from per-request server ${serverName}: ${error.message}`,
        );
      }
    }

    return allTools;
  }

  _cleanupPerRequestServers(perRequestServers: Map<string, MCPServerInstance>) {
    for (const [serverName, instance] of perRequestServers.entries()) {
      if (instance.type === "command" && instance.process) {
        instance.process.kill();
        logger.debug(`Cleaned up per-request command server ${serverName}`);
      }
    }
  }

  async _callToolWithServers(
    toolName: string,
    args: any,
    perRequestServers: Map<string, MCPServerInstance>,
  ): Promise<any> {
    // First, check if the tool is from a per-request server
    for (const [serverName, instance] of perRequestServers.entries()) {
      if (!instance.initialized) continue;

      try {
        if (instance.type === "command") {
          continue; // Skip command servers for now
        }

        // Check if this server has the tool (we could cache this, but for simplicity...)
        const { data } = await this._mcpRequest(
          serverName,
          "tools/list",
          {},
          instance.sessionId,
          instance,
        );
        const tools = data.result?.tools || [];
        const hasTool = tools.some((tool) => tool.name === toolName);

        if (hasTool) {
          const result = await this._mcpRequest(
            serverName,
            "tools/call",
            { name: toolName, arguments: args },
            instance.sessionId,
            instance,
          );
          logger.debug(
            `Tool ${toolName} called successfully on per-request server ${serverName}`,
          );
          return result.data.result;
        }
      } catch (error) {
        logger.debug(
          `Failed to call tool ${toolName} on per-request server ${serverName}: ${error.message}`,
        );
      }
    }

    // Fall back to global servers
    return this._callToolByName(toolName, args);
  }

  // ============================================================================
  // CORE COMPLETION METHODS
  // ============================================================================

  async createChatCompletion(options) {
    const modelName = options.model;
    const providerConfig = getProviderConfig(modelName);
    const optimizedOptions = optimizeParametersForProvider(options, modelName);

    if (providerConfig) {
      logger.debug(`Routing request to ${providerConfig.name}`, {
        model: modelName,
        streaming: !!optimizedOptions.stream,
      });
      const client = getProviderClient(providerConfig);
      const response = await client.chat.completions.create(optimizedOptions);

      return optimizedOptions.stream
        ? normalizeStream(response, modelName)
        : response;
    } else {
      logger.debug(`Routing request to OpenAI`, {
        model: modelName,
        streaming: !!optimizedOptions.stream,
      });
      const openaiClient = new OpenAI(this.originalOpenAIOptions);
      const response =
        await openaiClient.chat.completions.create(optimizedOptions);

      return optimizedOptions.stream
        ? normalizeStream(response, modelName)
        : response;
    }
  }

  async createWithMCPTools(options) {
    // Handle per-request MCP servers
    let perRequestServers = new Map();

    try {
      logger.debug("Starting createWithMCPTools");

      let perRequestTools = [];

      if (options.mcpServers) {
        logger.debug("Initializing per-request MCP servers");
        perRequestServers = await this._initializePerRequestServers(
          options.mcpServers,
        );
        perRequestTools =
          await this._getToolsFromPerRequestServers(perRequestServers);
        logger.debug(
          `Got ${perRequestTools.length} tools from per-request servers`,
        );
      }

      // Get global MCP tools
      const globalMcpTools = await this.getMCPTools();
      logger.debug(`Got ${globalMcpTools.length} global MCP tools`);

      const userTools = options.tools || [];
      const allTools = [...userTools, ...globalMcpTools, ...perRequestTools];

      const enhancedOptions = { ...options };
      // Remove custom options from the request (not part of OpenAI API)
      delete enhancedOptions.mcpServers;
      delete enhancedOptions.toolExecutionFeedback;

      if (allTools.length > 0) {
        enhancedOptions.tools = optimizeToolsForProvider(
          allTools,
          options.model,
        );
        enhancedOptions.tool_choice = options.tool_choice || "auto";
        logger.debug(
          `Enhanced request with ${enhancedOptions.tools.length} tools`,
        );
      } else if (options.tool_choice) {
        delete enhancedOptions.tool_choice;
        logger.debug("No tools available, removed tool_choice");
      }

      // Handle streaming requests with tool execution
      if (options.stream) {
        logger.debug("Streaming request with tool execution support");
        return this._createStreamingWithTools(
          enhancedOptions,
          perRequestServers,
          options.toolExecutionFeedback,
        );
      }

      // Handle non-streaming requests
      const response = await this.createChatCompletion(enhancedOptions);
      logger.debug("Got response from LLM, processing tool calls");

      // Process tool calls for non-streaming
      if (response.choices?.[0]?.message?.tool_calls) {
        return await this._processToolCalls(
          response,
          options,
          perRequestServers,
        );
      }

      logger.debug("createWithMCPTools completed successfully");
      return response;
    } catch (error) {
      logger.error("Failed to create completion with MCP tools", {
        error: error.message,
      });
      throw error;
    } finally {
      // Cleanup per-request servers
      if (perRequestServers.size > 0) {
        this._cleanupPerRequestServers(perRequestServers);
      }
    }
  }

  // Enhanced streaming with tool execution feedback
  async *_createStreamingWithTools(
    options,
    perRequestServers = new Map(),
    toolExecutionFeedback = false,
  ) {
    logger.debug("Starting streaming with tool execution");

    // Start initial streaming request
    const initialStream = await this.createChatCompletion(options);

    let assistantMessage = {
      role: "assistant",
      content: "",
      tool_calls: [],
    };

    let toolCallsBuffer = new Map(); // index -> partial tool call
    let hasToolCalls = false;

    // Stream initial response and collect tool calls
    for await (const chunk of initialStream) {
      // Yield content chunks immediately
      if (chunk.choices?.[0]?.delta?.content) {
        assistantMessage.content += chunk.choices[0].delta.content;
        yield chunk;
      }

      // Collect tool calls
      if (chunk.choices?.[0]?.delta?.tool_calls) {
        hasToolCalls = true;

        // Emit tool call detected event if feedback enabled
        if (toolExecutionFeedback && toolCallsBuffer.size === 0) {
          yield {
            type: "tool_execution_event",
            event: {
              type: "tool_call_detected",
              message: "Tool calls detected, preparing to execute...",
            },
          };
        }

        for (const toolCallDelta of chunk.choices[0].delta.tool_calls) {
          const index = toolCallDelta.index;

          if (!toolCallsBuffer.has(index)) {
            toolCallsBuffer.set(index, {
              id: toolCallDelta.id || `call_${Date.now()}_${index}`,
              type: "function",
              function: {
                name: toolCallDelta.function?.name || "",
                arguments: toolCallDelta.function?.arguments || "",
              },
            });
          } else {
            const existing = toolCallsBuffer.get(index);
            // Update ID if provided
            if (toolCallDelta.id) {
              existing.id = toolCallDelta.id;
            }
            // Append function name
            if (toolCallDelta.function?.name) {
              existing.function.name += toolCallDelta.function.name;
            }
            // Append function arguments
            if (toolCallDelta.function?.arguments) {
              existing.function.arguments += toolCallDelta.function.arguments;
            }
          }
        }

        // Yield tool call chunks
        yield chunk;
      }

      // Handle finish reason
      if (chunk.choices?.[0]?.finish_reason) {
        yield chunk;
      }
    }

    // If no tool calls, we're done
    if (!hasToolCalls) {
      logger.debug("No tool calls detected, streaming complete");
      return;
    }

    // Convert to array and validate
    assistantMessage.tool_calls = Array.from(toolCallsBuffer.values()).filter(
      (toolCall) => {
        // Ensure all tool calls have valid data
        if (!toolCall.id || !toolCall.function.name) {
          logger.error(`Invalid tool call: missing ID or name`, toolCall);
          return false;
        }
        return true;
      },
    );

    if (assistantMessage.tool_calls.length === 0) {
      logger.debug("No valid tool calls found after filtering");
      return;
    }

    logger.debug(`Executing ${assistantMessage.tool_calls.length} tool calls`);

    // Emit tool execution start event
    if (toolExecutionFeedback) {
      yield {
        type: "tool_execution_event",
        event: {
          type: "tool_execution_start",
          message: `Executing ${assistantMessage.tool_calls.length} tool(s)...`,
          tools: assistantMessage.tool_calls.map((tc) => tc.function.name),
          totalTools: assistantMessage.tool_calls.length,
        },
      };
    }

    const toolResults = [];
    for (const [index, toolCall] of assistantMessage.tool_calls.entries()) {
      // Emit tool executing event
      if (toolExecutionFeedback) {
        yield {
          type: "tool_execution_event",
          event: {
            type: "tool_executing",
            message: `Executing ${toolCall.function.name}... (${index + 1}/${assistantMessage.tool_calls.length})`,
            toolName: toolCall.function.name,
            progress: (index + 1) / assistantMessage.tool_calls.length,
          },
        };
      }

      try {
        logger.debug(`Executing tool: ${toolCall.function.name}`, {
          id: toolCall.id,
          arguments: toolCall.function.arguments.substring(0, 100) + "...",
        });

        let args;
        try {
          // Validate JSON completeness before parsing
          if (
            !toolCall.function.arguments ||
            toolCall.function.arguments.trim() === ""
          ) {
            throw new Error("Empty arguments");
          }
          args = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          logger.error(
            `Failed to parse tool arguments for ${toolCall.function.name}:`,
            {
              error: parseError.message,
              arguments: toolCall.function.arguments,
            },
          );
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            content: `Error: Invalid tool arguments - ${parseError.message}`,
          });

          // Emit tool error event
          if (toolExecutionFeedback) {
            yield {
              type: "tool_execution_event",
              event: {
                type: "tool_error",
                message: `❌ ${toolCall.function.name} failed: Invalid arguments`,
                toolName: toolCall.function.name,
                error: parseError.message,
                success: false,
              },
            };
          }
          continue;
        }

        if (this.toolToServerMap.has(toolCall.function.name)) {
          if (
            this.mcpEnabled &&
            this.mcpClient &&
            this.mcpServerInstances.size > 0
          ) {
            const startTime = Date.now();
            const result = await this._callToolWithServers(
              toolCall.function.name,
              args,
              perRequestServers,
            );
            const duration = Date.now() - startTime;

            // Extract content safely from various possible result structures
            let content = JSON.stringify(result);
            try {
              if (result.content && Array.isArray(result.content) && result.content[0]?.text) {
                content = result.content[0].text;
              } else if (typeof result.content === 'string') {
                content = result.content;
              } else if (typeof result === 'string') {
                content = result;
              }
            } catch (e) {
              // Fallback to JSON string
              content = JSON.stringify(result);
            }

            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: content,
            });

            // Emit tool completed event
            if (toolExecutionFeedback) {
              yield {
                type: "tool_execution_event",
                event: {
                  type: "tool_completed",
                  message: `✅ ${toolCall.function.name} completed (${duration}ms)`,
                  toolName: toolCall.function.name,
                  duration,
                  success: true,
                },
              };
            }

            logger.debug(
              `Tool ${toolCall.function.name} completed successfully`,
            );
          } else {
            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: `Tool ${toolCall.function.name} is not available (MCP server not connected)`,
            });
          }
        } else {
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            content: `Tool ${toolCall.function.name} requires external execution`,
          });
        }
      } catch (error) {
        logger.error(`Tool call failed: ${toolCall.function.name}`, {
          error: error.message,
        });
        toolResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          content: `Error: ${error.message}`,
        });

        // Emit tool error event
        if (toolExecutionFeedback) {
          yield {
            type: "tool_execution_event",
            event: {
              type: "tool_error",
              message: `❌ ${toolCall.function.name} failed: ${error.message}`,
              toolName: toolCall.function.name,
              error: error.message,
              success: false,
            },
          };
        }
      }
    }

    // Only proceed with follow-up if we have valid tool results
    if (toolResults.length === 0) {
      logger.debug("No tool results to process");
      return;
    }

    // Emit tools completed event
    if (toolExecutionFeedback) {
      const successful = toolResults.filter(
        (r) => !r.content.startsWith("Error:"),
      ).length;
      yield {
        type: "tool_execution_event",
        event: {
          type: "tools_completed",
          message: "All tools completed. Generating final response...",
          totalTools: assistantMessage.tool_calls.length,
          successful,
        },
      };
    }

    // Make follow-up streaming request with tool results
    logger.debug("Making follow-up streaming request with tool results");

    const followUpOptions = {
      ...options,
      messages: [...options.messages, assistantMessage, ...toolResults],
    };

    // Remove tools from follow-up to prevent infinite loops
    delete followUpOptions.tools;
    delete followUpOptions.tool_choice;

    // Emit final response start event
    if (toolExecutionFeedback) {
      yield {
        type: "tool_execution_event",
        event: {
          type: "final_response_start",
          message: "Generating final response based on tool results...",
        },
      };
    }

    const followUpStream = await this.createChatCompletion(followUpOptions);

    // Stream the follow-up response
    for await (const chunk of followUpStream) {
      yield chunk;
    }

    logger.debug("Streaming with tool execution completed");
  }

  async _processToolCalls(
    response,
    originalOptions,
    perRequestServers = new Map(),
  ) {
    logger.debug(
      `Processing ${response.choices[0].message.tool_calls.length} tool calls`,
    );

    const toolResults = [];
    for (const toolCall of response.choices[0].message.tool_calls) {
      try {
        logger.info(`Calling tool: ${toolCall.function.name}`);

        let args;
        try {
          args = JSON.parse(toolCall.function.arguments);
        } catch (parseError) {
          logger.error(`Failed to parse tool arguments: ${parseError.message}`);
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            content: `Error: Invalid tool arguments - ${parseError.message}`,
          });
          continue;
        }

        if (this.toolToServerMap.has(toolCall.function.name)) {
          if (
            this.mcpEnabled &&
            this.mcpClient &&
            this.mcpServerInstances.size > 0
          ) {
            const result = await this._callToolWithServers(
              toolCall.function.name,
              args,
              perRequestServers,
            );
            // Extract content safely from various possible result structures
            let content = JSON.stringify(result);
            try {
              if (result.content && Array.isArray(result.content) && result.content[0]?.text) {
                content = result.content[0].text;
              } else if (typeof result.content === 'string') {
                content = result.content;
              } else if (typeof result === 'string') {
                content = result;
              }
            } catch (e) {
              // Fallback to JSON string
              content = JSON.stringify(result);
            }

            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: content,
            });
            logger.debug(
              `Tool ${toolCall.function.name} completed successfully`,
            );
          } else {
            toolResults.push({
              tool_call_id: toolCall.id,
              role: "tool",
              content: `Tool ${toolCall.function.name} is not available (MCP server not connected)`,
            });
          }
        } else {
          toolResults.push({
            tool_call_id: toolCall.id,
            role: "tool",
            content: `Tool ${toolCall.function.name} requires external execution`,
          });
        }
      } catch (error) {
        logger.error(`Tool call failed: ${toolCall.function.name}`, {
          error: error.message,
        });
        toolResults.push({
          tool_call_id: toolCall.id,
          role: "tool",
          content: `Error: ${error.message}`,
        });
      }
    }

    response._mcpToolResults = toolResults;
    logger.debug("Tool results added to response");

    // Generate follow-up response
    if (toolResults.length > 0) {
      logger.debug("Making follow-up request with tool results");

      const followUpOptions = {
        ...originalOptions,
        messages: [
          ...originalOptions.messages,
          response.choices[0].message,
          ...toolResults,
        ],
      };

      delete followUpOptions.tools;
      delete followUpOptions.tool_choice;

      const followUpResponse = await this.createChatCompletion(followUpOptions);
      followUpResponse._mcpToolResults = toolResults;
      followUpResponse._originalToolCalls =
        response.choices[0].message.tool_calls;

      return followUpResponse;
    }

    return response;
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

export default MultiProviderOpenAI;
export { MultiProviderOpenAI as OpenAI };

// CommonJS compatibility
if (typeof module !== "undefined" && module.exports) {
  module.exports = MultiProviderOpenAI;
  module.exports.default = MultiProviderOpenAI;
  module.exports.OpenAI = MultiProviderOpenAI;
}
