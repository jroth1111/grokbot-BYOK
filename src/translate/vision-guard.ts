import type { OpenAIContentPart } from "../types.js";

const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";

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
