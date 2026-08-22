import type { OpenAIContentPart } from "../types.js";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";

export function partitionVisionContent(
  content: OpenAIContentPart[],
  supportsImages: boolean,
): {
  textParts: OpenAIContentPart[];
  imageParts: OpenAIContentPart[];
  omittedImages: boolean;
} {
  const textParts = content.filter((part) => part.type === "text");
  const imageParts = content.filter((part) => part.type === "image_url");
  return {
    textParts,
    imageParts: supportsImages ? imageParts : [],
    omittedImages: !supportsImages && imageParts.length > 0,
  };
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
  const parts: string[] = [];
  if (text.length > 0) {
    parts.push(text);
  }
  if (omittedImages) {
    parts.push(NON_VISION_IMAGE_PLACEHOLDER);
  }
  return parts.join("\n");
}

export function stripImagesForNonVisionModel(
  content: string | OpenAIContentPart[] | null,
  supportsImages: boolean,
): string | OpenAIContentPart[] | null {
  if (typeof content === "string" || content === null) {
    return content;
  }
  if (supportsImages) {
    return content;
  }
  const filtered = content.filter((part) => part.type !== "image_url");
  const droppedCount = content.length - filtered.length;
  if (droppedCount > 0) {
    filtered.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
  }
  if (filtered.length === 0) {
    return [{ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER }];
  }
  return filtered;
}
