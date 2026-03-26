import { getHeaders, buildCookie } from "./headers";
import {
  buildAppChatPayload,
  CHAT_API,
  normalizeAppChatStreamLine,
  toAbsoluteGrokAssetUrl,
} from "./app-chat";

const CREATE_POST_API = "https://grok.com/rest/media/post/create";
const VIDEO_MODEL_NAME = "grok-3";

type MediaPostType = "MEDIA_POST_TYPE_VIDEO" | "MEDIA_POST_TYPE_IMAGE";

export interface VideoProgress {
  type: "progress";
  video_id: string;
  progress: number;
  prompt: string;
  image_url: string;
  width: number;
  height: number;
  resolution: string;
  moderated: boolean;
}

export interface VideoResult {
  type: "complete";
  video_id: string;
  video_url: string;
  original_url: string;
  thumbnail_url: string;
  token_id: string;
  message: string;
}

export interface VideoError {
  type: "error";
  message: string;
}

export interface VideoDone {
  type: "done";
}

export type VideoUpdate = VideoProgress | VideoResult | VideoError | VideoDone;

function buildModeFlag(mode: string): string {
  const modeMap: Record<string, string> = {
    fun: "--mode=extremely-crazy",
    normal: "--mode=normal",
    spicy: "--mode=extremely-spicy-or-crazy",
    auto: "--mode=custom",
    custom: "--mode=custom",
  };
  return modeMap[mode] || "--mode=custom";
}

function buildVideoMessage(prompt: string, mode: string): string {
  const normalizedPrompt = prompt.trim() || "Generate a video from the reference image";
  return `${normalizedPrompt} ${buildModeFlag(mode)}`.trim();
}

