import { query, type SDKMessage } from '@anthropic-ai/claude-code';
import { ConversationSession } from './types';
import { Logger } from './logger';
import { McpManager, McpServerConfig } from './mcp-manager';
import * as path from 'path';
import * as fs from 'fs';

const SESSIONS_FILE = path.join(__dirname, '..', 'sessions.json');

export class ClaudeHandler {
  private sessions: Map<string, ConversationSession> = new Map();
  private logger = new Logger('ClaudeHandler');
  private mcpManager: McpManager;

  constructor(mcpManager: McpManager) {
    this.mcpManager = mcpManager;
    this.loadSessions();
  }

  private saveSessions(): void {
    try {
      const data: Record<string, any> = {};
      for (const [key, session] of this.sessions.entries()) {
        if (session.sessionId) {
          data[key] = {
            userId: session.userId,
            channelId: session.channelId,
            threadTs: session.threadTs,
            sessionId: session.sessionId,
            isActive: session.isActive,
            lastActivity: session.lastActivity.toISOString(),
            workingDirectory: session.workingDirectory,
          };
        }
      }
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2));
      this.logger.debug('Saved sessions to disk', { count: Object.keys(data).length });
    } catch (error) {
      this.logger.error('Failed to save sessions to disk', error);
    }
  }

  private loadSessions(): void {
    try {
      if (!fs.existsSync(SESSIONS_FILE)) return;
      const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
      const data: Record<string, any> = JSON.parse(raw);
      for (const [key, s] of Object.entries(data)) {
        this.sessions.set(key, {
          userId: s.userId,
          channelId: s.channelId,
          threadTs: s.threadTs,
          sessionId: s.sessionId,
          isActive: s.isActive,
          lastActivity: new Date(s.lastActivity),
          workingDirectory: s.workingDirectory,
        });
      }
      this.logger.info('Loaded sessions from disk', { count: this.sessions.size });
    } catch (error) {
      this.logger.error('Failed to load sessions from disk', error);
    }
  }

  getSessionKey(userId: string, channelId: string, threadTs?: string): string {
    return `${userId}-${channelId}-${threadTs || 'direct'}`;
  }

  getSession(userId: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getSessionKey(userId, channelId, threadTs));
  }

  createSession(userId: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getSessionKey(userId, channelId, threadTs), session);
    return session;
  }

  getAgentSessionKey(agentName: string, channelId: string, threadTs?: string): string {
    return `agent:${agentName}-${channelId}-${threadTs || 'direct'}`;
  }

  getAgentSession(agentName: string, channelId: string, threadTs?: string): ConversationSession | undefined {
    return this.sessions.get(this.getAgentSessionKey(agentName, channelId, threadTs));
  }

  createAgentSession(agentName: string, channelId: string, threadTs?: string): ConversationSession {
    const session: ConversationSession = {
      userId: `agent:${agentName}`,
      channelId,
      threadTs,
      isActive: true,
      lastActivity: new Date(),
    };
    this.sessions.set(this.getAgentSessionKey(agentName, channelId, threadTs), session);
    return session;
  }

  async *streamQuery(
    prompt: string,
    session?: ConversationSession,
    abortController?: AbortController,
    workingDirectory?: string,
    slackContext?: { channel: string; threadTs?: string; user: string },
    model?: string
  ): AsyncGenerator<SDKMessage, void, unknown> {
    const options: any = {
      outputFormat: 'stream-json',
      permissionMode: slackContext ? 'default' : 'bypassPermissions',
    };

    if (model) {
      options.model = model;
    }

    // Add permission prompt tool if we have Slack context
    if (slackContext) {
      options.permissionPromptToolName = 'mcp__permission-prompt__permission_prompt';
      this.logger.debug('Added permission prompt tool for Slack integration', slackContext);
    }

    if (workingDirectory) {
      options.cwd = workingDirectory;
    }

    // Add MCP server configuration if available
    const mcpServers = this.mcpManager.getServerConfiguration();
    
    // Add permission prompt server if we have Slack context
    if (slackContext) {
      const permissionServer = {
        'permission-prompt': {
          command: 'npx',
          args: ['tsx', require('path').join(__dirname, 'permission-mcp-server.ts')],
          env: {
            SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
            SLACK_CONTEXT: JSON.stringify(slackContext)
          }
        }
      };
      
      if (mcpServers) {
        options.mcpServers = { ...mcpServers, ...permissionServer };
      } else {
        options.mcpServers = permissionServer;
      }
    } else if (mcpServers && Object.keys(mcpServers).length > 0) {
      options.mcpServers = mcpServers;
    }
    
    if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
      // Allow all MCP tools by default, plus permission prompt tool
      const defaultMcpTools = this.mcpManager.getDefaultAllowedTools();
      if (slackContext) {
        defaultMcpTools.push('mcp__permission-prompt');
      }
      if (defaultMcpTools.length > 0) {
        options.allowedTools = defaultMcpTools;
      }
      
      this.logger.debug('Added MCP configuration to options', {
        serverCount: Object.keys(options.mcpServers).length,
        servers: Object.keys(options.mcpServers),
        allowedTools: defaultMcpTools,
        hasSlackContext: !!slackContext,
      });
    }

    if (session?.sessionId) {
      options.resume = session.sessionId;
      this.logger.debug('Resuming session', { sessionId: session.sessionId });
    } else {
      this.logger.debug('Starting new Claude conversation');
    }

    this.logger.debug('Claude query options', options);

    try {
      for await (const message of query({
        prompt,
        abortController: abortController || new AbortController(),
        options,
      })) {
        if (message.type === 'system' && message.subtype === 'init') {
          if (session) {
            session.sessionId = message.session_id;
            session.lastActivity = new Date();
            this.saveSessions();
            this.logger.info('Session initialized', {
              sessionId: message.session_id,
              model: (message as any).model,
              tools: (message as any).tools?.length || 0,
            });
          }
        }
        yield message;
      }
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      const isSessionCorrupted = options.resume && (
        errorMsg.includes('Could not process image') ||
        errorMsg.includes('invalid_request_error')
      );

      if (isSessionCorrupted && session) {
        this.logger.warn('Session has corrupted data, retrying with fresh session', {
          oldSessionId: session.sessionId,
          error: errorMsg,
        });

        // Clear the corrupted session and retry fresh
        session.sessionId = undefined;
        delete options.resume;
        this.saveSessions();

        for await (const message of query({
          prompt,
          abortController: abortController || new AbortController(),
          options,
        })) {
          if (message.type === 'system' && message.subtype === 'init') {
            session.sessionId = message.session_id;
            session.lastActivity = new Date();
            this.saveSessions();
            this.logger.info('Session re-initialized after corruption recovery', {
              sessionId: message.session_id,
            });
          }
          yield message;
        }
        return;
      }

      this.logger.error('Error in Claude query', error);
      throw error;
    }
  }

  cleanupInactiveSessions(maxAge: number = 30 * 60 * 1000) {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, session] of this.sessions.entries()) {
      if (now - session.lastActivity.getTime() > maxAge) {
        this.sessions.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.saveSessions();
      this.logger.info(`Cleaned up ${cleaned} inactive sessions`);
    }
  }
}