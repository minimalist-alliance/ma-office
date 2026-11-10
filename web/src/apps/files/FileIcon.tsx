// A small mark for a row. It comes from the extension and decides nothing: a file's name says nothing about what it is
// (the check goes by the bytes), and no preview is ever drawn (files are untrusted bytes, design 4.2.13).
type Kind = 'folder' | 'image' | 'audio' | 'video' | 'archive' | 'document' | 'file';

const EXT: Record<string, Kind> = {};
for (const e of 'jpg jpeg png gif webp bmp tif tiff heic heif avif svg'.split(' ')) EXT[e] = 'image';
for (const e of 'mp3 wav flac ogg m4a aac opus'.split(' ')) EXT[e] = 'audio';
for (const e of 'mp4 mov mkv webm avi m4v'.split(' ')) EXT[e] = 'video';
for (const e of 'zip 7z rar tar gz tgz bz2 xz'.split(' ')) EXT[e] = 'archive';
for (const e of 'pdf txt md doc docx odt rtf xls xlsx ods csv ppt pptx odp json'.split(' ')) EXT[e] = 'document';

export function kindOf(name: string, type: 'file' | 'dir'): Kind {
  if (type === 'dir') return 'folder';
  const dot = name.lastIndexOf('.');
  return (dot > 0 ? EXT[name.slice(dot + 1).toLowerCase()] : undefined) ?? 'file';
}

/** The word a screen reader hears for the kind. */
export const kindWords = (kind: Kind): string => (kind === 'folder' ? 'folder' : kind === 'file' ? 'file' : kind);

export function FileIcon({ name, type, size = 20 }: { name: string; type: 'file' | 'dir'; size?: number }) {
  const kind = kindOf(name, type);
  const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, className: `files-icon ${kind}`, focusable: false } as const;
  if (kind === 'folder') {
    return (
      <svg {...common}>
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="currentColor" />
      </svg>
    );
  }
  const sheet = <path d="M6 3h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />;
  return (
    <svg {...common}>
      {sheet}
      {kind === 'image' && <path d="m7.5 17 3-4 2 2.5 1.5-2 2.5 3.5Z" fill="currentColor" />}
      {kind === 'audio' && <path d="M10 17.5v-6l5-1v6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {kind === 'video' && <path d="m10 11 4 2.5-4 2.5Z" fill="currentColor" />}
      {kind === 'archive' && <path d="M11 6v2m0 2v2m0 2v2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />}
      {kind === 'document' && <path d="M8.5 12h7M8.5 15h7M8.5 9h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />}
    </svg>
  );
}