function extractVideoIdFromUrl(videoUrl: string): string {
  const match = videoUrl.match(/\/generated\/([0-9a-fA-F-]{32,36})\//)
    || videoUrl.match(/\/([0-9a-fA-F-]{32,36})\/generated_video/i);
  return match?.[1] || "";
}

async function createMediaPost(
  prompt: string,
  cookie: string,
  mediaType: MediaPostType = "MEDIA_POST_TYPE_VIDEO",
  mediaUrl: string = ""
): Promise<string> {
  const headers = getHeaders(cookie, "https://grok.com");
  const payload: Record<string, unknown> = {
    mediaType,
  };

  if (mediaUrl) {
    payload.mediaUrl = mediaUrl;
  }
  if (prompt) {
    payload.prompt = prompt;
  }

  const response = await fetch(CREATE_POST_API, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = await response.json() as { post?: { id?: string } };
  const postId = data.post?.id || "";
  if (!postId) {
    throw new Error("No post ID in media post response");
  }
  return postId;
}

function buildVideoPayload(
  seedPostId: string,
  imageUrl: string,
  prompt: string,
  aspectRatio: string,
  videoLength: number,
  resolution: string,
  mode: string
): Record<string, unknown> {
  const videoGenModelConfig: Record<string, unknown> = {
    aspectRatio,
    parentPostId: seedPostId,
    resolutionName: resolution,
    videoLength,
    isVideoEdit: false,
  };

  if (imageUrl) {
    videoGenModelConfig.imageReferences = [imageUrl];
    videoGenModelConfig.isReferenceToVideo = true;
  }

  return buildAppChatPayload({
    message: buildVideoMessage(prompt, mode),
    modelName: VIDEO_MODEL_NAME,
    toolOverrides: { videoGen: true },
    modelConfigOverride: {
      modelMap: {
        videoGenModelConfig,
      },
    },
  });
}

function appendUniqueErrors(bucket: string[], value: unknown): void {
  const items = Array.isArray(value) ? value : [value];
  for (const item of items) {
    const text = String(item || "").trim();
    if (text && !bucket.includes(text)) {
      bucket.push(text);
    }
  }
}

export async function* generateVideo(
  sso: string,
  ssoRw: string,
  user_id: string,
  cf_clearance: string,
  token_id: string,
  imageUrl: string,
  prompt: string,
  parentPostId: string,
  aspectRatio: string,
  videoLength: number,
  resolution: string,
  mode: string
): AsyncGenerator<VideoUpdate> {
  void parentPostId;
  const cookie = buildCookie(sso, ssoRw, user_id, cf_clearance);
  const effectivePrompt = prompt.trim() || "Generate a video from the reference image";

  let seedPostId = "";
  try {
    seedPostId = await createMediaPost(effectivePrompt, cookie, "MEDIA_POST_TYPE_VIDEO");
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
    return;
  }

  const headers = getHeaders(cookie, "https://grok.com/");
  const payload = buildVideoPayload(
    seedPostId,
    imageUrl,
    effectivePrompt,
    aspectRatio,
    videoLength,
    resolution,
    mode
  );

  try {
    const response = await fetch(CHAT_API, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      yield { type: "error", message: `HTTP ${response.status}: ${text.slice(0, 200)}` };
      return;
    }

    if (!response.body) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let videoId = "";
    let videoUrl = "";
    let thumbnailUrl = "";
    let lastProgress = -1;
    const streamErrors: string[] = [];

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

          appendUniqueErrors(streamErrors, resp.streamErrors);

          const modelResponse = resp.modelResponse;
          if (modelResponse && typeof modelResponse === "object") {
            const attachments = (modelResponse as { fileAttachments?: unknown }).fileAttachments;
            if (Array.isArray(attachments) && typeof attachments[0] === "string" && !videoId) {
              videoId = attachments[0];
            }
            appendUniqueErrors(streamErrors, (modelResponse as { streamErrors?: unknown }).streamErrors);
          }

          const videoResp = resp.streamingVideoGenerationResponse;
          if (!videoResp || typeof videoResp !== "object") continue;

          const record = videoResp as Record<string, unknown>;
          const progress = Number(record.progress ?? 0);
          videoId = String(record.videoPostId || record.videoId || record.postId || videoId || "");

          const nextVideoUrl = record.videoUrl;
          if (typeof nextVideoUrl === "string" && nextVideoUrl.trim()) {
            videoUrl = nextVideoUrl.trim();
          }

          const nextThumbUrl = record.thumbnailImageUrl;
          if (typeof nextThumbUrl === "string" && nextThumbUrl.trim()) {
            thumbnailUrl = nextThumbUrl.trim();
          }

          if (Boolean(record.moderated)) {
            yield { type: "error", message: "Video generation blocked: content moderated" };
            return;
          }

          if (progress !== lastProgress) {
            lastProgress = progress;
            yield {
              type: "progress",
              video_id: videoId,
              progress,
              prompt: String(record.videoPrompt || effectivePrompt),
              image_url: String(record.imageReference || imageUrl || ""),
              width: Number(record.width ?? 0),
              height: Number(record.height ?? 0),
              resolution: String(record.resolutionName || resolution),
              moderated: false,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const originalUrl = toAbsoluteGrokAssetUrl(videoUrl);
    const resolvedVideoId = videoId || extractVideoIdFromUrl(originalUrl);

    if (!originalUrl) {
      const detail = streamErrors.length > 0
        ? streamErrors.join("; ")
        : "Video generation incomplete: no videoUrl received";
      yield { type: "error", message: detail };
      return;
    }

    const proxyUrl = `/api/proxy/video?url=${encodeURIComponent(originalUrl)}&token=${encodeURIComponent(token_id)}`;
    const originalThumbUrl = toAbsoluteGrokAssetUrl(thumbnailUrl);
    const thumbnailProxyUrl = originalThumbUrl
      ? `/api/proxy/assets/${encodeURIComponent(originalThumbUrl)}?token=${encodeURIComponent(token_id)}`
      : "";

    yield {
      type: "complete",
      video_id: resolvedVideoId,
      video_url: proxyUrl,
      original_url: originalUrl,
      thumbnail_url: thumbnailProxyUrl,
      token_id,
      message: `Video generated: ${effectivePrompt}`,
    };

    yield { type: "done" };
  } catch (e) {
    yield { type: "error", message: e instanceof Error ? e.message : String(e) };
  }
}
