import type { PersonaTemplate } from '../../shared/model/index.js';
import type { PersonaAssignment } from './types.js';

const KEYWORD_SKILL_HINTS: Record<string, string[]> = {
  frontend: ['ui', 'frontend', 'webview', 'layout', 'component', 'css', 'design'],
  backend: ['backend', 'api', 'data', 'runtime', 'persist', 'storage', 'coordinator'],
  tester: ['test', 'verify', 'validation', 'regression', 'qa', 'failure'],
  lead: ['plan', 'route', 'coordination', 'prioritize', 'break down'],
  devops: ['deploy', 'release', 'pipeline', 'ci', 'infra', 'devops'],
  designer: ['ux', 'research', 'visual', 'design', 'copy', 'journey'],
};

const PERSONA_ROUTE_ALIASES: Array<{ personaId: string; aliases: string[] }> = [
  { personaId: 'lead', aliases: ['lead'] },
  { personaId: 'frontend', aliases: ['frontend', 'front end'] },
  { personaId: 'backend', aliases: ['backend', 'back end'] },
  { personaId: 'tester', aliases: ['tester', 'testing', 'qa'] },
  { personaId: 'devops', aliases: ['devops', 'dev ops'] },
  { personaId: 'designer', aliases: ['designer', 'design'] },
];

function normalizeText(value: string): string {
  return value.trim().toLowerCase();
}

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function includesAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function hasSplitAssignmentIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return /\b(create\s*tasks?|createtask|assign(?:ments?|ed|ing)?|split|handoff|delegate|route)\b/.test(lower)
    || includesAny(lower, ['front end', 'frontend', 'back end', 'backend', 'tester', 'testers', 'testing', 'devops', 'designer']);
}

function matchPersonaAlias(value: string, personas: PersonaTemplate[]): string | undefined {
  const normalized = normalizeText(value).replace(/\s+/g, ' ');
  const matched = PERSONA_ROUTE_ALIASES.find((candidate) => candidate.aliases.includes(normalized));
  if (!matched) {
    return undefined;
  }
  return personas.some((persona) => persona.id === matched.personaId) ? matched.personaId : undefined;
}

export function tryDirectPersonaRoute(prompt: string, personas: PersonaTemplate[]): { personaId: string; prompt: string } | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return undefined;
  }

  const prefixMatch = trimmed.match(/^(?:@|\/)(lead|frontend|front end|backend|back end|tester|testing|qa|devops|dev ops|designer|design)\b\s*(?<detail>.+)$/i);
  if (prefixMatch?.[1]) {
    const personaId = matchPersonaAlias(prefixMatch[1], personas);
    const detail = prefixMatch.groups?.detail?.trim();
    if (personaId && detail) {
      return { personaId, prompt: detail };
    }
  }

  const labeledMatch = trimmed.match(/^(lead|frontend|front end|backend|back end|tester|testing|qa|devops|dev ops|designer|design)\s*[:\-]\s*(?<detail>.+)$/i);
  if (labeledMatch?.[1]) {
    const personaId = matchPersonaAlias(labeledMatch[1], personas);
    const detail = labeledMatch.groups?.detail?.trim();
    if (personaId && detail) {
      return { personaId, prompt: detail };
    }
  }

  const delegateMatch = trimmed.match(/^(?:assign|route|delegate)\s+(?:this|it|task)?\s*(?:to\s+)?(lead|frontend|front end|backend|back end|tester|testing|qa|devops|dev ops|designer|design)\b\s*[:\-]?\s*(?<detail>.+)$/i);
  if (delegateMatch?.[1]) {
    const personaId = matchPersonaAlias(delegateMatch[1], personas);
    const detail = delegateMatch.groups?.detail?.trim();
    if (personaId && detail) {
      return { personaId, prompt: detail };
    }
  }

  return undefined;
}

function personaSkillIds(persona: PersonaTemplate): string[] {
  return persona.skills?.map((skill) => skill.id) ?? [];
}

