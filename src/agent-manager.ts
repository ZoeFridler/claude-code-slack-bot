import { AgentConfig, AgentModel, ParsedCommand, ScheduledTask, AgentTemplate } from './types';
import { Logger } from './logger';
import { config } from './config';
import * as path from 'path';
import * as fs from 'fs';

const AGENTS_FILE = path.join(__dirname, '..', 'agents.json');

const AGENT_COLORS = [
  '#3498DB', // blue
  '#2ECC71', // green
  '#E74C3C', // red
  '#F39C12', // orange
  '#9B59B6', // purple
  '#1ABC9C', // teal
  '#E91E63', // pink
  '#00BCD4', // cyan
  '#FF9800', // amber
  '#8BC34A', // lime
];
const SCHEDULES_FILE = path.join(__dirname, '..', 'schedules.json');
const GLOBAL_RULES_FILE = path.join(__dirname, '..', 'global-rules.json');

const TEMPLATES: AgentTemplate[] = [
  {
    name: 'reviewer',
    description: 'Code reviewer that checks for bugs, style, and best practices',
    rules: `You are a code reviewer. When asked to review code or PRs:
- Focus on bugs, security issues, and logic errors first
- Check for code style consistency and best practices
- Suggest improvements but distinguish between must-fix and nice-to-have
- Be constructive and explain the reasoning behind suggestions
- Look for missing error handling, edge cases, and test coverage`,
  },
  {
    name: 'devops',
    description: 'DevOps engineer focused on CI/CD, infrastructure, and deployment',
    rules: `You are a DevOps engineer. Focus on:
- CI/CD pipeline configuration and optimization
- Docker, Kubernetes, and container orchestration
- Infrastructure as code (Terraform, CloudFormation)
- Monitoring, logging, and alerting
- Security best practices for deployment and infrastructure
- Performance optimization and scalability`,
  },
  {
    name: 'docs',
    description: 'Documentation writer that creates and maintains project docs',
    rules: `You are a documentation specialist. Focus on:
- Write clear, concise documentation with examples
- Maintain consistent formatting and structure
- Include code examples and usage patterns
- Document API endpoints, parameters, and responses
- Keep README files up to date
- Write inline code comments where logic is non-obvious`,
  },
  {
    name: 'security',
    description: 'Security auditor that scans for vulnerabilities and risks',
    rules: `You are a security auditor. Focus on:
- OWASP Top 10 vulnerabilities (XSS, SQL injection, CSRF, etc.)
- Authentication and authorization flaws
- Secrets and credential exposure
- Dependency vulnerabilities
- Input validation and sanitization
- Security headers and configurations
- Rate limiting and abuse prevention`,
  },
  {
    name: 'tester',
    description: 'QA engineer that writes and runs tests',
    rules: `You are a QA engineer. Focus on:
- Write comprehensive unit tests with good coverage
- Write integration tests for critical paths
- Test edge cases and error scenarios
- Use appropriate mocking and stubbing
- Follow the testing conventions of the project
- Run tests after making changes to verify nothing broke`,
  },
];

export class AgentManager {
  private agents: Map<string, AgentConfig> = new Map();
  private schedules: Map<string, ScheduledTask> = new Map();
  private scheduleTimers: Map<string, NodeJS.Timeout> = new Map();
  private globalRules: Map<string, string> = new Map(); // channelId -> rules
  private logger = new Logger('AgentManager');
  private scheduleCallback?: (task: ScheduledTask) => Promise<void>;

  constructor() {
    this.load();
    this.loadSchedules();
    this.loadGlobalRules();
  }

  setScheduleCallback(callback: (task: ScheduledTask) => Promise<void>): void {
    this.scheduleCallback = callback;
    // Restart timers for loaded schedules
    for (const task of this.schedules.values()) {
      this.startScheduleTimer(task);
    }
  }

  private getKey(name: string, channelId: string): string {
    return `${channelId}:${name}`;
  }

