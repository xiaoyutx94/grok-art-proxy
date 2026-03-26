export const CHAT_API = "https://grok.com/rest/app-chat/conversations/new";

export interface AppChatPayload {
  deviceEnvInfo: Record<string, number | boolean>;
  temporary: boolean;
  modelName: string;
  modelMode?: string;
  message: string;
  fileAttachments: string[];
  imageAttachments: string[];
  disableSearch: boolean;
  enableImageGeneration: boolean;
  returnImageBytes: boolean;
  returnRawGrokInXaiRequest: boolean;
  enableImageStreaming: boolean;
  imageGenerationCount: number;
  forceConcise: boolean;
  toolOverrides: Record<string, unknown>;
  enableSideBySide: boolean;
  sendFinalMetadata: boolean;
  isReasoning: boolean;
  disableTextFollowUps: boolean;
  disableMemory: boolean;
  forceSideBySide: boolean;
  isAsyncChat: boolean;
  disableSelfHarmShortCircuit: boolean;
  responseMetadata: Record<string, unknown>;
  [key: string]: unknown;
}

interface BuildAppChatPayloadOptions {
  message: string;
  modelName: string;
  modelMode?: string;
  fileAttachments?: string[];
  imageAttachments?: string[];
  enableImageGeneration?: boolean;
  imageGenerationCount?: number;
  toolOverrides?: Record<string, unknown>;
  modelConfigOverride?: Record<string, unknown>;
  requestOverrides?: Record<string, unknown>;
}

function buildDeviceEnvInfo(): Record<string, number | boolean> {
  return {
    darkModeEnabled: false,
    devicePixelRatio: 2,
    screenHeight: 1329,
    screenWidth: 2056,
    viewportHeight: 1083,
    viewportWidth: 2056,
  };
}

export function buildAppChatPayload({
  message,
  modelName,
  modelMode,
  fileAttachments = [],
  imageAttachments = [],
  enableImageGeneration = false,
  imageGenerationCount = 0,
  toolOverrides = {},
  modelConfigOverride,
  requestOverrides = {},
}: BuildAppChatPayloadOptions): AppChatPayload {
  const responseMetadata: Record<string, unknown> = {
    requestModelDetails: {
      modelId: modelName,
    },
  };

  if (modelConfigOverride && Object.keys(modelConfigOverride).length > 0) {
    responseMetadata.modelConfigOverride = modelConfigOverride;
  }

  const payload: AppChatPayload = {
    deviceEnvInfo: buildDeviceEnvInfo(),
    temporary: true,
    modelName,
    message,
    fileAttachments,
    imageAttachments,
    disableSearch: false,
    enableImageGeneration,
    returnImageBytes: false,
    returnRawGrokInXaiRequest: false,
    enableImageStreaming: enableImageGeneration,
    imageGenerationCount: enableImageGeneration ? Math.max(1, imageGenerationCount || 1) : 0,
    forceConcise: false,
    toolOverrides,
    enableSideBySide: true,
    sendFinalMetadata: true,
    isReasoning: false,
    disableTextFollowUps: false,
    disableMemory: false,
    forceSideBySide: false,
    isAsyncChat: false,
    disableSelfHarmShortCircuit: false,
    responseMetadata,
  };

  if (modelMode) {
    payload.modelMode = modelMode;
  }

  return {
    ...payload,
    ...requestOverrides,
  };
}

export function normalizeAppChatStreamLine(line: string): string | null {
  let text = String(line || "").trim();
  if (!text) return null;
  if (text.startsWith("data:")) {
    text = text.slice(5).trim();
  }
  if (!text || text === "[DONE]") {
    return null;
  }
  return text;
}

export function collectGeneratedImageUrls(value: unknown): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();

  const add = (url: string) => {
    const trimmed = String(url || "").trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    urls.push(trimmed);
  };

  const walk = (input: unknown) => {
    if (Array.isArray(input)) {
      for (const item of input) walk(item);
      return;
    }

    if (!input || typeof input !== "object") {
      return;
    }

    const record = input as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (key === "generatedImageUrls" || key === "imageUrls" || key === "imageURLs") {
        if (Array.isArray(item)) {
          for (const url of item) {
            if (typeof url === "string") add(url);
          }
        } else if (typeof item === "string") {
          add(item);
        }
        continue;
      }
      walk(item);
    }
  };

  walk(value);
  return urls;
}

export function toAbsoluteGrokAssetUrl(value: string): string {
  const url = String(value || "").trim();
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  return `https://assets.grok.com/${url.replace(/^\//, "")}`;
}
