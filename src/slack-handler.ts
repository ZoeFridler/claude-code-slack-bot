import { App } from '@slack/bolt';
import { ClaudeHandler } from './claude-handler';
import { SDKMessage } from '@anthropic-ai/claude-code';
import { Logger } from './logger';
import { WorkingDirectoryManager } from './working-directory-manager';
import { FileHandler, ProcessedFile } from './file-handler';
import { TodoManager, Todo } from './todo-manager';
import { McpManager } from './mcp-manager';
import { AgentManager } from './agent-manager';
import { ConversationSession, AgentStatus } from './types';
import { permissionServer } from './permission-mcp-server';
import { config } from './config';

interface MessageEvent {
  user: string;
  channel: string;
  thread_ts?: string;
  ts: string;
  text?: string;
  files?: Array<{
    id: string;
    name: string;
    mimetype: string;
    filetype: string;
    url_private: string;
    url_private_download: string;
    size: number;
  }>;
}

export class SlackHandler {
  private app: App;
  private claudeHandler: ClaudeHandler;
  private activeControllers: Map<string, AbortController> = new Map();
  private logger = new Logger('SlackHandler');
  private workingDirManager: WorkingDirectoryManager;
  private fileHandler: FileHandler;
  private todoManager: TodoManager;
  private mcpManager: McpManager;
  private agentManager: AgentManager;
  private todoMessages: Map<string, string> = new Map(); // sessionKey -> messageTs
  private originalMessages: Map<string, { channel: string; ts: string }> = new Map(); // sessionKey -> original message info
  private currentReactions: Map<string, string> = new Map(); // sessionKey -> current emoji
  private agentStatuses: Map<string, AgentStatus> = new Map(); // agentKey -> status
  private botUserId: string | null = null;

  constructor(app: App, claudeHandler: ClaudeHandler, mcpManager: McpManager) {
    this.app = app;
    this.claudeHandler = claudeHandler;
    this.mcpManager = mcpManager;
    this.workingDirManager = new WorkingDirectoryManager();
    this.fileHandler = new FileHandler();
    this.todoManager = new TodoManager();
    this.agentManager = new AgentManager();

    // Set up scheduled task callback
    this.agentManager.setScheduleCallback(async (task) => {
      this.logger.info('Running scheduled task', { taskId: task.id, agent: task.agentName });
      const agent = this.agentManager.getAgent(task.agentName, task.channelId);
      if (!agent) {
        this.logger.warn('Scheduled task agent not found', { taskId: task.id, agent: task.agentName });
        return;
      }

      // Post a message indicating the scheduled task is running
      await this.app.client.chat.postMessage({
        channel: task.channelId,
        text: `[${task.agentName}] :clock1: Running scheduled task: "${task.message}"`,
      });

      // Execute the agent message
      const sessionKey = this.claudeHandler.getAgentSessionKey(task.agentName, task.channelId, 'scheduled');
      let session = this.claudeHandler.getAgentSession(task.agentName, task.channelId, 'scheduled');
      if (!session) {
        session = this.claudeHandler.createAgentSession(task.agentName, task.channelId, 'scheduled');
      }

      const identityPrompt = this.buildIdentityPrompt(agent);
      const finalPrompt = `${identityPrompt}\n\n${task.message}`;

      // Use a temporary say function that posts to the channel
      const say = async (msg: any) => {
        return await this.app.client.chat.postMessage({
          channel: task.channelId,
          text: msg.text,
          thread_ts: msg.thread_ts,
        });
      };

      await this.executeQuery({
        prompt: finalPrompt,
        session,
        sessionKey,
        workingDirectory: agent.workingDirectory,
        channel: task.channelId,
        threadTs: undefined,
        ts: Date.now().toString(),
        user: task.createdBy,
        say,
        processedFiles: [],
        messagePrefix: `[${task.agentName}]`,
        bypassPermissions: true,
        quietMode: agent.quietMode,
        model: this.resolveModel(agent.model),
      });
    });
  }

  private resolveModel(model?: string): string {
    switch (model) {
      case 'sonnet': return 'claude-sonnet-4-5-20250929';
      default: return 'claude-opus-4-6';
    }
  }

  private buildIdentityPrompt(agent: { name: string; workingDirectory: string; rules?: string }): string {
    let prompt = `You are "${agent.name}", working on ${agent.workingDirectory}. Prefix responses with [${agent.name}]. Use claude-flow MCP memory tools to communicate with other agents.`;
    if (agent.rules) {
      prompt += `\n\nYour rules:\n${agent.rules}`;
    }
    return prompt;
  }

