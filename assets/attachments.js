const KB = 1024;
const MB = 1024 * KB;
const MAX_FILES = 10;
const MAX_TOTAL = 40 * MB;
const LIMITS = { image: [5 * MB, "5 MB"], pdf: [32 * MB, "32 MB"], text: [256 * KB, "256 KB"] };

function starts(bytes, signature) {
  return [...signature].every((c, i) => bytes[i] === (typeof c === "number" ? c : c.charCodeAt(0)));
}

// The same test the server makes: images and PDFs by their first bytes, text as UTF-8 with no NUL.
async function kindOf(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (starts(head, [0x89, "P", "N", "G", 0x0d, 0x0a, 0x1a, 0x0a]) || starts(head, [0xff, 0xd8, 0xff]) || starts(head, "GIF87a")
    || starts(head, "GIF89a") || (starts(head, "RIFF") && starts(head.slice(8), "WEBP"))) return "image";
  if (starts(head, "%PDF-")) return "pdf";
  const sample = new Uint8Array(await file.slice(0, LIMITS.text[0] + 1).arrayBuffer());
  if (sample.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: file.size > sample.length });
    return "text";
  } catch {
    return null;
  }
}

export async function admit(file, attached, runsOn) {
  const name = file.name;
  if (attached.length >= MAX_FILES) return { error: `attach at most ${MAX_FILES} files to one message` };
  if (!file.size) return { error: `${name} is empty` };
  const kind = await kindOf(file);
  if (!kind) return { error: `${name} is not an image, a PDF or a text file` };
  if (kind === "pdf" && runsOn === "codex") return { error: `Codex cannot read PDFs, so ${name} cannot be sent in this conversation` };
  const [limit, words] = LIMITS[kind];
  if (file.size > limit) return { error: `${name} is over ${words}` };
  if (attached.reduce((n, a) => n + a.file.size, file.size) > MAX_TOTAL) return { error: "these files come to more than 40 MB together" };
  return { kind };
}

export function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] || "");
    reader.onerror = () => reject(new Error(`could not read ${file.name}, try attaching it again`));
    reader.readAsDataURL(file);
  });
}

export function sizeText(bytes) {
  if (bytes < KB) return `${bytes} B`;
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}
