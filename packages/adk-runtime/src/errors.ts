import { OllamaError } from '@ticket/model-provider';

/** Why a classify call produced no usable classifier output. Fixed codes, no text from the model. */
export type ClassifierErrorCode =
  | 'network'
  | 'timeout'
  | 'http'
  | 'redirect'
  | 'invalid_url'
  | 'invalid_response'
  | 'empty_response'
  | 'invalid_json'
  | 'schema_mismatch'
  | 'unknown';

/**
 * A typed classifier failure. The host decides on `code` and `httpStatus`, never on
 * the message, which is fixed text (no URL, token, ticket text, or model output).
 */
export class ClassifierResponseError extends Error {
  constructor(
    readonly code: ClassifierErrorCode,
    readonly httpStatus: number | null = null,
  ) {
    super(MESSAGES[code]);
    this.name = 'ClassifierResponseError';
  }
}

const MESSAGES: Record<ClassifierErrorCode, string> = {
  network: 'The Ollama server is not reachable.',
  timeout: 'The Ollama request timed out.',
  http: 'Ollama answered with an HTTP error.',
  redirect: 'Ollama answered with a redirect, which is not followed.',
  invalid_url: 'The Ollama server URL is not valid.',
  invalid_response: 'Ollama returned an invalid response.',
  empty_response: 'The model returned an empty answer.',
  invalid_json: 'The model did not return JSON.',
  schema_mismatch: 'The model returned JSON that does not match the classifier schema.',
  unknown: 'The model request failed.',
};

/** Maps a model-provider failure to a classifier error code. */
export function classifierErrorFrom(error: unknown): ClassifierResponseError {
  if (error instanceof ClassifierResponseError) return error;
  if (error instanceof OllamaError) {
    switch (error.code) {
      case 'network':
        return new ClassifierResponseError('network');
      case 'timeout':
        return new ClassifierResponseError('timeout');
      case 'http':
        return new ClassifierResponseError('http', error.status);
      case 'redirect':
        return new ClassifierResponseError('redirect');
      case 'invalid-url':
        return new ClassifierResponseError('invalid_url');
      case 'invalid-response':
        return new ClassifierResponseError('invalid_response');
      case 'empty-response':
        return new ClassifierResponseError('empty_response');
    }
  }
  return new ClassifierResponseError('unknown');
}
