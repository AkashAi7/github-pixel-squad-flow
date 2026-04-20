import { CopilotClient, type AssistantMessageEvent, type CopilotSession } from '@github/copilot-sdk';

export interface CopilotSdkRequestOptions {
  model?: string;
  prompt: string;
  stream?: (chunk: string) => void;
  cwd?: string;
}

export interface CopilotSdkResponse {
  content: string;
  sessionId: string;
  model: string;
}

const DEFAULT_MODEL = 'gpt-5';

function normalizeModel(model?: string): string {
  const candidate = (model ?? '').trim();
  return candidate || DEFAULT_MODEL;
}

function extractAssistantText(event: AssistantMessageEvent | undefined): string {
  if (!event) {
    return '';
  }

  const { content } = event.data;
  return typeof content === 'string' ? content : String(content ?? '');
}

export async function runCopilotSdkPrompt(options: CopilotSdkRequestOptions): Promise<CopilotSdkResponse> {
  const client = new CopilotClient({
    cliPath: 'copilot',
    cwd: options.cwd,
  });

  let session: CopilotSession | undefined;
  try {
    session = await client.createSession({
      model: normalizeModel(options.model),
      streaming: Boolean(options.stream),
    });

    if (options.stream) {
      session.on('assistant.message_delta', (event) => {
        const chunk = event.data.deltaContent ?? '';
        if (chunk) {
          options.stream?.(chunk);
        }
      });
    }

    const response = await session.sendAndWait({ prompt: options.prompt }, 90_000);

    return {
      content: extractAssistantText(response),
      sessionId: session.sessionId,
      model: normalizeModel(options.model),
    };
  } finally {
    if (session) {
      await session.disconnect().catch(() => undefined);
    }
    await client.stop().catch(() => []);
  }
}