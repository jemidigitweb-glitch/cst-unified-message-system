import { z } from "zod";

/**
 * Attachments a customer sent with a message.
 *
 * PURE. No network, no files. Given the URLs the source recorded, this decides
 * what may be rendered and how — nothing here fetches anything.
 *
 * WHY THIS IS NOT JUST "PUT THE URL IN AN img TAG". Three reasons, in order of
 * how badly each fails:
 *
 *   1. NOT EVERY ATTACHMENT IS AN IMAGE. The live data holds `Invoice_4054211.pdf`
 *      alongside `image001.jpg`. An `<img>` pointed at a PDF renders a broken
 *      icon and tells the reviewer nothing about a document they may need.
 *   2. A URL IS A REQUEST THE BROWSER WILL MAKE. Anything rendered as an image
 *      is fetched automatically, with no click, the moment a thread is opened.
 *      That is fine for our own storage and not fine for an arbitrary host, so
 *      the scheme is checked and http is refused outright.
 *   3. THE SOURCE IS NOT A TRUST BOUNDARY. These strings arrive from a shared
 *      production database this project does not own and cannot vouch for.
 *      `javascript:` and `data:` URLs are rejected here rather than relied on
 *      being absent.
 */

export const ATTACHMENT_KINDS = ["image", "document"] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const attachmentSchema = z.object({
  url: z.string().min(1),
  kind: z.enum(ATTACHMENT_KINDS),
  /** Filename from the URL, for a document link. Never a customer name. */
  label: z.string().min(1),
});

export type Attachment = z.infer<typeof attachmentSchema>;

/** Extensions rendered inline. Deliberately a short, known list. */
const IMAGE_EXTENSIONS = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"];

/**
 * The filename a person would recognise, taken from the path.
 *
 * The source prefixes uploads with a timestamp and a hash —
 * `1786616676_6a7d9b640eb7e_image001.jpg` — which is machine bookkeeping, so
 * the prefix is stripped for display. The URL itself is never altered.
 */
function labelFor(url: string): string {
  const path = url.split("?")[0] ?? url;
  const last = path.slice(path.lastIndexOf("/") + 1);
  const decoded = (() => {
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  })();
  const trimmed = decoded.replace(/^\d{8,}_[0-9a-f]{8,}_/i, "");
  return trimmed === "" ? "Attachment" : trimmed;
}

function extensionOf(url: string): string {
  const path = url.split("?")[0] ?? url;
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot === -1 ? "" : last.slice(dot + 1).toLowerCase();
}

/**
 * Turns whatever the source stored into attachments safe to render.
 *
 * Accepts the raw JSONB value rather than a typed array on purpose: the column
 * is `jsonb`, the constraint only guarantees it is an array, and the contents
 * come from a database this project does not control. Anything that is not a
 * usable https URL is dropped silently — a broken thumbnail in a customer
 * thread is worse than an attachment that is simply not shown, and the record
 * itself is still in the database either way.
 */
export function attachmentsFrom(raw: unknown): Attachment[] {
  if (!Array.isArray(raw)) return [];

  const seen = new Set<string>();
  const out: Attachment[] = [];

  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const url = entry.trim();
    if (url === "" || seen.has(url)) continue;

    // https only. Not a style preference: an http image on an https page is
    // blocked as mixed content anyway, and `javascript:`/`data:` must never
    // reach an href or a src.
    if (!/^https:\/\//i.test(url)) continue;

    seen.add(url);
    out.push({
      url,
      kind: IMAGE_EXTENSIONS.includes(extensionOf(url)) ? "image" : "document",
      label: labelFor(url),
    });
  }

  return out;
}
