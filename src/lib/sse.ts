import type { SSEChunk } from "@/types";

export function createSSEStream(
  produce: (send: (chunk: SSEChunk) => void, signal: AbortSignal) => Promise<void>,
): Response {
  const encoder = new TextEncoder();

  // closed は start と cancel の両方から参照するため外スコープに持ち上げる。
  // クライアント切断時に Web ストリームが cancel() を呼ぶと closed=true となり、
  // 以降の send() は no-op 化する（produce は巻き戻さず末尾まで走り切らせる）。
  let closed = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const abortController = new AbortController();

      // best-effort 送信：切断後の enqueue 失敗で produce を巻き戻さない
      // （巻き戻すと末尾の status 永続化が取りこぼされ、画面遷移が起きないバグになる）。
      const send = (chunk: SSEChunk) => {
        if (closed) return;
        const payload = `data: ${JSON.stringify(chunk)}\n\n`;
        try {
          controller.enqueue(encoder.encode(payload));
        } catch {
          // クライアント切断後の enqueue（controller が既に閉/エラー）等。
          // 例外を produce へ伝播させず、以降の送信を止めるだけにする。
          closed = true;
        }
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
          try {
            controller.close();
          } catch {
            // 既に切断/クローズ済みなら無視。
          }
        }
      }
    },
    // クライアント切断時に呼ばれる。closed を立てて以降の send を no-op 化するだけ。
    // abortController.abort() は呼ばない（produce を中断せず最後まで完了させ、
    // 末尾の status 更新等を取りこぼさないため）。
    cancel() {
      closed = true;
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
