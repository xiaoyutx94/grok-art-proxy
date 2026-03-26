import { getHeaders, getWebSocketHeaders, buildCookie } from "./headers";
import {
  buildAppChatPayload,
  CHAT_API,
  collectGeneratedImageUrls,
  normalizeAppChatStreamLine,
} from "./app-chat";

const WS_URL = "wss://grok.com/ws/imagine/listen";
const IMAGE_MODEL_NAME = "grok-3";
const IMAGE_MODEL_MODE = "MODEL_MODE_FAST";
const APP_CHAT_IMAGE_BATCH_SIZE = 2;

export interface ImageResult {
  job_id: string;
  request_id: string;
  url: string;
  blob: string;
  prompt: string;
  full_prompt: string;
  width: number;
  height: number;
  model_name: string;
  grid_index: number;
  order: number;
  r_rated: boolean;
  moderated: boolean;
}

export interface ProgressUpdate {
  type: "progress";
  job_id: string;
  status: string;
  percentage: number;
  completed_count: number;
  target_count: number;
}

export interface ImageUpdate {
  type: "image";
  job_id: string;
  request_id: string;
  url: string;
  image_src: string;
  has_blob: boolean;
  prompt: string;
  full_prompt: string;
  width: number;
  height: number;
  model_name: string;
  grid_index: number;
  order: number;
  r_rated: boolean;
  moderated: boolean;
}

export interface ErrorUpdate {
  type: "error";
  message: string;
}

export interface InfoUpdate {
  type: "info";
  message: string;
}

export interface DoneUpdate {
  type: "done";
}

export type StreamUpdate = ProgressUpdate | ImageUpdate | ErrorUpdate | InfoUpdate | DoneUpdate;

interface WsMessage {
  type?: string;
  job_id?: string;
  request_id?: string;
  url?: string;
  blob?: string;
  prompt?: string;
  full_prompt?: string;
  width?: number;
  height?: number;
  model_name?: string;
  grid_index?: number;
  order?: number;
  r_rated?: boolean;
  moderated?: boolean;
  current_status?: string;
  percentage_complete?: number;
  message?: string;
  err_code?: string;
  err_msg?: string;
}

function buildWebSocketRequest(
  prompt: string,
  aspectRatio: string,
  enableNsfw: boolean
): Record<string, unknown> {
  return {
    type: "conversation.item.create",
    timestamp: Date.now(),
    item: {
      type: "message",
      content: [{
        requestId: crypto.randomUUID(),
        text: prompt,
        type: "input_text",
        properties: {
          section_count: 0,
          is_kids_mode: false,
          enable_nsfw: enableNsfw,
          skip_upsampler: false,
          is_initial: false,
          aspect_ratio: aspectRatio,
        },
      }],
    },
  };
}

function extractImageIdFromUrl(url: string): string {
  const match = url.match(/\/images\/([a-f0-9-]+)\.(?:png|jpg|jpeg)/i)
    || url.match(/\/([a-f0-9-]{32,36})\.(?:png|jpg|jpeg|webp)/i);
  return match?.[1] || crypto.randomUUID();
}

function extractErrorMessage(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "Unknown error";
  const record = payload as Record<string, unknown>;
  const message = record.message;
  if (typeof message === "string" && message.trim()) return message;
  const errMsg = record.err_msg;
  if (typeof errMsg === "string" && errMsg.trim()) return errMsg;
  const errCode = record.err_code;
  if (typeof errCode === "string" && errCode.trim()) return errCode;
  return "Unknown error";
}

function isAuthOrRateLimit(message: string): boolean {
  const lower = message.toLowerCase();
  return lower.includes("429") || lower.includes("rate limit") || lower.includes("401") || lower.includes("unauthorized");
}

