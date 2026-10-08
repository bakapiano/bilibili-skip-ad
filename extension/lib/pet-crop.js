export const CROP_SIZE = 256;
export const CROP_OUTPUT_SIZE = 512;
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function cropLayout(width, height, zoom = 1, x = 0, y = 0) {
  if (![width, height, zoom, x, y].every(Number.isFinite) || width <= 0 || height <= 0) {
    throw new Error("图片裁剪参数异常。");
  }
  const scale = (CROP_SIZE / Math.max(width, height)) * Math.max(1, Math.min(4, zoom));
  const w = width * scale;
  const h = height * scale;
  const clamp = (position, length) => {
    const limit = Math.max(0, (length - CROP_SIZE) / 2);
    return Math.max(-limit, Math.min(limit, position)) || 0;
  };
  const offsetX = clamp(x, w);
  const offsetY = clamp(y, h);
  return {
    x: (CROP_SIZE - w) / 2 + offsetX,
    y: (CROP_SIZE - h) / 2 + offsetY,
    width: w,
    height: h,
    offsetX,
    offsetY,
  };
}

export async function readCropImage(file, view) {
  if (!file || !["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new Error("请选择 PNG、JPEG 或 WebP 图片。");
  }
  if (file.size > MAX_UPLOAD_BYTES || file.size === 0) {
    throw new Error("原图大小请保持在 10 MiB 以内。");
  }
  const url = view.URL.createObjectURL(file);
  const image = new view.Image();
  image.src = url;
  try {
    await image.decode();
    if (
      image.naturalWidth > 8192 ||
      image.naturalHeight > 8192 ||
      image.naturalWidth * image.naturalHeight > 32 * 1024 * 1024
    ) {
      throw new Error("原图宽高请保持在 8192 像素以内，总像素保持在 3200 万以内。");
    }
    return { image, release: () => view.URL.revokeObjectURL(url) };
  } catch (error) {
    view.URL.revokeObjectURL(url);
    throw new Error("图片解码未完成，请检查图片格式与尺寸后重试。", { cause: error });
  }
}
