/** Agent Teams service façade over roster, messaging, task, and runtime lifecycle owners. */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { TeamActivity } from './activity.ts'
import { errorMessage, TeamError } from './error.ts'
import { TeamJournal } from './journal.ts'
import { TeamRuntimeLifecycle } from './lifecycle.ts'
import { teamProjectionDefinition } from './projection.ts'
import { resolveActiveMember, TeamRoster } from './roster.ts'
import type { TeamMembership } from './roster.ts'
import { TeamTaskBoard } from './task-board.ts'
import { TeamId, TeamTaskId } from './types.ts'
import type {
  Config,
  CreateTeamTaskRequest,
  SendTeamMessageRequest,
  SendTeamMessageResult,
  SpawnTeammateRequest,
  SpawnTeammateResult,
  TeamMemberView,
  TeamTaskView,
  TeamWaitResult,
  UpdateTeamTaskRequest,
} from './types.ts'

export type * from './types.ts'
export type { TeamMembership } from './roster.ts'
export { TeamId, TeamMessageId, TeamTaskId } from './types.ts'
export { TeamError } from './error.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    agentTeams: TeamService
  }
}

const DEFAULT_MAX_MEMBERS = 16
const DEFAULT_MAX_TASKS = 256
const DEFAULT_MAX_MESSAGE_BYTES = 65_536
const DEFAULT_DISPOSAL_TIMEOUT_MS = 5_000
const DEFAULT_TIMELINE_LIMIT = 64
const DEFAULT_TIMELINE_CONTENT_BYTES = 1_024

/** Validate one positive safe-integer deployment limit. */
function positiveLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TeamError(`${name} must be a positive safe integer`, 'TEAM_INVALID_CONFIG')
  }
  return value
}

/**
 * Bound one text to a UTF-8 byte budget without splitting a surrogate pair.
 * @param text - complete source text.
 * @param maxBytes - UTF-8 byte budget.
 * @returns the longest prefix within the budget and whether text was cut.
 */
export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  let bytes = 0
  let kept = ''
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) return { text: kept, truncated: true }
    bytes += size
    kept += char
  }
  return { text: kept, truncated: false }
}

/** Agent Teams service backed by the exact live Lead Session log. */
export class TeamService extends Service {
  static inject = ['agents', 'sessions', 'sessionPersistence', 'sessionProjections', 'subagents']

  static Config: z<Config> = z.object({
    maxMembers: z.number().step(1).min(1).default(DEFAULT_MAX_MEMBERS),
    maxTasks: z.number().step(1).min(1).default(DEFAULT_MAX_TASKS),
    maxMessageBytes: z.number().step(1).min(1).default(DEFAULT_MAX_MESSAGE_BYTES),
    disposalTimeoutMs: z.number().step(1).min(1).default(DEFAULT_DISPOSAL_TIMEOUT_MS),
    timelineLimit: z.number().step(1).min(1).default(DEFAULT_TIMELINE_LIMIT),
    timelineContentBytes: z.number().step(1).min(1).default(DEFAULT_TIMELINE_CONTENT_BYTES),
  })

  /** Validated deployment limits used by every Team operation. */
  private readonly config: Required<Config>

