import type { SSEChunk } from "@/types";

export function createSSEStream(
  produce: (send: (chunk: SSEChunk) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const abortController = new AbortController();
      let closed = false;

      const send = (chunk: SSEChunk) => {
        if (closed) return;
        const payload = `data: ${JSON.stringify(chunk)}\n\n`;
        controller.enqueue(encoder.encode(payload));
      };

      try {
        await produce(send, abortController.signal);
      } catch (error) {
        if (!closed) {
          const message = error instanceof Error ? error.message : "unknown error";
          send({ type: "error", data: { message } });
        }
      } finally {
        if (!closed) {
          closed = true;
          controller.close();
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
