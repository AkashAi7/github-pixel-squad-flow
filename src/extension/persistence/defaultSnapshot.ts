import type { WorkspaceSnapshot } from '../../shared/model/index.js';

export function createDefaultSnapshot(): WorkspaceSnapshot {
  return {
    projectName: 'Pixel Squad',
    personas: [
      { id: 'frontend', title: 'Frontend', specialty: 'Interface systems', color: '#f25f5c' },
      { id: 'backend', title: 'Backend', specialty: 'APIs and runtime orchestration', color: '#247ba0' },
      { id: 'tester', title: 'Tester', specialty: 'Verification and regression pressure', color: '#70c1b3' },
      { id: 'lead', title: 'Lead', specialty: 'Routing and prioritization', color: '#ffe066' }
    ],
    rooms: [
      {
        id: 'briefing',
        name: 'Briefing Room',
        theme: 'Warm brass and paper walls',
        purpose: 'New work lands here before routing.',
        agentIds: ['lead-1']
      },
      {
        id: 'forge',
        name: 'Frontend Forge',
        theme: 'Neon drafting benches',
        purpose: 'UI, webview, motion, and layout work.',
        agentIds: ['frontend-1']
      },
      {
        id: 'engine',
        name: 'Backend Engine',
        theme: 'Grid floor with relay lights',
        purpose: 'Coordinator and adapter implementation.',
        agentIds: ['backend-1', 'tester-1']
      }
    ],
    agents: [
      {
        id: 'lead-1',
        name: 'Atlas',
        personaId: 'lead',
        provider: 'copilot',
        status: 'planning',
        roomId: 'briefing',
        summary: 'Breaking the product into rooms, adapters, and task flows.'
      },
      {
        id: 'frontend-1',
        name: 'Nova',
        personaId: 'frontend',
        provider: 'copilot',
        status: 'executing',
        roomId: 'forge',
        summary: 'Building the first room visualization and inspector surface.'
      },
      {
        id: 'backend-1',
        name: 'Tern',
        personaId: 'backend',
        provider: 'claude',
        status: 'idle',
        roomId: 'engine',
        summary: 'Waiting for real Claude session management to replace the stub.'
      },
      {
        id: 'tester-1',
        name: 'Mica',
        personaId: 'tester',
        provider: 'claude',
        status: 'waiting',
        roomId: 'engine',
        summary: 'Tracking bootstrap gaps and future adapter risks.'
      }
    ],
    tasks: [
      {
        id: 'task-1',
        title: 'Bootstrap extension host',
        status: 'done',
        assigneeId: 'backend-1',
        provider: 'copilot',
        source: 'factory',
        detail: 'Command, view container, bundle entry, and icon are defined.'
      },
      {
        id: 'task-2',
        title: 'Render first agent factory',
        status: 'active',
        assigneeId: 'frontend-1',
        provider: 'copilot',
        source: 'factory',
        detail: 'Rooms, personas, and tasks are visible in the panel.'
      },
      {
        id: 'task-3',
        title: 'Prepare Claude adapter seam',
        status: 'review',
        assigneeId: 'tester-1',
        provider: 'claude',
        source: 'factory',
        detail: 'Provider API is stable enough to swap in real spawning next.'
      }
    ],
    providers: [
      {
        provider: 'claude',
        state: 'stub',
        detail: 'Claude terminal spawning and transcript observation will land in the next slice.'
      },
      {
        provider: 'copilot',
        state: 'stub',
        detail: 'GitHub-model orchestration will be owned by Pixel Squad first; native Copilot mirroring stays experimental.'
      }
    ],
    activityFeed: [
      'Pixel Squad coordinator online.',
      'Webview handshake ready to receive state.',
      'Provider adapters registered in stub mode.'
    ]
  };
}