  async handleMessage(event: MessageEvent, say: any) {
    const { user, channel, thread_ts, ts, text, files } = event;

    // Process any attached files
    let processedFiles: ProcessedFile[] = [];
    if (files && files.length > 0) {
      this.logger.info('Processing uploaded files', { count: files.length });
      processedFiles = await this.fileHandler.downloadAndProcessFiles(files);

      if (processedFiles.length > 0) {
        await say({
          text: `Processing ${processedFiles.length} file(s): ${processedFiles.map(f => f.name).join(', ')}`,
          thread_ts: thread_ts || ts,
        });
      }
    }

    // If no text and no files, nothing to process
    if (!text && processedFiles.length === 0) return;

    this.logger.debug('Received message from Slack', {
      user,
      channel,
      thread_ts,
      ts,
      text: text ? text.substring(0, 100) + (text.length > 100 ? '...' : '') : '[no text]',
      fileCount: processedFiles.length,
    });

    // Check if this is a working directory command (only if there's text)
    const setDirPath = text ? this.workingDirManager.parseSetCommand(text) : null;
    if (setDirPath) {
      const isDM = channel.startsWith('D');
      const result = this.workingDirManager.setWorkingDirectory(
        channel,
        setDirPath,
        thread_ts,
        isDM ? user : undefined
      );

      if (result.success) {
        const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');
        await say({
          text: `Working directory set for ${context}: \`${result.resolvedPath}\``,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `${result.error}`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is a get directory command (only if there's text)
    if (text && this.workingDirManager.isGetCommand(text)) {
      const isDM = channel.startsWith('D');
      const directory = this.workingDirManager.getWorkingDirectory(
        channel,
        thread_ts,
        isDM ? user : undefined
      );
      const context = thread_ts ? 'this thread' : (isDM ? 'this conversation' : 'this channel');

      await say({
        text: this.workingDirManager.formatDirectoryMessage(directory, context),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP info command (only if there's text)
    if (text && this.isMcpInfoCommand(text)) {
      await say({
        text: this.mcpManager.formatMcpInfo(),
        thread_ts: thread_ts || ts,
      });
      return;
    }

    // Check if this is an MCP reload command (only if there's text)
    if (text && this.isMcpReloadCommand(text)) {
      const reloaded = this.mcpManager.reloadConfiguration();
      if (reloaded) {
        await say({
          text: `MCP configuration reloaded successfully.\n\n${this.mcpManager.formatMcpInfo()}`,
          thread_ts: thread_ts || ts,
        });
      } else {
        await say({
          text: `Failed to reload MCP configuration. Check the mcp-servers.json file.`,
          thread_ts: thread_ts || ts,
        });
      }
      return;
    }

    // Check if this is an agent command (only if there's text)
    if (text) {
      const parsed = this.agentManager.parseMessage(text, channel);
      switch (parsed.type) {
        case 'create_agent':
          await this.handleCreateAgent(parsed.agentName!, parsed.args!, channel, user, thread_ts || ts, say);
          return;
        case 'create_from_template':
          await this.handleCreateAgentFromTemplate(parsed.agentName!, parsed.targetAgent!, parsed.args!, channel, user, thread_ts || ts, say);
          return;
        case 'remove_agent':
          await this.handleRemoveAgent(parsed.agentName!, channel, thread_ts || ts, say);
          return;
        case 'rename_agent':
          await this.handleRenameAgent(parsed.agentName!, parsed.args!, channel, thread_ts || ts, say);
          return;
        case 'list_agents':
          await this.handleListAgents(channel, thread_ts || ts, say);
          return;
        case 'set_rules':
          await this.handleSetRules(parsed.agentName!, parsed.args!, channel, thread_ts || ts, say);
          return;
        case 'clear_rules':
          await this.handleClearRules(parsed.agentName!, channel, thread_ts || ts, say);
          return;
        case 'quiet_mode':
          await this.handleQuietMode(parsed.agentName!, parsed.args! === 'on', channel, thread_ts || ts, say);
          return;
        case 'set_model':
          await this.handleSetModel(parsed.agentName!, parsed.args! as any, channel, thread_ts || ts, say);
          return;
        case 'agent_status':
          await this.handleAgentStatus(parsed.agentName!, channel, thread_ts || ts, say);
          return;
        case 'agent_ask_agent':
          await this.handleAgentAskAgent(parsed.agentName!, parsed.targetAgent!, parsed.args!, channel, user, thread_ts, ts, say, processedFiles);
          return;
        case 'schedule':
          await this.handleSchedule(parsed.agentName!, parsed.targetAgent!, parsed.args!, channel, user, thread_ts || ts, say);
          return;
        case 'unschedule':
          await this.handleUnschedule(parsed.args!, channel, thread_ts || ts, say);
          return;
        case 'list_schedules':
          await this.handleListSchedules(channel, thread_ts || ts, say);
          return;
        case 'list_templates':
          await this.handleListTemplates(thread_ts || ts, say);
          return;
        case 'help':
          await say({ text: this.agentManager.formatHelp(), thread_ts: thread_ts || ts });
          return;
        case 'agent_message':
          await this.handleAgentMessage(parsed.agentName!, parsed.args!, channel, user, thread_ts, ts, say, processedFiles);
          return;
        case 'broadcast':
          await this.handleBroadcast(parsed.args!, channel, user, thread_ts, ts, say, processedFiles);
          return;
      }
    }

    // Check if we have a working directory set
    const isDM = channel.startsWith('D');
    const workingDirectory = this.workingDirManager.getWorkingDirectory(
      channel,
      thread_ts,
      isDM ? user : undefined
    );

    // Working directory is always required
    if (!workingDirectory) {
      let errorMessage = `No working directory set. `;

      if (!isDM && !this.workingDirManager.hasChannelWorkingDirectory(channel)) {
        // No channel default set
        errorMessage += `Please set a default working directory for this channel first using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`cwd project-name\` or \`cwd /absolute/path\`\n\n`;
          errorMessage += `Base directory: \`${config.baseDirectory}\``;
        } else {
          errorMessage += `\`cwd /path/to/directory\``;
        }
      } else if (thread_ts) {
        // In thread but no thread-specific directory
        errorMessage += `You can set a thread-specific working directory using:\n`;
        if (config.baseDirectory) {
          errorMessage += `\`@claudebot cwd project-name\` or \`@claudebot cwd /absolute/path\``;
        } else {
          errorMessage += `\`@claudebot cwd /path/to/directory\``;
        }
      } else {
        errorMessage += `Please set one first using:\n\`cwd /path/to/directory\``;
      }

      await say({
        text: errorMessage,
        thread_ts: thread_ts || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getSessionKey(user, channel, thread_ts || ts);

    let session = this.claudeHandler.getSession(user, channel, thread_ts || ts);
    if (!session) {
      this.logger.debug('Creating new session', { sessionKey });
      session = this.claudeHandler.createSession(user, channel, thread_ts || ts);
    } else {
      this.logger.debug('Using existing session', { sessionKey, sessionId: session.sessionId });
    }

    // Prepare the prompt with file attachments
    const finalPrompt = processedFiles.length > 0
      ? await this.fileHandler.formatFilePrompt(processedFiles, text || '')
      : text || '';

    await this.executeQuery({
      prompt: finalPrompt,
      session,
      sessionKey,
      workingDirectory,
      channel,
      threadTs: thread_ts,
      ts,
      user,
      say,
      processedFiles,
    });
  }

  private async handleCreateAgent(
    agentName: string,
    directory: string,
    channel: string,
    user: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.createAgent(agentName, directory, channel, user);
    if (result.success) {
      await say({
        text: `Agent *${agentName}* created on \`${result.agent!.workingDirectory}\``,
        thread_ts: threadTs,
      });
      await say({
        text: `[${agentName}] Hi! I'm *${agentName}* and I'll be working on \`${result.agent!.workingDirectory}\`. Mention me with \`@${agentName}\` to ask me anything about this project.`,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleCreateAgentFromTemplate(
    agentName: string,
    templateName: string,
    directory: string,
    channel: string,
    user: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.createAgent(agentName, directory, channel, user, templateName);
    if (result.success) {
      const template = this.agentManager.getTemplate(templateName);
      await say({
        text: `Agent *${agentName}* created on \`${result.agent!.workingDirectory}\` using template *${templateName}*`,
        thread_ts: threadTs,
      });
      await say({
        text: `[${agentName}] Hi! I'm *${agentName}* (${template?.description || templateName}) and I'll be working on \`${result.agent!.workingDirectory}\`. Mention me with \`@${agentName}\` to ask me anything.`,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleRemoveAgent(
    agentName: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.removeAgent(agentName, channel);
    if (result.success) {
      this.agentStatuses.delete(`${channel}:${agentName}`);
      await say({
        text: `Agent *${agentName}* removed.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleRenameAgent(
    oldName: string,
    newName: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.renameAgent(oldName, newName, channel);
    if (result.success) {
      // Transfer status
      const oldKey = `${channel}:${oldName}`;
      const newKey = `${channel}:${newName}`;
      const status = this.agentStatuses.get(oldKey);
      if (status) {
        this.agentStatuses.set(newKey, status);
        this.agentStatuses.delete(oldKey);
      }
      await say({
        text: `Agent *${oldName}* renamed to *${newName}*.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleListAgents(channel: string, threadTs: string, say: any): Promise<void> {
    await say({
      text: this.agentManager.formatAgentList(channel, this.agentStatuses),
      thread_ts: threadTs,
    });
  }

  private async handleSetRules(
    agentName: string,
    rules: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.setRules(agentName, channel, rules);
    if (result.success) {
      await say({
        text: `Rules updated for *${agentName}*:\n\`\`\`\n${rules}\n\`\`\``,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleClearRules(
    agentName: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.clearRules(agentName, channel);
    if (result.success) {
      await say({
        text: `Rules cleared for *${agentName}*.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleQuietMode(
    agentName: string,
    quiet: boolean,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.setQuietMode(agentName, channel, quiet);
    if (result.success) {
      await say({
        text: `Quiet mode ${quiet ? 'enabled' : 'disabled'} for *${agentName}*.${quiet ? ' Tool use messages will be suppressed.' : ''}`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleSetModel(
    agentName: string,
    model: 'opus' | 'sonnet',
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.setModel(agentName, channel, model);
    if (result.success) {
      const label = model === 'sonnet' ? 'Sonnet (fast)' : 'Opus (smart)';
      await say({
        text: `Model set to *${label}* for *${agentName}*.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleAgentStatus(
    agentName: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const agent = this.agentManager.getAgent(agentName, channel);
    if (!agent) {
      await say({
        text: `Agent "${agentName}" not found in this channel.`,
        thread_ts: threadTs,
      });
      return;
    }

    const agentKey = `${channel}:${agentName}`;
    const status = this.agentStatuses.get(agentKey) || 'idle';
    const schedules = this.agentManager.listSchedules(channel).filter(s => s.agentName === agentName);

    await say({
      text: this.agentManager.formatAgentStatus(agent, status, schedules),
      thread_ts: threadTs,
    });
  }

  private async handleSchedule(
    agentName: string,
    intervalStr: string,
    message: string,
    channel: string,
    user: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const parts = intervalStr.split(' ');
    const intervalMs = this.agentManager.parseInterval(parts[0], parts[1]);
    if (!intervalMs) {
      await say({
        text: `Invalid interval: "${intervalStr}". Use format: \`<number> <minutes|hours|days>\``,
        thread_ts: threadTs,
      });
      return;
    }

    const result = this.agentManager.addSchedule(agentName, channel, message, intervalMs, intervalStr, user);
    if (result.success) {
      await say({
        text: `Scheduled task for *${agentName}*: "${message}" every ${intervalStr}\nTask ID: \`${result.task!.id}\``,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleUnschedule(
    scheduleId: string,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    const result = this.agentManager.removeSchedule(scheduleId, channel);
    if (result.success) {
      await say({
        text: `Scheduled task \`${scheduleId}\` removed.`,
        thread_ts: threadTs,
      });
    } else {
      await say({
        text: `${result.error}`,
        thread_ts: threadTs,
      });
    }
  }

  private async handleListSchedules(channel: string, threadTs: string, say: any): Promise<void> {
    await say({
      text: this.agentManager.formatScheduleList(channel),
      thread_ts: threadTs,
    });
  }

  private async handleListTemplates(threadTs: string, say: any): Promise<void> {
    await say({
      text: this.agentManager.formatTemplateList(),
      thread_ts: threadTs,
    });
  }

  private async handleAgentMessage(
    agentName: string,
    message: string,
    channel: string,
    user: string,
    threadTs: string | undefined,
    ts: string,
    say: any,
    processedFiles: ProcessedFile[]
  ): Promise<void> {
    const agent = this.agentManager.getAgent(agentName, channel);
    if (!agent) {
      await say({
        text: `Agent "${agentName}" not found in this channel. Use \`list agents\` to see available agents.`,
        thread_ts: threadTs || ts,
      });
      return;
    }

    const sessionKey = this.claudeHandler.getAgentSessionKey(agentName, channel, threadTs || ts);

    let session = this.claudeHandler.getAgentSession(agentName, channel, threadTs || ts);
    if (!session) {
      session = this.claudeHandler.createAgentSession(agentName, channel, threadTs || ts);
    }

    const identityPrompt = this.buildIdentityPrompt(agent);
    const finalPrompt = processedFiles.length > 0
      ? await this.fileHandler.formatFilePrompt(processedFiles, `${identityPrompt}\n\n${message}`)
      : `${identityPrompt}\n\n${message}`;

    // Update status
    const agentKey = `${channel}:${agentName}`;
    this.agentStatuses.set(agentKey, 'processing');

    try {
      await this.executeQuery({
        prompt: finalPrompt,
        session,
        sessionKey,
        workingDirectory: agent.workingDirectory,
        channel,
        threadTs,
        ts,
        user,
        say,
        processedFiles,
        messagePrefix: `[${agentName}]`,
        bypassPermissions: true,
        quietMode: agent.quietMode,
        model: this.resolveModel(agent.model),
      });
      this.agentStatuses.set(agentKey, 'idle');
    } catch (error) {
      this.agentStatuses.set(agentKey, 'error');
      throw error;
    }
  }

  private async handleAgentAskAgent(
    askingAgent: string,
    targetAgent: string,
    question: string,
    channel: string,
    user: string,
    threadTs: string | undefined,
    ts: string,
    say: any,
    processedFiles: ProcessedFile[]
  ): Promise<void> {
    const asker = this.agentManager.getAgent(askingAgent, channel);
    const target = this.agentManager.getAgent(targetAgent, channel);

    if (!asker || !target) {
      const missing = !asker ? askingAgent : targetAgent;
      await say({
        text: `Agent "${missing}" not found in this channel.`,
        thread_ts: threadTs || ts,
      });
      return;
    }

    // Step 1: Ask the target agent the question
    await say({
      text: `[${askingAgent}] Asking *${targetAgent}* about: "${question}"`,
      thread_ts: threadTs || ts,
    });

    // Collect target agent's response
    const targetSessionKey = this.claudeHandler.getAgentSessionKey(targetAgent, channel, `cross-${ts}`);
    let targetSession = this.claudeHandler.getAgentSession(targetAgent, channel, `cross-${ts}`);
    if (!targetSession) {
      targetSession = this.claudeHandler.createAgentSession(targetAgent, channel, `cross-${ts}`);
    }

    const targetPrompt = `${this.buildIdentityPrompt(target)}\n\n${question}`;

    // Track target status
    const targetKey = `${channel}:${targetAgent}`;
    this.agentStatuses.set(targetKey, 'processing');

    let targetResponse = '';
    try {
      const abortController = new AbortController();
      for await (const message of this.claudeHandler.streamQuery(
        targetPrompt,
        targetSession,
        abortController,
        target.workingDirectory,
        undefined // bypass permissions
      )) {
        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');
          if (!hasToolUse) {
            const textParts = message.message.content
              ?.filter((part: any) => part.type === 'text')
              .map((part: any) => part.text);
            if (textParts?.length) {
              targetResponse += textParts.join('');
            }
          }
        } else if (message.type === 'result' && message.subtype === 'success') {
          const result = (message as any).result;
          if (result && !targetResponse.includes(result)) {
            targetResponse = result;
          }
        }
      }
      this.agentStatuses.set(targetKey, 'idle');
    } catch (error) {
      this.agentStatuses.set(targetKey, 'error');
      await say({
        text: `[${targetAgent}] Error: ${(error as any).message || 'Failed to respond'}`,
        thread_ts: threadTs || ts,
      });
      return;
    }

    // Post target's response
    if (targetResponse) {
      await say({
        text: `[${targetAgent}] ${this.formatMessage(targetResponse, true)}`,
        thread_ts: threadTs || ts,
      });
    }

    // Step 2: Send target's response to the asking agent
    const followUp = `Here's what ${targetAgent} said in response to "${question}":\n\n${targetResponse}\n\nNow respond to the user based on this information and your own knowledge.`;

    await this.handleAgentMessage(
      askingAgent,
      followUp,
      channel,
      user,
      threadTs,
      ts,
      say,
      processedFiles
    );
  }

  private async handleBroadcast(
    message: string,
    channel: string,
    user: string,
    threadTs: string | undefined,
    ts: string,
    say: any,
    processedFiles: ProcessedFile[]
  ): Promise<void> {
    const agents = this.agentManager.listAgents(channel);
    if (agents.length === 0) {
      await say({
        text: 'No agents configured in this channel. Use `create agent <name> on <path>` to add one.',
        thread_ts: threadTs || ts,
      });
      return;
    }

    await say({
      text: `Broadcasting to ${agents.length} agent(s): ${agents.map(a => `*${a.name}*`).join(', ')}`,
      thread_ts: threadTs || ts,
    });

    const results = await Promise.allSettled(
      agents.map(agent =>
        this.handleAgentMessage(agent.name, message, channel, user, threadTs, ts, say, processedFiles)
      )
    );

    const failures = results.filter(r => r.status === 'rejected');
    if (failures.length > 0) {
      this.logger.error('Some broadcast agents failed', { failureCount: failures.length });
    }
  }

  private async executeQuery(opts: {
    prompt: string;
    session: ConversationSession;
    sessionKey: string;
    workingDirectory: string;
    channel: string;
    threadTs: string | undefined;
    ts: string;
    user: string;
    say: any;
    processedFiles: ProcessedFile[];
    messagePrefix?: string;
    bypassPermissions?: boolean;
    quietMode?: boolean;
    model?: string;
  }): Promise<void> {
    const { prompt, session, sessionKey, workingDirectory, channel, threadTs, ts, user, say, processedFiles, messagePrefix, bypassPermissions, quietMode, model } = opts;
    const replyTs = threadTs || ts;
    const prefix = messagePrefix ? `${messagePrefix} ` : '';

    // Store the original message info for status reactions
    this.originalMessages.set(sessionKey, { channel, ts: replyTs });

    // Cancel any existing request for this conversation
    const existingController = this.activeControllers.get(sessionKey);
    if (existingController) {
      this.logger.debug('Cancelling existing request for session', { sessionKey });
      existingController.abort();
    }

    const abortController = new AbortController();
    this.activeControllers.set(sessionKey, abortController);

    let currentMessages: string[] = [];
    let statusMessageTs: string | undefined;
    let heartbeatTimer: NodeJS.Timeout | undefined;
    const startTime = Date.now();
    let currentActivity = 'Thinking';
    let currentToolName = '';

    const formatElapsed = (ms: number): string => {
      const seconds = Math.floor(ms / 1000);
      if (seconds < 60) return `${seconds}s`;
      const minutes = Math.floor(seconds / 60);
      const remaining = seconds % 60;
      return `${minutes}m ${remaining}s`;
    };

    const updateStatusMessage = async () => {
      if (!statusMessageTs) return;
      const elapsed = formatElapsed(Date.now() - startTime);
      const toolInfo = currentToolName ? ` — \`${currentToolName}\`` : '';
      try {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: `${prefix}${currentActivity === 'Thinking' ? ':thinking_face:' : ':gear:'} *${currentActivity}...* (${elapsed})${toolInfo}`,
        });
      } catch (error) {
        this.logger.debug('Failed to update heartbeat status', { error: (error as any).message });
      }
    };

    try {
      this.logger.info('Sending query to Claude Code SDK', {
        prompt: prompt.substring(0, 200) + (prompt.length > 200 ? '...' : ''),
        sessionId: session.sessionId,
        workingDirectory,
        fileCount: processedFiles.length,
      });

      // Send initial status message
      const statusResult = await say({
        text: `${prefix}:thinking_face: *Thinking...* (0s)`,
        thread_ts: replyTs,
      });
      statusMessageTs = statusResult.ts;

      // Start heartbeat timer — updates status every 5 seconds
      heartbeatTimer = setInterval(() => updateStatusMessage(), 5000);

      // Add thinking reaction to original message
      await this.updateMessageReaction(sessionKey, 'thinking_face');

      // Create Slack context for permission prompts (skip for autonomous agents)
      const slackContext = bypassPermissions ? undefined : {
        channel,
        threadTs,
        user
      };

      for await (const message of this.claudeHandler.streamQuery(prompt, session, abortController, workingDirectory, slackContext, model)) {
        if (abortController.signal.aborted) break;

        this.logger.debug('Received message from Claude SDK', {
          type: message.type,
          subtype: (message as any).subtype,
          message: message,
        });

        if (message.type === 'assistant') {
          const hasToolUse = message.message.content?.some((part: any) => part.type === 'tool_use');

          if (hasToolUse) {
            // Extract tool name for status display
            const toolPart = message.message.content?.find((part: any) => part.type === 'tool_use');
            currentToolName = toolPart?.name || '';
            currentActivity = 'Working';

            await this.updateMessageReaction(sessionKey, 'gear');

            const todoTool = message.message.content?.find((part: any) =>
              part.type === 'tool_use' && part.name === 'TodoWrite'
            );

            if (todoTool) {
              await this.handleTodoUpdate(todoTool.input, sessionKey, session?.sessionId, channel, replyTs, say);
            }

            // In quiet mode, skip tool use messages
            if (!quietMode) {
              const toolContent = this.formatToolUse(message.message.content);
              if (toolContent) {
                await say({
                  text: `${prefix}${toolContent}`,
                  thread_ts: replyTs,
                });
              }
            }
          } else {
            currentActivity = 'Responding';
            currentToolName = '';
            const content = this.extractTextContent(message);
            if (content) {
              currentMessages.push(content);

              const formatted = this.formatMessage(content, false);
              await say({
                text: `${prefix}${formatted}`,
                thread_ts: replyTs,
              });
            }
          }
        } else if (message.type === 'result') {
          this.logger.info('Received result from Claude SDK', {
            subtype: message.subtype,
            hasResult: message.subtype === 'success' && !!(message as any).result,
            totalCost: (message as any).total_cost_usd,
            duration: (message as any).duration_ms,
          });

          if (message.subtype === 'success' && (message as any).result) {
            const finalResult = (message as any).result;
            if (finalResult && !currentMessages.includes(finalResult)) {
              const formatted = this.formatMessage(finalResult, true);
              await say({
                text: `${prefix}${formatted}`,
                thread_ts: replyTs,
              });
            }
          }
        }
      }

      // Stop heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer);

      // Update status to completed with total time
      const totalElapsed = formatElapsed(Date.now() - startTime);
      if (statusMessageTs) {
        await this.app.client.chat.update({
          channel,
          ts: statusMessageTs,
          text: `${prefix}:white_check_mark: *Done* (${totalElapsed})`,
        });
      }

      await this.updateMessageReaction(sessionKey, 'white_check_mark');

      this.logger.info('Completed processing message', {
        sessionKey,
        messageCount: currentMessages.length,
      });

      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } catch (error: any) {
      // Stop heartbeat
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const totalElapsed = formatElapsed(Date.now() - startTime);

      if (error.name !== 'AbortError') {
        this.logger.error('Error handling message', error);

        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: `${prefix}:x: *Error* (${totalElapsed})`,
          });
        }

        await this.updateMessageReaction(sessionKey, 'x');

        await say({
          text: `${prefix}Error: ${error.message || 'Something went wrong'}`,
          thread_ts: replyTs,
        });
      } else {
        this.logger.debug('Request was aborted', { sessionKey });

        if (statusMessageTs) {
          await this.app.client.chat.update({
            channel,
            ts: statusMessageTs,
            text: `${prefix}:stop_button: *Cancelled* (${totalElapsed})`,
          });
        }

        await this.updateMessageReaction(sessionKey, 'stop_button');
      }

      if (processedFiles.length > 0) {
        await this.fileHandler.cleanupTempFiles(processedFiles);
      }
    } finally {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      this.activeControllers.delete(sessionKey);

      if (session?.sessionId) {
        setTimeout(() => {
          this.todoManager.cleanupSession(session.sessionId!);
          this.todoMessages.delete(sessionKey);
          this.originalMessages.delete(sessionKey);
          this.currentReactions.delete(sessionKey);
        }, 5 * 60 * 1000);
      }
    }
  }

  private extractTextContent(message: SDKMessage): string | null {
    if (message.type === 'assistant' && message.message.content) {
      const textParts = message.message.content
        .filter((part: any) => part.type === 'text')
        .map((part: any) => part.text);
      return textParts.join('');
    }
    return null;
  }

  private formatToolUse(content: any[]): string {
    const parts: string[] = [];

    for (const part of content) {
      if (part.type === 'text') {
        parts.push(part.text);
      } else if (part.type === 'tool_use') {
        const toolName = part.name;
        const input = part.input;

        switch (toolName) {
          case 'Edit':
          case 'MultiEdit':
            parts.push(this.formatEditTool(toolName, input));
            break;
          case 'Write':
            parts.push(this.formatWriteTool(input));
            break;
          case 'Read':
            parts.push(this.formatReadTool(input));
            break;
          case 'Bash':
            parts.push(this.formatBashTool(input));
            break;
          case 'TodoWrite':
            // Handle TodoWrite separately - don't include in regular tool output
            return this.handleTodoWrite(input);
          default:
            parts.push(this.formatGenericTool(toolName, input));
        }
      }
    }

    return parts.join('\n\n');
  }

  private formatEditTool(toolName: string, input: any): string {
    const filePath = input.file_path;
    const edits = toolName === 'MultiEdit' ? input.edits : [{ old_string: input.old_string, new_string: input.new_string }];

    let result = `:pencil2: *Editing \`${filePath}\`*\n`;

    for (const edit of edits) {
      result += '\n```diff\n';
      result += `- ${this.truncateString(edit.old_string, 200)}\n`;
      result += `+ ${this.truncateString(edit.new_string, 200)}\n`;
      result += '```';
    }

    return result;
  }

  private formatWriteTool(input: any): string {
    const filePath = input.file_path;
    const preview = this.truncateString(input.content, 300);

    return `:page_facing_up: *Creating \`${filePath}\`*\n\`\`\`\n${preview}\n\`\`\``;
  }

  private formatReadTool(input: any): string {
    return `:eye: *Reading \`${input.file_path}\`*`;
  }

  private formatBashTool(input: any): string {
    return `:desktop_computer: *Running command:*\n\`\`\`bash\n${input.command}\n\`\`\``;
  }

  private formatGenericTool(toolName: string, input: any): string {
    return `:wrench: *Using ${toolName}*`;
  }

  private truncateString(str: string, maxLength: number): string {
    if (!str) return '';
    if (str.length <= maxLength) return str;
    return str.substring(0, maxLength) + '...';
  }

  private handleTodoWrite(input: any): string {
    // TodoWrite tool doesn't produce visible output - handled separately
    return '';
  }

  private async handleTodoUpdate(
    input: any,
    sessionKey: string,
    sessionId: string | undefined,
    channel: string,
    threadTs: string,
    say: any
  ): Promise<void> {
    if (!sessionId || !input.todos) {
      return;
    }

    const newTodos: Todo[] = input.todos;
    const oldTodos = this.todoManager.getTodos(sessionId);

    // Check if there's a significant change
    if (this.todoManager.hasSignificantChange(oldTodos, newTodos)) {
      // Update the todo manager
      this.todoManager.updateTodos(sessionId, newTodos);

      // Format the todo list
      const todoList = this.todoManager.formatTodoList(newTodos);

      // Check if we already have a todo message for this session
      const existingTodoMessageTs = this.todoMessages.get(sessionKey);

      if (existingTodoMessageTs) {
        // Update existing todo message
        try {
          await this.app.client.chat.update({
            channel,
            ts: existingTodoMessageTs,
            text: todoList,
          });
          this.logger.debug('Updated existing todo message', { sessionKey, messageTs: existingTodoMessageTs });
        } catch (error) {
          this.logger.warn('Failed to update todo message, creating new one', error);
          // If update fails, create a new message
          await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
        }
      } else {
        // Create new todo message
        await this.createNewTodoMessage(todoList, channel, threadTs, sessionKey, say);
      }

      // Send status change notification if there are meaningful changes
      const statusChange = this.todoManager.getStatusChange(oldTodos, newTodos);
      if (statusChange) {
        await say({
          text: `:arrows_counterclockwise: *Task Update:*\n${statusChange}`,
          thread_ts: threadTs,
        });
      }

      // Update reaction based on overall progress
      await this.updateTaskProgressReaction(sessionKey, newTodos);
    }
  }

  private async createNewTodoMessage(
    todoList: string,
    channel: string,
    threadTs: string,
    sessionKey: string,
    say: any
  ): Promise<void> {
    const result = await say({
      text: todoList,
      thread_ts: threadTs,
    });

    if (result?.ts) {
      this.todoMessages.set(sessionKey, result.ts);
      this.logger.debug('Created new todo message', { sessionKey, messageTs: result.ts });
    }
  }

  private async updateMessageReaction(sessionKey: string, emoji: string): Promise<void> {
    const originalMessage = this.originalMessages.get(sessionKey);
    if (!originalMessage) {
      return;
    }

    // Check if we're already showing this emoji
    const currentEmoji = this.currentReactions.get(sessionKey);
    if (currentEmoji === emoji) {
      this.logger.debug('Reaction already set, skipping', { sessionKey, emoji });
      return;
    }

    try {
      // Remove the current reaction if it exists
      if (currentEmoji) {
        try {
          await this.app.client.reactions.remove({
            channel: originalMessage.channel,
            timestamp: originalMessage.ts,
            name: currentEmoji,
          });
          this.logger.debug('Removed previous reaction', { sessionKey, emoji: currentEmoji });
        } catch (error) {
          this.logger.debug('Failed to remove previous reaction (might not exist)', {
            sessionKey,
            emoji: currentEmoji,
            error: (error as any).message
          });
        }
      }

      // Add the new reaction
      await this.app.client.reactions.add({
        channel: originalMessage.channel,
        timestamp: originalMessage.ts,
        name: emoji,
      });

      // Track the current reaction
      this.currentReactions.set(sessionKey, emoji);

      this.logger.debug('Updated message reaction', {
        sessionKey,
        emoji,
        previousEmoji: currentEmoji,
        channel: originalMessage.channel,
        ts: originalMessage.ts
      });
    } catch (error) {
      this.logger.warn('Failed to update message reaction', error);
    }
  }

  private async updateTaskProgressReaction(sessionKey: string, todos: Todo[]): Promise<void> {
    if (todos.length === 0) {
      return;
    }

    const completed = todos.filter(t => t.status === 'completed').length;
    const inProgress = todos.filter(t => t.status === 'in_progress').length;
    const total = todos.length;

    let emoji: string;
    if (completed === total) {
      emoji = 'white_check_mark'; // All tasks completed
    } else if (inProgress > 0) {
      emoji = 'arrows_counterclockwise'; // Tasks in progress
    } else {
      emoji = 'clipboard'; // Tasks pending
    }

    await this.updateMessageReaction(sessionKey, emoji);
  }

  private isMcpInfoCommand(text: string): boolean {
    return /^(mcp|servers?)(\s+(info|list|status))?(\?)?$/i.test(text.trim());
  }

  private isMcpReloadCommand(text: string): boolean {
    return /^(mcp|servers?)\s+(reload|refresh)$/i.test(text.trim());
  }

  private async getBotUserId(): Promise<string> {
    if (!this.botUserId) {
      try {
        const response = await this.app.client.auth.test();
        this.botUserId = response.user_id as string;
      } catch (error) {
        this.logger.error('Failed to get bot user ID', error);
        this.botUserId = '';
      }
    }
    return this.botUserId;
  }

  private async handleChannelJoin(channelId: string, say: any): Promise<void> {
    try {
      // Get channel info
      const channelInfo = await this.app.client.conversations.info({
        channel: channelId,
      });

      const channelName = (channelInfo.channel as any)?.name || 'this channel';

      let welcomeMessage = `Hi! I'm Claude Code, your AI coding assistant.\n\n`;
      welcomeMessage += `To get started, I need to know the default working directory for #${channelName}.\n\n`;

      if (config.baseDirectory) {
        welcomeMessage += `You can use:\n`;
        welcomeMessage += `\`cwd project-name\` (relative to base directory: \`${config.baseDirectory}\`)\n`;
        welcomeMessage += `\`cwd /absolute/path/to/project\` (absolute path)\n\n`;
      } else {
        welcomeMessage += `Please set it using:\n`;
        welcomeMessage += `\`cwd /path/to/project\` or \`set directory /path/to/project\`\n\n`;
      }

      welcomeMessage += `This will be the default working directory for this channel. `;
      welcomeMessage += `You can always override it for specific threads by mentioning me with a different \`cwd\` command.\n\n`;
      welcomeMessage += `Once set, you can ask me to help with code reviews, file analysis, debugging, and more!`;

      await say({
        text: welcomeMessage,
      });

      this.logger.info('Sent welcome message to channel', { channelId, channelName });
    } catch (error) {
      this.logger.error('Failed to handle channel join', error);
    }
  }

  private formatMessage(text: string, isFinal: boolean): string {
    // Convert markdown code blocks to Slack format
    let formatted = text
      .replace(/```(\w+)?\n([\s\S]*?)```/g, (_, lang, code) => {
        return '```' + code + '```';
      })
      .replace(/`([^`]+)`/g, '`$1`')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/__([^_]+)__/g, '_$1_');

    return formatted;
  }

  setupEventHandlers() {
    // Handle direct messages
    this.app.message(async ({ message, say }) => {
      if (message.subtype === undefined && 'user' in message) {
        this.logger.info('Handling direct message event');
        await this.handleMessage(message as MessageEvent, say);
      }
    });

    // Handle app mentions
    this.app.event('app_mention', async ({ event, say }) => {
      this.logger.info('Handling app mention event');
      const text = event.text.replace(/<@[^>]+>/g, '').trim();
      await this.handleMessage({
        ...event,
        text,
      } as MessageEvent, say);
    });

    // Handle file uploads in threads
    this.app.event('message', async ({ event, say }) => {
      // Only handle file uploads that are not from bots and have files
      if (event.subtype === 'file_share' && 'user' in event && event.files) {
        this.logger.info('Handling file upload event');
        await this.handleMessage(event as MessageEvent, say);
      }
    });

    // Handle bot being added to channels
    this.app.event('member_joined_channel', async ({ event, say }) => {
      // Check if the bot was added to the channel
      if (event.user === await this.getBotUserId()) {
        this.logger.info('Bot added to channel', { channel: event.channel });
        await this.handleChannelJoin(event.channel, say);
      }
    });

    // Handle permission approval button clicks
    this.app.action('approve_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval granted', { approvalId });

      permissionServer.resolveApproval(approvalId, true);

      await respond({
        response_type: 'ephemeral',
        text: 'Tool execution approved'
      });
    });

    // Handle permission denial button clicks
    this.app.action('deny_tool', async ({ ack, body, respond }) => {
      await ack();
      const approvalId = (body as any).actions[0].value;
      this.logger.info('Tool approval denied', { approvalId });

      permissionServer.resolveApproval(approvalId, false);

      await respond({
        response_type: 'ephemeral',
        text: 'Tool execution denied'
      });
    });

    // Cleanup inactive sessions periodically
    setInterval(() => {
      this.logger.debug('Running session cleanup');
      this.claudeHandler.cleanupInactiveSessions();
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}
