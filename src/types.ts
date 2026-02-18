export interface ConversationSession {
  userId: string;
  channelId: string;
  threadTs?: string;
  sessionId?: string;
  isActive: boolean;
  lastActivity: Date;
  workingDirectory?: string;
}

export interface WorkingDirectoryConfig {
  channelId: string;
  threadTs?: string;
  userId?: string;
  directory: string;
  setAt: Date;
}

export interface AgentConfig {
  name: string;
  workingDirectory: string;
  channelId: string;
  createdBy: string;
  createdAt: Date;
}

export interface ParsedCommand {
  type: 'create_agent' | 'remove_agent' | 'list_agents' | 'broadcast' | 'agent_message' | 'none';
  agentName?: string;
  args?: string;
}