import { type OllamaClient } from '@ticket/model-provider';
import { BaseLlm, type LlmRequest, type LlmResponse } from './adk.js';

/** ADK model that sends one non-streaming JSON chat call through the Ollama client. */
export class OllamaLlm extends BaseLlm {
  static override readonly supportedModels: (string | RegExp)[] = [];

  constructor(private readonly ollama: OllamaClient) {
    super({ model: ollama.config.model });
  }

  override async *generateContentAsync(
    llmRequest: LlmRequest,
    _stream?: boolean,
    abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    try {
      const text = await this.ollama.generate(
        {
          system: instructionText(llmRequest),
          user: lastUserText(llmRequest),
        },
        abortSignal,
      );
      if (abortSignal?.aborted) return;
      yield { content: { role: 'model', parts: [{ text }] }, turnComplete: true };
    } catch (error) {
      if (abortSignal?.aborted) return;
      yield {
        errorCode: 'OLLAMA_ERROR',
        errorMessage: error instanceof Error ? error.message : 'The model request failed.',
        turnComplete: true,
      };
    }
  }

  override connect(): Promise<never> {
    return Promise.reject(new Error(`${this.model} does not support live connections.`));
  }
}

function instructionText(request: LlmRequest): string {
  const instruction = request.config?.systemInstruction;
  if (typeof instruction === 'string') return instruction;
  const parts = instruction && 'parts' in instruction ? instruction.parts : undefined;
  return parts?.map((part) => part.text ?? '').join('\n') ?? '';
}

function lastUserText(request: LlmRequest): string {
  const contents = request.contents ?? [];
  for (let index = contents.length - 1; index >= 0; index -= 1) {
    const content = contents[index];
    if (content?.role !== 'user') continue;
    const text = content.parts?.map((part) => part.text ?? '').join('\n') ?? '';
    if (text.trim()) return text;
  }
  return '';
}