  private save(): void {
    try {
      const data: Record<string, AgentConfig> = {};
      for (const [key, agent] of this.agents.entries()) {
        data[key] = agent;
      }
      fs.writeFileSync(AGENTS_FILE, JSON.stringify(data, null, 2));
      this.logger.debug('Saved agents to disk', { count: this.agents.size });
    } catch (error) {
      this.logger.error('Failed to save agents to disk', error);
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(AGENTS_FILE)) return;
      const raw = fs.readFileSync(AGENTS_FILE, 'utf-8');
      const data: Record<string, AgentConfig> = JSON.parse(raw);
      for (const [key, agent] of Object.entries(data)) {
        agent.createdAt = new Date(agent.createdAt);
        this.agents.set(key, agent);
      }
      // Auto-assign colors to agents that don't have one (pre-color migration)
      for (const agent of this.agents.values()) {
        if (!agent.color) {
          const usedColors = this.listAgents(agent.channelId).filter(a => a.color).map(a => a.color);
          agent.color = AGENT_COLORS.find(c => !usedColors.includes(c)) || AGENT_COLORS[this.agents.size % AGENT_COLORS.length];
        }
      }
      this.logger.info('Loaded agents from disk', { count: this.agents.size });
    } catch (error) {
      this.logger.error('Failed to load agents from disk', error);
    }
  }

  private saveSchedules(): void {
    try {
      const data: Record<string, ScheduledTask> = {};
      for (const [key, task] of this.schedules.entries()) {
        data[key] = task;
      }
      fs.writeFileSync(SCHEDULES_FILE, JSON.stringify(data, null, 2));
      this.logger.debug('Saved schedules to disk', { count: this.schedules.size });
    } catch (error) {
      this.logger.error('Failed to save schedules to disk', error);
    }
  }

  private loadSchedules(): void {
    try {
      if (!fs.existsSync(SCHEDULES_FILE)) return;
      const raw = fs.readFileSync(SCHEDULES_FILE, 'utf-8');
      const data: Record<string, ScheduledTask> = JSON.parse(raw);
      for (const [key, task] of Object.entries(data)) {
        task.createdAt = new Date(task.createdAt);
        this.schedules.set(key, task);
      }
      this.logger.info('Loaded schedules from disk', { count: this.schedules.size });
    } catch (error) {
      this.logger.error('Failed to load schedules from disk', error);
    }
  }

  private saveGlobalRules(): void {
    try {
      const data: Record<string, string> = {};
      for (const [key, rules] of this.globalRules.entries()) {
        data[key] = rules;
      }
      fs.writeFileSync(GLOBAL_RULES_FILE, JSON.stringify(data, null, 2));
      this.logger.debug('Saved global rules to disk');
    } catch (error) {
      this.logger.error('Failed to save global rules to disk', error);
    }
  }

  private loadGlobalRules(): void {
    try {
      if (!fs.existsSync(GLOBAL_RULES_FILE)) return;
      const raw = fs.readFileSync(GLOBAL_RULES_FILE, 'utf-8');
      const data: Record<string, string> = JSON.parse(raw);
      for (const [key, rules] of Object.entries(data)) {
        this.globalRules.set(key, rules);
      }
      this.logger.info('Loaded global rules from disk', { count: this.globalRules.size });
    } catch (error) {
      this.logger.error('Failed to load global rules from disk', error);
    }
  }

  private startScheduleTimer(task: ScheduledTask): void {
    // Clear existing timer if any
    const existing = this.scheduleTimers.get(task.id);
    if (existing) clearInterval(existing);

    const timer = setInterval(async () => {
      if (this.scheduleCallback) {
        try {
          await this.scheduleCallback(task);
        } catch (error) {
          this.logger.error('Scheduled task failed', { taskId: task.id, error });
        }
      }
    }, task.intervalMs);

    this.scheduleTimers.set(task.id, timer);
    this.logger.info('Started schedule timer', { taskId: task.id, interval: task.intervalLabel });
  }

  createAgent(
    name: string,
    directory: string,
    channelId: string,
    userId: string,
    template?: string
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

    let rules: string | undefined;
    if (template) {
      const tmpl = TEMPLATES.find(t => t.name === template);
      if (!tmpl) {
        return { success: false, error: `Template "${template}" not found. Use \`list templates\` to see available templates.` };
      }
      rules = tmpl.rules;
    }

    const usedColors = this.listAgents(channelId).map(a => a.color);
    const color = AGENT_COLORS.find(c => !usedColors.includes(c)) || AGENT_COLORS[this.agents.size % AGENT_COLORS.length];

    const agent: AgentConfig = {
      name,
      workingDirectory: resolvedPath,
      channelId,
      createdBy: userId,
      createdAt: new Date(),
      rules,
      template,
      color,
    };

    this.agents.set(key, agent);
    this.save();
    this.logger.info('Agent created', { name, directory: resolvedPath, channelId, userId, template });
    return { success: true, agent };
  }

  removeAgent(name: string, channelId: string): { success: boolean; error?: string } {
    const key = this.getKey(name, channelId);
    if (!this.agents.has(key)) {
      return { success: false, error: `Agent "${name}" not found in this channel.` };
    }

    this.agents.delete(key);
    this.save();

    // Remove associated schedules
    for (const [id, task] of this.schedules.entries()) {
      if (task.agentName === name && task.channelId === channelId) {
        const timer = this.scheduleTimers.get(id);
        if (timer) clearInterval(timer);
        this.scheduleTimers.delete(id);
        this.schedules.delete(id);
      }
    }
    this.saveSchedules();

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

  setRules(name: string, channelId: string, rules: string): { success: boolean; error?: string } {
    const key = this.getKey(name, channelId);
    const agent = this.agents.get(key);
    if (!agent) {
      return { success: false, error: `Agent "${name}" not found in this channel.` };
    }
    agent.rules = rules;
    this.save();
    this.logger.info('Agent rules updated', { name, channelId });
    return { success: true };
  }

  clearRules(name: string, channelId: string): { success: boolean; error?: string } {
    const key = this.getKey(name, channelId);
    const agent = this.agents.get(key);
    if (!agent) {
      return { success: false, error: `Agent "${name}" not found in this channel.` };
    }
    delete agent.rules;
    delete agent.template;
    this.save();
    this.logger.info('Agent rules cleared', { name, channelId });
    return { success: true };
  }

  renameAgent(oldName: string, newName: string, channelId: string): { success: boolean; error?: string } {
    if (newName.toLowerCase() === 'all') {
      return { success: false, error: 'The name "all" is reserved and cannot be used for an agent.' };
    }

    const oldKey = this.getKey(oldName, channelId);
    const agent = this.agents.get(oldKey);
    if (!agent) {
      return { success: false, error: `Agent "${oldName}" not found in this channel.` };
    }

    const newKey = this.getKey(newName, channelId);
    if (this.agents.has(newKey)) {
      return { success: false, error: `Agent "${newName}" already exists in this channel.` };
    }

    agent.name = newName;
    this.agents.delete(oldKey);
    this.agents.set(newKey, agent);

    // Update associated schedules
    for (const task of this.schedules.values()) {
      if (task.agentName === oldName && task.channelId === channelId) {
        task.agentName = newName;
      }
    }
    this.saveSchedules();

    this.save();
    this.logger.info('Agent renamed', { oldName, newName, channelId });
    return { success: true };
  }

  setQuietMode(name: string, channelId: string, quiet: boolean): { success: boolean; error?: string } {
    const key = this.getKey(name, channelId);
    const agent = this.agents.get(key);
    if (!agent) {
      return { success: false, error: `Agent "${name}" not found in this channel.` };
    }
    agent.quietMode = quiet;
    this.save();
    this.logger.info('Agent quiet mode updated', { name, channelId, quiet });
    return { success: true };
  }

  setModel(name: string, channelId: string, model: AgentModel): { success: boolean; error?: string } {
    const key = this.getKey(name, channelId);
    const agent = this.agents.get(key);
    if (!agent) {
      return { success: false, error: `Agent "${name}" not found in this channel.` };
    }
    agent.model = model;
    this.save();
    this.logger.info('Agent model updated', { name, channelId, model });
    return { success: true };
  }

  setGlobalRules(channelId: string, rules: string): void {
    this.globalRules.set(channelId, rules);
    this.saveGlobalRules();
    this.logger.info('Global rules updated', { channelId });
  }

  clearGlobalRules(channelId: string): void {
    this.globalRules.delete(channelId);
    this.saveGlobalRules();
    this.logger.info('Global rules cleared', { channelId });
  }

  getGlobalRules(channelId: string): string | undefined {
    return this.globalRules.get(channelId);
  }

  addSchedule(
    agentName: string,
    channelId: string,
    message: string,
    intervalMs: number,
    intervalLabel: string,
    userId: string
  ): { success: boolean; task?: ScheduledTask; error?: string } {
    const agent = this.getAgent(agentName, channelId);
    if (!agent) {
      return { success: false, error: `Agent "${agentName}" not found in this channel.` };
    }

    const id = `sched_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const task: ScheduledTask = {
      id,
      agentName,
      channelId,
      message,
      intervalMs,
      intervalLabel,
      createdBy: userId,
      createdAt: new Date(),
    };

    this.schedules.set(id, task);
    this.saveSchedules();
    this.startScheduleTimer(task);

    return { success: true, task };
  }

  removeSchedule(scheduleId: string, channelId: string): { success: boolean; error?: string } {
    const task = this.schedules.get(scheduleId);
    if (!task || task.channelId !== channelId) {
      return { success: false, error: `Schedule "${scheduleId}" not found in this channel.` };
    }

    const timer = this.scheduleTimers.get(scheduleId);
    if (timer) clearInterval(timer);
    this.scheduleTimers.delete(scheduleId);
    this.schedules.delete(scheduleId);
    this.saveSchedules();

    return { success: true };
  }

  listSchedules(channelId: string): ScheduledTask[] {
    const result: ScheduledTask[] = [];
    for (const task of this.schedules.values()) {
      if (task.channelId === channelId) {
        result.push(task);
      }
    }
    return result;
  }

  getTemplates(): AgentTemplate[] {
    return TEMPLATES;
  }

  getTemplate(name: string): AgentTemplate | undefined {
    return TEMPLATES.find(t => t.name === name);
  }

  parseMessage(text: string, channelId: string): ParsedCommand {
    const trimmed = text.trim();

    // create agent <name> from <template> on <path>
    const createFromTemplateMatch = trimmed.match(/^create\s+agent\s+(\S+)\s+from\s+(\S+)\s+on\s+(.+)$/i);
    if (createFromTemplateMatch) {
      return {
        type: 'create_from_template',
        agentName: createFromTemplateMatch[1],
        targetAgent: createFromTemplateMatch[2], // template name
        args: createFromTemplateMatch[3].trim(),
      };
    }

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

    // rename agent <old> to <new>
    const renameMatch = trimmed.match(/^rename\s+agent\s+(\S+)\s+to\s+(\S+)$/i);
    if (renameMatch) {
      return { type: 'rename_agent', agentName: renameMatch[1], args: renameMatch[2] };
    }

    // global rules <text>
    const globalRulesMatch = trimmed.match(/^global\s+rules\s+(.+)$/is);
    if (globalRulesMatch) {
      return { type: 'set_global_rules', args: globalRulesMatch[1].trim() };
    }

    // clear global rules
    if (/^clear\s+global\s+rules$/i.test(trimmed)) {
      return { type: 'clear_global_rules' };
    }

    // show global rules
    if (/^(show\s+)?global\s+rules$/i.test(trimmed)) {
      return { type: 'show_global_rules' };
    }

    // set rules <name> <rules...>  or  rules <name> <rules...>
    const setRulesMatch = trimmed.match(/^(?:set\s+)?rules\s+(\S+)\s+(.+)$/is);
    if (setRulesMatch) {
      const agentName = setRulesMatch[1];
      if (this.getAgent(agentName, channelId)) {
        return { type: 'set_rules', agentName, args: setRulesMatch[2].trim() };
      }
    }

    // clear rules <name>
    const clearRulesMatch = trimmed.match(/^clear\s+rules\s+(\S+)$/i);
    if (clearRulesMatch) {
      return { type: 'clear_rules', agentName: clearRulesMatch[1] };
    }

    // quiet <name> on|off  or  quiet mode <name> on|off
    const quietMatch = trimmed.match(/^quiet\s+(?:mode\s+)?(\S+)\s+(on|off)$/i);
    if (quietMatch) {
      return { type: 'quiet_mode', agentName: quietMatch[1], args: quietMatch[2].toLowerCase() };
    }

    // model <name> opus|sonnet
    const modelMatch = trimmed.match(/^model\s+(\S+)\s+(opus|sonnet)$/i);
    if (modelMatch) {
      return { type: 'set_model', agentName: modelMatch[1], args: modelMatch[2].toLowerCase() };
    }

    // status <name>  or  agent status <name>
    const statusMatch = trimmed.match(/^(?:agent\s+)?status\s+(\S+)$/i);
    if (statusMatch) {
      const agentName = statusMatch[1];
      if (this.getAgent(agentName, channelId)) {
        return { type: 'agent_status', agentName };
      }
    }

    // schedule <agent> every <N> <unit> <message>
    const scheduleMatch = trimmed.match(/^schedule\s+(\S+)\s+every\s+(\d+)\s*(m|min|mins|minutes?|h|hrs?|hours?|d|days?)\s+(.+)$/is);
    if (scheduleMatch) {
      return {
        type: 'schedule',
        agentName: scheduleMatch[1],
        targetAgent: `${scheduleMatch[2]} ${scheduleMatch[3]}`, // interval
        args: scheduleMatch[4].trim(),
      };
    }

    // unschedule <id>
    const unscheduleMatch = trimmed.match(/^unschedule\s+(\S+)$/i);
    if (unscheduleMatch) {
      return { type: 'unschedule', args: unscheduleMatch[1] };
    }

    // list schedules
    if (/^(?:list\s+)?schedules?$/i.test(trimmed)) {
      return { type: 'list_schedules' };
    }

    // list templates
    if (/^(?:list\s+)?templates?$/i.test(trimmed)) {
      return { type: 'list_templates' };
    }

    // help
    if (/^(help|commands)$/i.test(trimmed)) {
      return { type: 'help' };
    }

    // list agents
    if (/^list\s+agents?$/i.test(trimmed)) {
      return { type: 'list_agents' };
    }

    // collab @<agent1> @<agent2> <task>
    const collabMatch = trimmed.match(/^collab\s+@(\S+)\s+@(\S+)\s+(.+)$/is);
    if (collabMatch) {
      const agent1 = collabMatch[1];
      const agent2 = collabMatch[2];
      if (this.getAgent(agent1, channelId) && this.getAgent(agent2, channelId)) {
        return { type: 'collaborate', agentName: agent1, targetAgent: agent2, args: collabMatch[3].trim() };
      }
    }

    // @all <message>
    const broadcastMatch = trimmed.match(/^@all\s+(.+)$/is);
    if (broadcastMatch) {
      return { type: 'broadcast', args: broadcastMatch[1].trim() };
    }

    // @<agent1> ask @<agent2> <message>
    const askAgentMatch = trimmed.match(/^@(\S+)\s+ask\s+@(\S+)\s+(.+)$/is);
    if (askAgentMatch) {
      const agentName = askAgentMatch[1];
      const targetAgent = askAgentMatch[2];
      if (this.getAgent(agentName, channelId) && this.getAgent(targetAgent, channelId)) {
        return { type: 'agent_ask_agent', agentName, targetAgent, args: askAgentMatch[3].trim() };
      }
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

    // Fallback: natural language parsing
    return this.naturalLanguageParse(trimmed, channelId);
  }

  private naturalLanguageParse(text: string, channelId: string): ParsedCommand {
    const lower = text.toLowerCase();
    const agents = this.listAgents(channelId);
    const agentNames = agents.map(a => a.name.toLowerCase());

    // Find agent name mentioned in text
    const findAgent = (): string | undefined => {
      for (const agent of agents) {
        if (lower.includes(agent.name.toLowerCase())) return agent.name;
      }
      return undefined;
    };

    // PRIORITY 1: If message starts with an agent name, it's a message TO that agent.
    // This MUST come first to prevent "lina ... remove comments" from being parsed as "remove agent lina".
    for (const agent of agents) {
      const namePattern = new RegExp(`^${agent.name}[,:]?\\s+(.+)$`, 'is');
      const match = text.match(namePattern);
      if (match) {
        return { type: 'agent_message', agentName: agent.name, args: match[1].trim() };
      }
    }

    // PRIORITY 2: "tell lina to ...", "ask lina about ..."
    if (/\b(tell|ask)\b/i.test(text)) {
      const agent = findAgent();
      if (agent) {
        const msgMatch = text.match(/(?:tell|ask)\s+\S+\s+(?:to|about|if|whether|that)?\s*(.+)$/is);
        if (msgMatch) {
          return { type: 'agent_message', agentName: agent, args: msgMatch[1].trim() };
        }
      }
    }

    // Global rules: "add a global rule ...", "make a rule for all agents ...", "all agents should ..."
    if (/\bglobal\s+rule|rule.*(all\s+agents|every\s+agent)|all\s+agents?\s+should|add\s+.*rule\s+.*(?:all|every|global)/i.test(text)) {
      // Extract the rule text — everything after the intent keywords
      const ruleMatch = text.match(/(?:rule[s]?\s*(?:that|to|:)?\s*|should\s+)(.+)$/is)
        || text.match(/(?:global\s+rule[s]?\s*)(.+)$/is);
      if (ruleMatch) {
        return { type: 'set_global_rules', args: ruleMatch[1].trim() };
      }
    }

    // Clear global rules
    if (/\b(clear|remove|delete)\b.*\bglobal\s+rule/i.test(text)) {
      return { type: 'clear_global_rules' };
    }

    // Show global rules
    if (/\b(show|display|what)\b.*\bglobal\s+rule/i.test(text)) {
      return { type: 'show_global_rules' };
    }

    // Per-agent rules: "add a rule to lina ...", "set lina's rules to ..."
    if (/\brule/i.test(text)) {
      const agent = findAgent();
      if (agent) {
        if (/\b(clear|remove|delete)\b.*\brules?\b/i.test(text)) {
          return { type: 'clear_rules', agentName: agent };
        }
        const ruleMatch = text.match(/(?:rule[s]?\s*(?:that|to|:)?\s*|should\s+)(.+)$/is);
        if (ruleMatch) {
          return { type: 'set_rules', agentName: agent, args: ruleMatch[1].trim() };
        }
      }
    }

    // Create agent: "make an agent called X on Y", "add agent X working on Y"
    if (/\b(create|make|add|new)\b.*\bagent\b/i.test(text)) {
      const createMatch = text.match(/agent\s+(?:called\s+|named\s+)?(\S+)\s+(?:on|for|in|working\s+on|at)\s+(.+)$/i);
      if (createMatch) {
        return { type: 'create_agent', agentName: createMatch[1], args: createMatch[2].trim() };
      }
    }

    // Remove agent: MUST include "agent" near "remove/delete" — e.g. "remove agent lina", "delete the agent lina"
    if (/\b(remove|delete|destroy)\b.*\bagent\b/i.test(text) || /\bagent\b.*\b(remove|delete|destroy)\b/i.test(text)) {
      const agent = findAgent();
      if (agent) {
        return { type: 'remove_agent', agentName: agent };
      }
    }

    // Rename agent: "rename lina to macy", "change lina's name to macy"
    if (/\b(rename|change\s+.*name)/i.test(text)) {
      const agent = findAgent();
      if (agent) {
        const newNameMatch = text.match(/\bto\s+(\S+)\s*$/i);
        if (newNameMatch) {
          return { type: 'rename_agent', agentName: agent, args: newNameMatch[1] };
        }
      }
    }

    // Quiet mode: "make lina quiet", "turn off quiet for lina", "mute lina"
    if (/\b(quiet|mute|silent)\b/i.test(text)) {
      const agent = findAgent();
      if (agent) {
        const off = /\b(off|disable|un-?mute|loud)\b/i.test(text);
        return { type: 'quiet_mode', agentName: agent, args: off ? 'off' : 'on' };
      }
    }

    // Model: "make lina fast", "switch lina to sonnet", "use opus for lina"
    if (/\b(fast|sonnet)\b/i.test(text)) {
      const agent = findAgent();
      if (agent) return { type: 'set_model', agentName: agent, args: 'sonnet' };
    }
    if (/\b(smart|opus)\b/i.test(text) && /\b(model|switch|use|set|make)\b/i.test(text)) {
      const agent = findAgent();
      if (agent) return { type: 'set_model', agentName: agent, args: 'opus' };
    }

    // Status: "how is lina doing", "what is lina's status", "is lina busy"
    if (/\b(status|how\s+is|doing|busy|idle)\b/i.test(text)) {
      const agent = findAgent();
      if (agent) return { type: 'agent_status', agentName: agent };
    }

    // List agents: "show me my agents", "what agents do I have", "who is here"
    if (/\b(show|list|what|which|who)\b.*\bagents?\b/i.test(text) || /\bwho\s+is\s+here\b/i.test(text)) {
      return { type: 'list_agents' };
    }

    // Help: "what can you do", "how does this work", "what commands"
    if (/\bwhat\s+can\s+you\s+do\b|\bhow\s+does\s+this\s+work\b|\bwhat\s+commands\b/i.test(text)) {
      return { type: 'help' };
    }

    // Templates: "what templates", "show templates"
    if (/\b(show|list|what|which)\b.*\btemplates?\b/i.test(text)) {
      return { type: 'list_templates' };
    }

    // Schedules: "show schedules", "what's scheduled"
    if (/\b(show|list|what)\b.*\bschedule/i.test(text)) {
      return { type: 'list_schedules' };
    }

    return { type: 'none' };
  }

  parseInterval(amount: string, unit: string): number | null {
    const num = parseInt(amount, 10);
    if (isNaN(num) || num <= 0) return null;

    const normalizedUnit = unit.toLowerCase().replace(/s$/, '');
    switch (normalizedUnit) {
      case 'm':
      case 'min':
      case 'minute':
        return num * 60 * 1000;
      case 'h':
      case 'hr':
      case 'hour':
        return num * 60 * 60 * 1000;
      case 'd':
      case 'day':
        return num * 24 * 60 * 60 * 1000;
      default:
        return null;
    }
  }

  formatAgentList(channelId: string, statuses?: Map<string, string>): string {
    const agents = this.listAgents(channelId);
    if (agents.length === 0) {
      return 'No agents configured in this channel. Use `create agent <name> on <path>` to add one.';
    }

    let message = `*Agents in this channel:*\n\n`;
    for (const agent of agents) {
      const status = statuses?.get(this.getKey(agent.name, channelId)) || 'idle';
      const statusEmoji = status === 'processing' ? ':gear:' : status === 'error' ? ':x:' : ':white_circle:';
      const quietLabel = agent.quietMode ? ' :mute:' : '';
      const templateLabel = agent.template ? ` [${agent.template}]` : '';
      const modelLabel = agent.model === 'sonnet' ? ' :zap:sonnet' : agent.model === 'opus' ? ' :brain:opus' : '';
      const rulesPreview = agent.rules ? ` — _has rules_` : '';
      message += `${statusEmoji} *${agent.name}*${templateLabel}${modelLabel}${quietLabel} — \`${agent.workingDirectory}\`${rulesPreview} (by <@${agent.createdBy}>)\n`;
    }
    message += `\nUse \`@<name> <message>\` to talk to a specific agent, or \`@all <message>\` to broadcast.`;
    return message;
  }

  formatAgentStatus(agent: AgentConfig, status: string, schedules: ScheduledTask[]): string {
    let message = `*Agent: ${agent.name}*\n`;
    message += `- *Status:* ${status}\n`;
    message += `- *Directory:* \`${agent.workingDirectory}\`\n`;
    message += `- *Created by:* <@${agent.createdBy}>\n`;
    message += `- *Created at:* ${agent.createdAt.toISOString()}\n`;
    message += `- *Model:* ${agent.model || 'default'} ${agent.model === 'sonnet' ? '(fast)' : agent.model === 'opus' ? '(smart)' : ''}\n`;
    message += `- *Quiet mode:* ${agent.quietMode ? 'on' : 'off'}\n`;
    if (agent.template) {
      message += `- *Template:* ${agent.template}\n`;
    }
    if (agent.rules) {
      message += `- *Rules:*\n\`\`\`\n${agent.rules}\n\`\`\`\n`;
    }
    if (schedules.length > 0) {
      message += `- *Scheduled tasks:*\n`;
      for (const task of schedules) {
        message += `  - \`${task.id}\` — every ${task.intervalLabel}: "${task.message}"\n`;
      }
    }
    return message;
  }

  formatScheduleList(channelId: string): string {
    const schedules = this.listSchedules(channelId);
    if (schedules.length === 0) {
      return 'No scheduled tasks. Use `schedule <agent> every <N> <unit> <message>` to add one.';
    }

    let message = `*Scheduled tasks:*\n\n`;
    for (const task of schedules) {
      message += `- \`${task.id}\` — *${task.agentName}* every ${task.intervalLabel}: "${task.message}" (by <@${task.createdBy}>)\n`;
    }
    message += `\nUse \`unschedule <id>\` to remove a scheduled task.`;
    return message;
  }

  formatTemplateList(): string {
    let message = `*Available templates:*\n\n`;
    for (const template of TEMPLATES) {
      message += `- *${template.name}* — ${template.description}\n`;
    }
    message += `\nUse \`create agent <name> from <template> on <path>\` to create an agent with a template.`;
    return message;
  }

  formatHelp(): string {
    let msg = `*Available Commands:*\n\n`;
    msg += `*Agent Management*\n`;
    msg += `\`create agent <name> on <path>\` — Create a new agent\n`;
    msg += `\`create agent <name> from <template> on <path>\` — Create from template\n`;
    msg += `\`remove agent <name>\` — Remove an agent\n`;
    msg += `\`rename agent <old> to <new>\` — Rename an agent\n`;
    msg += `\`list agents\` — List all agents in this channel\n\n`;
    msg += `*Agent Configuration*\n`;
    msg += `\`global rules <text>\` — Set rules for ALL agents\n`;
    msg += `\`clear global rules\` — Remove global rules\n`;
    msg += `\`show global rules\` — Show current global rules\n`;
    msg += `\`rules <agent> <text>\` — Set rules for a specific agent\n`;
    msg += `\`clear rules <agent>\` — Remove agent rules\n`;
    msg += `\`quiet <agent> on|off\` — Toggle quiet mode (suppress tool messages)\n` +
    `\`model <agent> opus|sonnet\` — Set model (opus = smart, sonnet = fast)\n`;
    msg += `\`status <agent>\` — Show agent details and status\n\n`;
    msg += `*Messaging*\n`;
    msg += `\`@<agent> <message>\` — Send a message to an agent\n`;
    msg += `\`@all <message>\` — Broadcast to all agents\n`;
    msg += `\`@<agent1> ask @<agent2> <question>\` — Agent-to-agent query\n` +
    `\`collab @<agent1> @<agent2> <task>\` — Multi-turn collaboration between agents\n\n`;
    msg += `*Scheduled Tasks*\n`;
    msg += `\`schedule <agent> every <N> <min|hours|days> <message>\` — Schedule a recurring task\n`;
    msg += `\`unschedule <id>\` — Remove a scheduled task\n`;
    msg += `\`schedules\` — List all scheduled tasks\n\n`;
    msg += `*Templates*\n`;
    msg += `\`templates\` — List available agent templates\n\n`;
    msg += `*Working Directory*\n`;
    msg += `\`cwd <path>\` — Set working directory\n`;
    msg += `\`cwd\` — Show current working directory\n\n`;
    msg += `*MCP Servers*\n`;
    msg += `\`mcp\` — Show MCP server info\n`;
    msg += `\`mcp reload\` — Reload MCP configuration\n\n`;
    msg += `Type \`help\` anytime to see this list.`;
    return msg;
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
