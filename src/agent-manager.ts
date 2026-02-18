import { AgentConfig, ParsedCommand } from './types';
import { Logger } from './logger';
import { config } from './config';
import * as path from 'path';
import * as fs from 'fs';

export class AgentManager {
  private agents: Map<string, AgentConfig> = new Map();
  private logger = new Logger('AgentManager');

  private getKey(name: string, channelId: string): string {
    return `${channelId}:${name}`;
  }

  createAgent(
    name: string,
    directory: string,
    channelId: string,
    userId: string
  ): { success: boolean; agent?: AgentConfig; error?: string } {
    if (name.toLowerCase() === 'all') {
      return { success: false, error: 'The name "all" is reserved and cannot be used for an agent.' };
    }

    const key = this.getKey(name, channelId);
    if (this.agents.has(key)) {
      return { success: false, error: `Agent "${name}" already exists in this channel.` };
    }

    const resolvedPath = this.resolveDirectory(directory);
    if (!resolvedPath) {
      return {
        success: false,
        error: `Directory not found: "${directory}"${config.baseDirectory ? ` (checked in base directory: ${config.baseDirectory})` : ''}`,
      };
    }

    const agent: AgentConfig = {
      name,
      workingDirectory: resolvedPath,
      channelId,
      createdBy: userId,
      createdAt: new Date(),
    };

    this.agents.set(key, agent);
    this.logger.info('Agent created', { name, directory: resolvedPath, channelId, userId });
    return { success: true, agent };
  }

  removeAgent(name: string, channelId: string): { success: boolean; error?: string } {
    const key = this.getKey(name, channelId);
    if (!this.agents.has(key)) {
      return { success: false, error: `Agent "${name}" not found in this channel.` };
    }

    this.agents.delete(key);
    this.logger.info('Agent removed', { name, channelId });
    return { success: true };
  }

  getAgent(name: string, channelId: string): AgentConfig | undefined {
    return this.agents.get(this.getKey(name, channelId));
  }

  listAgents(channelId: string): AgentConfig[] {
    const result: AgentConfig[] = [];
    for (const [key, agent] of this.agents.entries()) {
      if (agent.channelId === channelId) {
        result.push(agent);
      }
    }
    return result;
  }

  parseMessage(text: string, channelId: string): ParsedCommand {
    const trimmed = text.trim();

    // create agent <name> on <path>
    const createMatch = trimmed.match(/^create\s+agent\s+(\S+)\s+on\s+(.+)$/i);
    if (createMatch) {
      return { type: 'create_agent', agentName: createMatch[1], args: createMatch[2].trim() };
    }

    // remove agent <name>
    const removeMatch = trimmed.match(/^remove\s+agent\s+(\S+)$/i);
    if (removeMatch) {
      return { type: 'remove_agent', agentName: removeMatch[1] };
    }

    // list agents
    if (/^list\s+agents?$/i.test(trimmed)) {
      return { type: 'list_agents' };
    }

    // @all <message>
    const broadcastMatch = trimmed.match(/^@all\s+(.+)$/is);
    if (broadcastMatch) {
      return { type: 'broadcast', args: broadcastMatch[1].trim() };
    }

    // @<agent-name> <message>
    const agentMatch = trimmed.match(/^@(\S+)\s+(.+)$/is);
    if (agentMatch) {
      const agentName = agentMatch[1];
      // Only match if an agent with this name exists in the channel
      if (this.getAgent(agentName, channelId)) {
        return { type: 'agent_message', agentName, args: agentMatch[2].trim() };
      }
    }

    return { type: 'none' };
  }

  formatAgentList(channelId: string): string {
    const agents = this.listAgents(channelId);
    if (agents.length === 0) {
      return 'No agents configured in this channel. Use `create agent <name> on <path>` to add one.';
    }

    let message = `*Agents in this channel:*\n\n`;
    for (const agent of agents) {
      message += `- *${agent.name}* — \`${agent.workingDirectory}\` (created by <@${agent.createdBy}>)\n`;
    }
    message += `\nUse \`@<name> <message>\` to talk to a specific agent, or \`@all <message>\` to broadcast.`;
    return message;
  }

  private resolveDirectory(directory: string): string | null {
    if (path.isAbsolute(directory)) {
      if (fs.existsSync(directory)) {
        return path.resolve(directory);
      }
      return null;
    }

    if (config.baseDirectory) {
      const baseRelativePath = path.join(config.baseDirectory, directory);
      if (fs.existsSync(baseRelativePath)) {
        return path.resolve(baseRelativePath);
      }
    }

    const cwdRelativePath = path.resolve(directory);
    if (fs.existsSync(cwdRelativePath)) {
      return cwdRelativePath;
    }

    return null;
  }
}