async function connectAndReceiveViaWebSocket(
  sso: string,
  ssoRw: string,
  prompt: string,
  aspectRatio: string,
  enableNsfw: boolean,
  timeoutMs: number = 30000
): Promise<ImageResult[]> {
  const cookie = buildCookie(sso, ssoRw);
  const headers = getWebSocketHeaders(cookie);

  const response = await fetch(WS_URL.replace("wss://", "https://"), {
    headers: {
      ...headers,
      Upgrade: "websocket",
    },
  });

  const ws = response.webSocket;
  if (!ws) {
    throw new Error(`WebSocket upgrade failed: ${response.status}`);
  }

  ws.accept();
  ws.send(JSON.stringify(buildWebSocketRequest(prompt, aspectRatio, enableNsfw)));

  return new Promise((resolve, reject) => {
    const results: ImageResult[] = [];
    const receivedImages = new Map<string, ImageResult>();
    const completedJobs = new Set<string>();
    const failedJobs = new Set<string>();

    const timeout = setTimeout(() => {
      ws.close();
      resolve(results);
    }, timeoutMs);

    ws.addEventListener("message", (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as WsMessage;
        const msgType = data.type || "";

        if (msgType === "json") {
          const jobId = data.job_id || "";
          const status = data.current_status || "";
          const percentage = data.percentage_complete || 0;

          if (status === "completed" && percentage >= 100 && jobId) {
            completedJobs.add(jobId);
          } else if (status === "error" && jobId) {
            failedJobs.add(jobId);
          }
          return;
        }

        if (msgType === "image") {
          const jobId = data.job_id || extractImageIdFromUrl(data.url || "");
          const blob = data.blob || "";
          const url = data.url || "";
          const blobLen = blob.length;
          const existingBlobLen = receivedImages.get(jobId)?.blob.length || 0;
          const isFinalImage = blobLen >= 100_000;

          if (!url || !jobId) return;

          if (!receivedImages.has(jobId) || blobLen > existingBlobLen) {
            const result: ImageResult = {
              job_id: jobId,
              request_id: data.request_id || crypto.randomUUID(),
              url,
              blob,
              prompt: data.prompt || prompt,
              full_prompt: data.full_prompt || prompt,
              width: data.width || 0,
              height: data.height || 0,
              model_name: data.model_name || IMAGE_MODEL_NAME,
              grid_index: data.grid_index || 0,
              order: data.order || 0,
              r_rated: Boolean(data.r_rated),
              moderated: Boolean(data.moderated),
            };
            receivedImages.set(jobId, result);

            if (isFinalImage && !result.moderated) {
              results.push(result);
            }
          }
          return;
        }

        if (msgType === "error") {
          clearTimeout(timeout);
          ws.close();
          reject(new Error(extractErrorMessage(data)));
          return;
        }

      } catch {
        // Ignore parse errors
      }

      const totalDone = completedJobs.size + failedJobs.size;
      if (totalDone >= 6) {
        clearTimeout(timeout);
        setTimeout(() => {
          ws.close();
          resolve(results);
        }, 300);
      }
    });

    ws.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error"));
    });

    ws.addEventListener("close", (event: CloseEvent) => {
      clearTimeout(timeout);
      if (event.code === 1008 || event.code === 429) {
        reject(new Error("Rate limited (429)"));
      } else {
        resolve(results);
      }
    });
  });
}

