import { describe, expect, it } from 'vitest';

import { readSseMessages, SseLimitError } from './sse.js';

const encoder = new TextEncoder();

function chunkedStream(chunks: readonly string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

describe('SSE parser', () => {
  it('handles split CRLF frames, comments, multiline data, IDs, and retry fields', async () => {
    const retries: number[] = [];
    const ids: string[] = [];
    let activityCount = 0;
    const body = chunkedStream([
      ': keepalive\r',
      '\nretry: 125\r\nid: event-',
      '7\r\nevent: odds\r\ndata: {"FixtureId":42,\r\n',
      'data: "MessageId":"abc"}\r\n\r\n',
    ]);

    const messages = [];
    for await (const message of readSseMessages(body, {
      onActivity: () => {
        activityCount += 1;
      },
      onLastEventId: (id) => ids.push(id),
      onRetry: (retry) => retries.push(retry),
    })) {
      messages.push(message);
    }

    expect(messages).toEqual([
      {
        data: '{"FixtureId":42,\n"MessageId":"abc"}',
        event: 'odds',
        id: 'event-7',
      },
    ]);
    expect(JSON.parse(messages[0]!.data)).toEqual({ FixtureId: 42, MessageId: 'abc' });
    expect(ids).toEqual(['event-7']);
    expect(retries).toEqual([125]);
    expect(activityCount).toBeGreaterThan(5);
  });

  it('persists an ID-only block and ignores IDs containing a null character', async () => {
    const ids: string[] = [];
    const body = chunkedStream(['id: resume-1\n\nid: bad\u0000id\ndata: payload\n\n']);

    const messages = [];
    for await (const message of readSseMessages(body, {
      onLastEventId: (id) => ids.push(id),
    })) {
      messages.push(message);
    }

    expect(ids).toEqual(['resume-1']);
    expect(messages).toEqual([{ data: 'payload', event: 'message', id: 'resume-1' }]);
  });

  it('bounds an unfinished or oversized event', async () => {
    const body = chunkedStream(['data: 123456789\n']);
    const consume = async () => {
      for await (const _message of readSseMessages(body, {
        maximumEventCharacters: 8,
      })) {
        void _message;
      }
    };

    await expect(consume()).rejects.toBeInstanceOf(SseLimitError);
  });
});
