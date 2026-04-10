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
        purpose: 'Coordinator, API, and persistence work.',
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
        status: 'idle',
        roomId: 'forge',
        summary: 'Ready for UI and webview tasks.'
      },
      {
        id: 'backend-1',
        name: 'Tern',
        personaId: 'backend',
        provider: 'copilot',
        status: 'idle',
        roomId: 'engine',
        summary: 'Ready for API and runtime tasks.'
      },
      {
        id: 'tester-1',
        name: 'Mica',
        personaId: 'tester',
        provider: 'copilot',
        status: 'idle',
        roomId: 'engine',
        summary: 'Ready for verification and testing tasks.'
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
        status: 'done',
        assigneeId: 'frontend-1',
        provider: 'copilot',
        source: 'factory',
        detail: 'Rooms, personas, and tasks are visible in the panel.'
      },
      {
        id: 'task-3',
        title: 'Wire Copilot planning pipeline',
        status: 'done',
        assigneeId: 'lead-1',
        provider: 'copilot',
        source: 'factory',
        detail: 'Task routing uses GitHub Copilot model for planning.'
      }
    ],
    providers: [
      {
        provider: 'copilot',
        state: 'ready',
        detail: 'GitHub Copilot powers all planning and task execution.'
      }
    ],
    activityFeed: [
      'Pixel Squad coordinator online.',
      'All agents powered by GitHub Copilot.',
      'Factory ready — route a task to begin.'
    ],
    settings: {
      autoExecute: false,
      modelFamily: 'copilot',
    }
  };
}
