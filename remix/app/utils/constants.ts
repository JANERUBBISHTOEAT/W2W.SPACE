export const fileIconMap: Record<string, string> = {
  // doc
  "application/pdf": "fas fa-file-pdf",
  "application/msword": "fas fa-file-word",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "fas fa-file-word",
  "application/vnd.ms-excel": "fas fa-file-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    "fas fa-file-excel",
  "application/vnd.ms-powerpoint": "fas fa-file-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "fas fa-file-powerpoint",
  "text/plain": "fas fa-file-alt",
  "text/csv": "fas fa-file-csv",

  // zip
  "application/zip": "fas fa-file-archive",
  "application/x-zip-compressed": "fas fa-file-archive",
  "application/x-rar-compressed": "fas fa-file-archive",
  "application/gzip": "fas fa-file-archive",

  // image
  "image/jpeg": "fas fa-file-image",
  "image/png": "fas fa-file-image",
  "image/gif": "fas fa-file-image",
  "image/bmp": "fas fa-file-image",
  "image/webp": "fas fa-file-image",
  "image/svg+xml": "fas fa-file-code",

  // video
  "video/mp4": "fas fa-file-video",
  "video/mpeg": "fas fa-file-video",
  "video/quicktime": "fas fa-file-video",

  // audio
  "audio/mpeg": "fas fa-file-audio",
  "audio/wav": "fas fa-file-audio",
  "audio/ogg": "fas fa-file-audio",

  // exe
  "application/vnd.microsoft.portable-executable": "fas fa-file-code",
  "application/x-msdownload": "fas fa-file-code",

  // code
  "text/javascript": "fas fa-file-code",
  "application/json": "fas fa-file-code",
  "application/xml": "fas fa-file-code",
  "text/html": "fas fa-file-code",
  "text/css": "fas fa-file-code",
  "application/x-python": "fas fa-file-code",
  "text/x-python": "fas fa-file-code",
  "text/x-java-source": "fas fa-file-code",
  "application/x-java": "fas fa-file-code",
  "application/x-c": "fas fa-file-code",
  "text/x-c": "fas fa-file-code",
  "application/x-c++": "fas fa-file-code",
  "text/x-c++": "fas fa-file-code",
  "application/x-php": "fas fa-file-code",
  "text/x-php": "fas fa-file-code",
  "application/x-ruby": "fas fa-file-code",
  "text/x-ruby": "fas fa-file-code",
  "application/x-shellscript": "fas fa-file-code",
  "text/x-shellscript": "fas fa-file-code",
  "application/x-perl": "fas fa-file-code",
  "text/x-perl": "fas fa-file-code",
  "text/x-go": "fas fa-file-code",
  "application/x-go": "fas fa-file-code",

  // default
  default: "fas fa-file",
};

// Size limits
export const TEXT_MAX_SIZE = 10 * 1024 * 1024; // 10MB for text content
export const FIELD_MAX_SIZE = 1024; // 1KB for other fields (title, token, filename, notes, etc.)
