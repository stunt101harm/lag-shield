export type SseMessage = Readonly<{
  data: string;
  event: string;
  id: string;
}>;

export class SseLimitError extends Error {
  constructor(readonly maximumCharacters: number) {
    super(`SSE event exceeded the ${maximumCharacters}-character safety limit.`);
    this.name = 'SseLimitError';
  }
}

export type ReadSseOptions = Readonly<{
  initialLastEventId?: string;
  maximumEventCharacters?: number;
  onActivity?: () => void;
  onLastEventId?: (id: string) => void;
  onRetry?: (milliseconds: number) => void;
}>;

type EventFields = {
  data: string[];
  event: string;
};

function createEventFields(): EventFields {
  return { data: [], event: '' };
}

function findLineEnd(
  buffer: string,
  endOfStream: boolean,
): Readonly<{
  line: string;
  remainder: string;
}> | null {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character !== '\r' && character !== '\n') continue;
    if (character === '\r' && index === buffer.length - 1 && !endOfStream) return null;
    const terminatorLength = character === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
    return {
      line: buffer.slice(0, index),
      remainder: buffer.slice(index + terminatorLength),
    };
  }
  if (!endOfStream || buffer.length === 0) return null;
  return { line: buffer, remainder: '' };
}

function parseField(line: string): Readonly<{ field: string; value: string }> {
  const separator = line.indexOf(':');
  if (separator === -1) return { field: line, value: '' };
  const rawValue = line.slice(separator + 1);
  return {
    field: line.slice(0, separator),
    value: rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue,
  };
}

export async function* readSseMessages(
  body: ReadableStream<Uint8Array>,
  options: ReadSseOptions = {},
): AsyncGenerator<SseMessage> {
  const maximumEventCharacters = options.maximumEventCharacters ?? 1_048_576;
  if (!Number.isSafeInteger(maximumEventCharacters) || maximumEventCharacters < 1) {
    throw new Error('maximumEventCharacters must be a positive safe integer.');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventFields = createEventFields();
  let eventCharacterCount = 0;
  let lastEventId = options.initialLastEventId ?? '';

  const handleLine = (line: string): SseMessage | null => {
    options.onActivity?.();
    if (line === '') {
      if (eventFields.data.length === 0) {
        eventFields = createEventFields();
        eventCharacterCount = 0;
        return null;
      }
      const message = {
        data: eventFields.data.join('\n'),
        event: eventFields.event || 'message',
        id: lastEventId,
      } as const;
      eventFields = createEventFields();
      eventCharacterCount = 0;
      return message;
    }
    eventCharacterCount += line.length + 1;
    if (eventCharacterCount > maximumEventCharacters) {
      throw new SseLimitError(maximumEventCharacters);
    }
    if (line.startsWith(':')) return null;

    const { field, value } = parseField(line);
    if (field === 'data') {
      eventFields.data.push(value);
    } else if (field === 'event') {
      eventFields.event = value;
    } else if (field === 'id' && !value.includes('\u0000')) {
      lastEventId = value;
      options.onLastEventId?.(value);
    } else if (field === 'retry' && /^\d+$/.test(value)) {
      const retry = Number(value);
      if (Number.isSafeInteger(retry)) options.onRetry?.(retry);
    }
    return null;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      options.onActivity?.();
      buffer += decoder.decode(value, { stream: true });
      let line = findLineEnd(buffer, false);
      while (line) {
        buffer = line.remainder;
        const message = handleLine(line.line);
        if (message) yield message;
        line = findLineEnd(buffer, false);
      }
      if (buffer.length + eventCharacterCount > maximumEventCharacters) {
        throw new SseLimitError(maximumEventCharacters);
      }
    }

    buffer += decoder.decode();
    let line = findLineEnd(buffer, true);
    while (line) {
      buffer = line.remainder;
      const message = handleLine(line.line);
      if (message) yield message;
      line = findLineEnd(buffer, true);
    }
    const finalMessage = handleLine('');
    if (finalMessage) yield finalMessage;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
