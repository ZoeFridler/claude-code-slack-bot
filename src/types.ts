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
  rules?: string;
  quietMode?: boolean;
  template?: string;
}

export type AgentStatus = 'idle' | 'processing' | 'error';

export interface ScheduledTask {
  id: string;
  agentName: string;
  channelId: string;
  message: string;
  intervalMs: number;
  intervalLabel: string;
  createdBy: string;
  createdAt: Date;
}

export interface AgentTemplate {
  name: string;
  description: string;
  rules: string;
}

export interface ParsedCommand {
  type:
    | 'create_agent'
    | 'remove_agent'
    | 'list_agents'
    | 'broadcast'
    | 'agent_message'
    | 'set_rules'
    | 'clear_rules'
    | 'rename_agent'
    | 'agent_status'
    | 'quiet_mode'
    | 'agent_ask_agent'
    | 'schedule'
    | 'unschedule'
    | 'list_schedules'
    | 'create_from_template'
    | 'list_templates'
    | 'help'
    | 'none';
  agentName?: string;
  targetAgent?: string;
  args?: string;
}
