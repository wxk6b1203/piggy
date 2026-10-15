/**
 * 待发送/排队中的图片（base64，无 `data:` 前缀）。
 *
 * 单独成模块的理由：Composer（粘贴/拖拽/文件选择）与队列影子（`stores/queue.ts`）
 * 都要用它 —— 图片在 pi 的 `queue_update` 里**根本看不见**（pi 的队列镜像只有
 * `string[]`），所以排队中的图片只能由 Piggy 自己捧着，直到消息真的被下发。
 */
export interface PendingImage {
  /** base64 载荷（无 `data:` 前缀） */
  data: string;
  mimeType: string;
  name: string;
}

/** `File` → {@link PendingImage}（图片一律走 base64：`prompt.images` 的线上形状）。 */
export async function fileToPendingImage(file: File): Promise<PendingImage> {
  const buf = await file.arrayBuffer();
  let binary = '';
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    data: btoa(binary),
    mimeType: file.type || 'image/png',
    name: file.name || 'image',
  };
}
