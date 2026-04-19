import type { AgentMessage, AgentMessageType } from '../../shared/model/index.js';

/**
 * In-memory mailbox for inter-agent messaging.
 *
 * Each agent has an inbox (FIFO queue). The Coordinator routes outgoing
 * messages produced by one LM turn into the target agent's inbox so
 * the next turn (or next task execution) can consume them.
 */
export class AgentMailbox {
  private readonly inboxes = new Map<string, AgentMessage[]>();
  /** Persistent per-room feed of every message sent (for UI Room Chat). */
  private readonly roomFeeds = new Map<string, AgentMessage[]>();
  private static readonly MAX_FEED_PER_ROOM = 200;

  /** Append a message to the target agent's inbox and to the room feed. */
  send(message: AgentMessage): void {
    const queue = this.inboxes.get(message.toAgentId) ?? [];
    queue.push(message);
    this.inboxes.set(message.toAgentId, queue);
    if (message.roomId) {
      const feed = this.roomFeeds.get(message.roomId) ?? [];
      feed.push(message);
      if (feed.length > AgentMailbox.MAX_FEED_PER_ROOM) {
        feed.splice(0, feed.length - AgentMailbox.MAX_FEED_PER_ROOM);
      }
      this.roomFeeds.set(message.roomId, feed);
    }
  }

  /** Drain (consume) all unread messages for an agent. Returns them and clears the inbox. */
  drain(agentId: string): AgentMessage[] {
    const queue = this.inboxes.get(agentId) ?? [];
    this.inboxes.set(agentId, []);
    return queue;
  }

  /** Peek at pending messages without consuming them. */
  peek(agentId: string): readonly AgentMessage[] {
    return this.inboxes.get(agentId) ?? [];
  }

  /** Number of pending messages for an agent. */
  count(agentId: string): number {
    return (this.inboxes.get(agentId) ?? []).length;
  }

  /**
   * Broadcast a message from one agent to all other agents in the same room.
   * Returns the created messages.
   */
  broadcastToRoom(
    fromAgentId: string,
    roomId: string,
    roomAgentIds: string[],
    content: string,
    type: AgentMessageType = 'inform',
    taskId?: string,
  ): AgentMessage[] {
    const messages: AgentMessage[] = [];
    for (const targetId of roomAgentIds) {
      if (targetId === fromAgentId) { continue; }
      const msg: AgentMessage = {
        id: `msg-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
        fromAgentId,
        toAgentId: targetId,
        roomId,
        type,
        content,
        taskId,
        timestamp: Date.now(),
      };
      this.send(msg);
      messages.push(msg);
    }
    return messages;
  }

  /** Clear all inboxes (used on workspace reset). */
  clear(): void {
    this.inboxes.clear();
    this.roomFeeds.clear();
  }

  /** Return a snapshot of every room feed keyed by roomId. */
  getAllRoomFeeds(): Record<string, AgentMessage[]> {
    const out: Record<string, AgentMessage[]> = {};
    for (const [roomId, messages] of this.roomFeeds.entries()) {
      out[roomId] = messages.slice();
    }
    return out;
  }
}