  private readonly activity: TeamActivity
  private readonly lifecycle: TeamRuntimeLifecycle
  private readonly journal: TeamJournal
  private readonly roster: TeamRoster
  private readonly tasks: TeamTaskBoard

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'agentTeams')
    this.config = {
      maxMembers: positiveLimit('maxMembers', config.maxMembers ?? DEFAULT_MAX_MEMBERS),
      maxTasks: positiveLimit('maxTasks', config.maxTasks ?? DEFAULT_MAX_TASKS),
      maxMessageBytes: positiveLimit('maxMessageBytes', config.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES),
      disposalTimeoutMs: positiveLimit(
        'disposalTimeoutMs',
        config.disposalTimeoutMs ?? DEFAULT_DISPOSAL_TIMEOUT_MS,
      ),
      timelineLimit: positiveLimit('timelineLimit', config.timelineLimit ?? DEFAULT_TIMELINE_LIMIT),
      timelineContentBytes: positiveLimit(
        'timelineContentBytes',
        config.timelineContentBytes ?? DEFAULT_TIMELINE_CONTENT_BYTES,
      ),
    }

    this.activity = new TeamActivity()
    this.lifecycle = new TeamRuntimeLifecycle(this.config.disposalTimeoutMs)
    this.journal = new TeamJournal(ctx, (root) => { this.activity.notify(TeamId(root.id)) })
    this.roster = new TeamRoster(ctx, this.journal, this.lifecycle, this.config.maxMembers)
    this.tasks = new TeamTaskBoard(this.journal, this.config.maxTasks)

    ctx.on('agent/created', ({ agent }) => { this.scheduleRecovery(agent) })
    ctx.on('agent/status', ({ agent }) => {
      const membership = this.roster.tryMembership(agent)
      if (membership !== undefined) this.activity.notify(membership.id)
    })
    ctx.effect(() => {
      const disposeProjection = ctx.root.sessionProjections.register(teamProjectionDefinition(this.config.timelineLimit))
      return async () => {
        try {
          await this.disposeRuntime()
        } finally {
          disposeProjection()
        }
      }
    }, 'agentTeams.runtimeLifecycle()')
    for (const agent of ctx.agents.list()) this.scheduleRecovery(agent)
  }

  /**
   * Resolve one exact live Agent's Team role.
   * @param agent - exact live Agent used as the authority credential.
   * @returns its root, Team identity, role, and model-facing name.
   */
  membership(agent: Agent): TeamMembership {
    return this.roster.membership(agent)
  }

  /**
   * List the runtime-enriched roster visible to one Team member.
   * @param agent - exact live Team member.
   * @returns Lead and teammate rows in creation order.
   */
  listMembers(agent: Agent): TeamMemberView[] {
    return this.roster.list(this.roster.membership(agent))
  }

  /**
   * Create one named, continuable direct child of the Team Lead.
   * @param caller - exact live Lead Agent.
   * @param request - immutable name, description, prompt, context mode, provider, and cancellation.
   * @returns the active roster row.
   */
  async spawnTeammate(caller: Agent, request: SpawnTeammateRequest): Promise<SpawnTeammateResult> {
    return await this.roster.spawn(caller, request)
  }

  /**
   * Steer one peer message into the target inbox or reject the attempt.
   * @param caller - exact live sending Team member.
   * @param request - target name, content, and cancellation before acceptance.
   * @returns accepted inbox identity; acceptance follows normal Agent persistence and does not await model processing.
   */
  async sendMessage(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    if (this.lifecycle.disposed) throw new TeamError('Agent Teams service is disposing', 'TEAM_DISPOSED')
    return await this.lifecycle.track(this.sendAdmitted(caller, {
      ...request,
      signal: AbortSignal.any([request.signal, this.lifecycle.signal]),
    }))
  }

  /**
   * Create one unowned pending task in the Team Lead log.
   * @param caller - exact live Team member creating the task.
   * @param request - task text, blockers, and advisory write scopes.
   * @returns the revision-one task view.
   */
  async createTask(caller: Agent, request: CreateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.create(this.roster.membership(caller), request)
  }

  /**
   * Return one task, including a deleted tombstone.
   * @param caller - exact live Team member reading the task.
   * @param id - Team-local task identity.
   * @returns the latest task value and derived readiness diagnostics.
   */
  getTask(caller: Agent, id: TeamTaskId): TeamTaskView {
    return this.tasks.get(this.roster.membership(caller), id)
  }

  /**
   * List current non-deleted tasks in numeric creation order.
   * @param caller - exact live Team member reading the board.
   * @returns detached current task views.
   */
  listTasks(caller: Agent): TeamTaskView[] {
    return this.tasks.list(this.roster.membership(caller))
  }

  /**
   * Compare-and-set one authorized task transition.
   * @param caller - exact live Team member authorizing the mutation.
   * @param request - task identity, expected revision, action, and action fields.
   * @returns the committed next task revision.
   */
  async updateTask(caller: Agent, request: UpdateTeamTaskRequest): Promise<TeamTaskView> {
    return await this.tasks.update(caller, this.roster.membership(caller), request)
  }

  /**
   * Wait for the next Team-domain or member-status change.
   * @param caller - exact live Team member waiting for activity.
   * @param timeoutMs - bounded wait duration from ten seconds through one hour.
   * @param signal - caller cancellation for the wait only.
   * @returns one observed change or a timeout result.
   */
  async waitForChange(caller: Agent, timeoutMs: number, signal: AbortSignal): Promise<TeamWaitResult> {
    const membership = this.roster.membership(caller)
    return await this.activity.wait(membership.id, timeoutMs, signal)
  }

  /**
   * Interrupt one live teammate turn without clearing its pending inbox.
   * @param caller - exact live Lead Agent.
   * @param targetName - durable teammate name.
   * @returns the target status sampled before cancellation.
   */
  interrupt(caller: Agent, targetName: string): { previousStatus: 'running' | 'inactive' } {
    return this.roster.interrupt(caller, targetName)
  }

  /**
   * Resolve a caller without throwing, used by scoped-tool installation and observers.
   * @param agent - candidate exact live Agent.
   * @returns Team membership, or undefined for non-Team subagents and stale identities.
   */
  tryMembership(agent: Agent): TeamMembership | undefined {
    return this.roster.tryMembership(agent)
  }

  /** Deliver an admitted send using the Lead's authority and the actual sender's identity. */
  private async sendAdmitted(caller: Agent, request: SendTeamMessageRequest): Promise<SendTeamMessageResult> {
    const membership = this.roster.membership(caller)
    request.signal.throwIfAborted()
    const { root } = membership
    const target = resolveActiveMember(root, this.journal.state(root), request.target)
    if (target.id === caller.id) throw new TeamError('a Team member cannot message itself', 'TEAM_SELF_MESSAGE')
    const content = [
      { type: 'text' as const, text: `Team message from ${membership.name}:` },
      ...structuredClone(request.content),
    ]
    if (Buffer.byteLength(JSON.stringify(content), 'utf8') > this.config.maxMessageBytes) {
      throw new TeamError(`team message exceeds ${this.config.maxMessageBytes} bytes`, 'TEAM_MESSAGE_TOO_LARGE')
    }
    const source = { kind: 'agent-message' as const, form: 'relay' as const, senderSessionId: caller.id }
    let messageId
    if (target.id === root.id) {
      const input = createUserMessage({ content, source })
      root.steer(input)
      messageId = input.id
    } else {
      messageId = await steerHostSubagentPrompt(this.ctx.subagents, root, target.id, content, source, request.signal)
    }
    this.recordSend(caller, membership, target, messageId, request.content)
    this.activity.notify(membership.id)
    return { messageId }
  }

  /**
   * Retain one display summary after an accepted send. Best effort: an
   * already-accepted send succeeds even when the record append fails, which
   * leaves a timeline gap without affecting the message. Record durability
   * follows ordinary Session persistence, like the direct-inbox acceptance.
   * @param caller - exact live sending Team member.
   * @param membership - resolved sender membership.
   * @param target - resolved durable target identity.
   * @param messageId - accepted inbox identity.
   * @param content - sender content without the delivery frame.
   */
  private recordSend(
    caller: Agent,
    membership: TeamMembership,
    target: { id: SessionId; name: string },
    messageId: MessageId,
    content: ContentBlock[],
  ): void {
    try {
      const firstText = content.find(block => block.type === 'text')
      const summary = truncateUtf8(firstText?.type === 'text' ? firstText.text : '', this.config.timelineContentBytes)
      appendPluginRecord(membership.root.session, 'plugin:agent-team/message-sent', {
        version: 1,
        teamId: membership.id,
        record: {
          messageId,
          senderId: caller.id,
          senderName: membership.name,
          targetId: target.id,
          targetName: target.name,
          content: summary.text,
          truncated: summary.truncated,
        },
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`Agent Teams timeline record failed: ${errorMessage(error)}`)
    }
  }

  /** Queue one contained provisioning reconciliation after publication has unwound. */
  private scheduleRecovery(agent: Agent): void {
    queueMicrotask(() => {
      if (this.lifecycle.disposed) return
      void this.roster.recoverFor(agent, this.lifecycle.signal).catch((error: unknown) => {
        if (this.lifecycle.disposed) return
        this.ctx.logger.warn(`Agent Teams recovery for "${agent.id}" failed: ${errorMessage(error)}`)
      })
    })
  }

  /** Stop Team-owned live branches and release every waiter before service disposal completes. */
  private async disposeRuntime(): Promise<void> {
    this.lifecycle.close()
    this.activity.close()

    const failures: unknown[] = []
    await this.lifecycle.settle(this.lifecycle.pending(), failures)
    for (const [root, childIds] of this.roster.liveChildrenByRoot()) {
      try {
        await this.roster.stopTeammates(root, childIds)
      } catch (error: unknown) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Agent Teams runtime disposal failed')
  }
}

export default TeamService
