/**
 * `POST /accounts/{account}/uploads` 是 multipart/form-data，字段名 `file`，文件名随 part 走。
 * 这里手写最小的 multipart 组包：只有一处用得上，不引依赖，也就没有版本漂移。
 */
export interface MultipartFile {
  field: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface MultipartBody {
  body: Buffer;
  contentType: string;
}

export function buildMultipart(file: MultipartFile): MultipartBody {
  const boundary = `----awx${randomBoundary()}`;
  // 文件名里的引号与换行会破坏 header，先剔除；中文原样放进 filename="…"（多半服务端按 UTF-8 解），
  // 同时给 RFC 5987 的 filename* 兜底。
  const safeName = file.fileName.replace(/["\r\n]/g, '_');
  const encodedName = encodeURIComponent(safeName);
  const head = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="${file.field}"; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      `Content-Type: ${file.mimeType || 'application/octet-stream'}`,
      '',
      '',
    ].join('\r\n'),
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    body: Buffer.concat([head, Buffer.from(file.bytes), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function randomBoundary(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** 常见后缀 → MIME；认不出时按 daemon 的通用二进制处理。 */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.amr': 'audio/amr',
  '.silk': 'audio/silk',
  '.wav': 'audio/wav',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function mimeOfFileName(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot >= 0 ? fileName.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}