export function describePersonasForPrompt(personas: PersonaTemplate[]): string {
  return personas
    .map((persona) => {
      const skills = persona.skills?.map((skill) => `${skill.id} (${skill.label} L${skill.level})`).join(', ') ?? 'none';
      return `${persona.id} (${persona.title}: ${persona.specialty}; skills: ${skills})`;
    })
    .join(', ');
}

export function inferRequiredSkillIds(
  persona: PersonaTemplate | undefined,
  prompt: string,
  title: string,
  detail: string,
): string[] {
  if (!persona) {
    return [];
  }

  const haystack = `${prompt} ${title} ${detail}`.toLowerCase();
  const personaHints = KEYWORD_SKILL_HINTS[persona.id] ?? [];
  const matchedFromPersona = personaSkillIds(persona).filter((skillId) => {
    const skill = persona.skills?.find((entry) => entry.id === skillId);
    const tokens = [skillId, skill?.label ?? '', persona.title, persona.specialty, ...personaHints]
      .flatMap((value) => normalizeText(value).split(/[^a-z0-9]+/))
      .filter(Boolean);

    return tokens.some((token) => token.length > 2 && haystack.includes(token));
  });

  if (matchedFromPersona.length > 0) {
    return unique(matchedFromPersona).slice(0, 2);
  }

  return personaSkillIds(persona).slice(0, 2);
}

export function enrichAssignments(
  assignments: PersonaAssignment[],
  personas: PersonaTemplate[],
  prompt: string,
): PersonaAssignment[] {
  const personaIds = new Set(personas.map((persona) => persona.id));
  const personaMap = new Map(personas.map((persona) => [persona.id, persona]));

  return assignments.slice(0, 3).map((assignment, _index) => {
    const persona = personaMap.get(assignment.personaId);
    // Only use explicit deps supplied by the planner — never infer sequential chaining
    // from position. Tasks with no stated dependencies are free to run in parallel.
    const normalizedDependencies = unique(
      (assignment.dependsOnPersonaIds ?? []).filter((value) => value !== assignment.personaId && personaIds.has(value))
    );

    const normalizedSkillIds = unique(
      (assignment.requiredSkillIds ?? []).filter((skillId) => personaSkillIds(persona ?? { id: '', title: '', specialty: '', color: '' }).includes(skillId))
    );

    return {
      ...assignment,
      dependsOnPersonaIds: normalizedDependencies,
      requiredSkillIds: normalizedSkillIds.length > 0
        ? normalizedSkillIds
        : inferRequiredSkillIds(persona, prompt, assignment.title, assignment.detail),
      progressLabel: assignment.progressLabel?.trim() || defaultProgressLabel(_index),
    };
  });
}

export function createDeterministicAssignments(prompt: string, personas: PersonaTemplate[]): PersonaAssignment[] {
  const lower = prompt.toLowerCase();
  const assignments: PersonaAssignment[] = [];
  const has = (value: string): boolean => lower.includes(value);
  const hasAnyKeyword = (...values: string[]): boolean => values.some((value) => has(value));
  const ensure = (personaId: string, title: string, detail: string): void => {
    if (assignments.some((assignment) => assignment.personaId === personaId)) {
      return;
    }
    if (!personas.some((persona) => persona.id === personaId)) {
      return;
    }
    assignments.push({ personaId, title, detail });
  };

  ensure('lead', 'Shape the delivery plan', `Break down the request and coordinate the implementation path for: ${prompt}`);
  if (hasAnyKeyword('ui', 'frontend', 'front end', 'webview', 'design', 'theme')) {
    ensure('frontend', 'Build the interface slice', 'Implement the visible user experience, interaction states, and view wiring for the request.');
  }
  if (hasAnyKeyword('api', 'backend', 'back end', 'persist', 'storage', 'coordinator') || assignments.length < 2) {
    ensure('backend', 'Implement the runtime changes', 'Update extension-host, coordinator, persistence, or provider logic needed to support the request.');
  }
  if (hasAnyKeyword('test', 'tester', 'testing', 'verify', 'qa', 'regression') || assignments.length < 3) {
    ensure('tester', 'Validate the flow', 'Check error handling, smoke-test the feature, and call out any residual risks or regressions.');
  }

  return enrichAssignments(assignments.slice(0, 3), personas, prompt);
}