async function* generateImagesViaWebSocket(
  sso: string,
  ssoRw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean
): AsyncGenerator<StreamUpdate> {
  const collectedJobs = new Set<string>();
  const maxPages = Math.ceil(count / 6) + 2;

  yield {
    type: "progress",
    job_id: "",
    status: "starting",
    percentage: 0,
    completed_count: 0,
    target_count: count,
  };

  for (let page = 0; page < maxPages; page++) {
    if (collectedJobs.size >= count) break;

    try {
      const images = await connectAndReceiveViaWebSocket(
        sso,
        ssoRw,
        prompt,
        aspectRatio,
        enableNsfw,
        30000
      );

      for (const img of images) {
        if (img.moderated || !img.url) continue;
        if (collectedJobs.has(img.job_id)) continue;

        collectedJobs.add(img.job_id);

        let imageSrc = img.url;
        if (img.blob) {
          if (img.blob.startsWith("data:")) {
            imageSrc = img.blob;
          } else if (img.blob.startsWith("/9j/")) {
            imageSrc = `data:image/jpeg;base64,${img.blob}`;
          } else {
            imageSrc = `data:image/png;base64,${img.blob}`;
          }
        }

        yield {
          type: "image",
          job_id: img.job_id,
          request_id: img.request_id,
          url: img.url,
          image_src: imageSrc,
          has_blob: Boolean(img.blob),
          prompt: img.prompt,
          full_prompt: img.full_prompt,
          width: img.width,
          height: img.height,
          model_name: img.model_name,
          grid_index: img.grid_index,
          order: img.order,
          r_rated: img.r_rated,
          moderated: img.moderated,
        };

        yield {
          type: "progress",
          job_id: img.job_id,
          status: "collecting",
          percentage: (collectedJobs.size / count) * 100,
          completed_count: collectedJobs.size,
          target_count: count,
        };

        if (collectedJobs.size >= count) break;
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      yield { type: "error", message };
      return;
    }

    if (page < maxPages - 1 && collectedJobs.size < count) {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  yield { type: "done" };
}

async function* generateImagesViaAppChat(
  sso: string,
  ssoRw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean
): AsyncGenerator<StreamUpdate> {
  const cookie = buildCookie(sso, ssoRw);
  const headers = getHeaders(cookie, "https://grok.com/");
  const seenImages = new Set<string>();
  let completedCount = 0;

  yield {
    type: "progress",
    job_id: "",
    status: "starting",
    percentage: 0,
    completed_count: 0,
    target_count: count,
  };

  while (completedCount < count) {
    const batchCount = Math.min(APP_CHAT_IMAGE_BATCH_SIZE, count - completedCount);
    const payload = buildAppChatPayload({
      message: prompt,
      modelName: IMAGE_MODEL_NAME,
      modelMode: IMAGE_MODEL_MODE,
      enableImageGeneration: true,
      imageGenerationCount: batchCount,
      toolOverrides: { imageGen: true },
      requestOverrides: {
        imageGenerationCount: batchCount,
        enableNsfw: enableNsfw,
      },
    });

    const response = await fetch(CHAT_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${errorText.slice(0, 500)}`);
    }

    if (!response.body) {
      throw new Error("No response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let batchImages = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const rawLine of lines) {
          const line = normalizeAppChatStreamLine(rawLine);
          if (!line) continue;

          let data: unknown;
          try {
            data = JSON.parse(line);
          } catch {
            continue;
          }

          const resp = (data as { result?: { response?: Record<string, unknown> } })?.result?.response;
          if (!resp) continue;

          const streaming = resp.streamingImageGenerationResponse;
          if (streaming && typeof streaming === "object") {
            const record = streaming as Record<string, unknown>;
            const progress = Number(record.progress ?? 0);
            const imageIndex = Number(record.imageIndex ?? 0);
            yield {
              type: "progress",
              job_id: `app-chat-image-${completedCount}-${imageIndex}`,
              status: "generating",
              percentage: progress,
              completed_count: completedCount,
              target_count: count,
            };
          }

          const modelResponse = resp.modelResponse;
          if (!modelResponse || typeof modelResponse !== "object") continue;

          const urls = collectGeneratedImageUrls(modelResponse);
          for (const url of urls) {
            if (!url) continue;
            const imageId = extractImageIdFromUrl(url);
            if (seenImages.has(imageId) || completedCount >= count) continue;

            seenImages.add(imageId);
            batchImages += 1;
            completedCount += 1;

            yield {
              type: "image",
              job_id: imageId,
              request_id: String(resp.responseId || crypto.randomUUID()),
              url,
              image_src: url,
              has_blob: false,
              prompt,
              full_prompt: prompt,
              width: 0,
              height: 0,
              model_name: IMAGE_MODEL_NAME,
              grid_index: batchImages - 1,
              order: completedCount - 1,
              r_rated: false,
              moderated: false,
            };

            yield {
              type: "progress",
              job_id: imageId,
              status: "collecting",
              percentage: (completedCount / count) * 100,
              completed_count: completedCount,
              target_count: count,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (batchImages === 0) {
      throw new Error("No images generated");
    }
  }

  yield { type: "done" };
}

export async function* generateImages(
  sso: string,
  ssoRw: string,
  prompt: string,
  count: number,
  aspectRatio: string,
  enableNsfw: boolean
): AsyncGenerator<StreamUpdate> {
  let emittedImages = false;

  try {
    for await (const update of generateImagesViaAppChat(
      sso,
      ssoRw,
      prompt,
      count,
      aspectRatio,
      enableNsfw
    )) {
      if (update.type === "image") {
        emittedImages = true;
      }
      yield update;
    }
    return;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (emittedImages || isAuthOrRateLimit(message)) {
      yield { type: "error", message };
      return;
    }

    yield {
      type: "info",
      message: `App-chat image generation failed, fallback to websocket: ${message}`,
    };
  }

  yield* generateImagesViaWebSocket(sso, ssoRw, prompt, count, aspectRatio, enableNsfw);
}