/**
 * Returns a single-assignment fast-route plan when the prompt clearly maps to
 * one persona with high keyword confidence, eliminating the LLM planning call.
 *
 * Returns undefined when the prompt is ambiguous or multi-domain (caller should
 * fall through to the LLM planner).
 */
export function tryFastRoute(prompt: string, personas: PersonaTemplate[]): PersonaAssignment[] | undefined {
  const lower = prompt.toLowerCase();
  const planningIntent = /\b(plan|strategy|roadmap|proposal|architecture|approach|business plan|deployment plan|migration plan|design doc|outline)\b/.test(lower);
  const implementationIntent = /\b(write|implement|fix|edit|modify|change|run|execute|test|refactor|build|code|ship|patch|debug|install)\b/.test(lower);
  const splitAssignmentIntent = hasSplitAssignmentIntent(prompt);

  if (splitAssignmentIntent) {
    return createDeterministicAssignments(prompt, personas);
  }

  if (planningIntent && !implementationIntent) {
    const leadPersona = personas.find((persona) => persona.id === 'lead');
    if (leadPersona) {
      return [{
        personaId: 'lead',
        title: 'Draft the delivery plan',
        detail: prompt,
        dependsOnPersonaIds: [],
        requiredSkillIds: inferRequiredSkillIds(leadPersona, prompt, 'Draft the delivery plan', prompt),
        progressLabel: 'Ready to start',
      }];
    }
  }

  const FAST_ROUTE_BINS: Array<{ personaId: string; keywords: string[]; title: string; detail: string }> = [
    {
      personaId: 'lead',
      keywords: ['plan', 'roadmap', 'proposal', 'approach', 'strategy', 'outline'],
      title: 'Planning task',
      detail: prompt,
    },
    {
      personaId: 'frontend',
      keywords: ['frontend', 'front end', 'ui', 'webview', 'component', 'layout', 'css', 'theme'],
      title: 'Frontend task',
      detail: prompt,
    },
    {
      personaId: 'backend',
      keywords: ['backend', 'back end', 'api', 'runtime', 'coordinator', 'persist', 'storage', 'service'],
      title: 'Backend task',
      detail: prompt,
    },
    {
      personaId: 'tester',
      keywords: ['test', 'tester', 'testing', 'regression', 'qa', 'verify', 'validation', 'spec', 'coverage', 'failing test'],
      title: 'Validate and test',
      detail: prompt,
    },
    {
      personaId: 'devops',
      keywords: ['deploy', 'ci', 'pipeline', 'infra', 'docker', 'release', 'workflow', 'yml', 'yaml', 'github action', 'azure', 'vm', 'iac'],
      title: 'DevOps task',
      detail: prompt,
    },
    {
      personaId: 'designer',
      keywords: ['design', 'ux', 'wireframe', 'mockup', 'journey', 'copy', 'typography', 'visual'],
      title: 'Design task',
      detail: prompt,
    },
  ];

  // Count domain hits across bins
  const hits = FAST_ROUTE_BINS.map((bin) => ({
    bin,
    score: bin.keywords.filter((kw) => lower.includes(kw)).length,
  })).filter((h) => h.score > 0);

  // Only fast-route when exactly one domain wins with score >= 2 (clear unambiguous match)
  if (hits.length !== 1 || hits[0].score < 2) {
    return undefined;
  }

  const winner = hits[0].bin;
  const persona = personas.find((p) => p.id === winner.personaId);
  if (!persona) {
    return undefined;
  }

  return [{
    personaId: winner.personaId,
    title: winner.title,
    detail: winner.detail,
    dependsOnPersonaIds: [],
    requiredSkillIds: inferRequiredSkillIds(persona, prompt, winner.title, winner.detail),
    progressLabel: 'Ready to start',
  }];
}

function defaultProgressLabel(_index: number): string {
  return 'Ready to start';
}