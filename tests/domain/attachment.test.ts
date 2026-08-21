import { describe, expect, it } from "vitest";

import { attachmentsFrom } from "@/lib/domain/attachment";

/**
 * What may be rendered from a message's attachments.
 *
 * These values come from a shared production database this project does not own
 * and cannot vouch for, and anything classified as an image is fetched by the
 * browser automatically the moment a thread is opened — no click required. That
 * is the whole reason this filtering exists, and why the rejection cases below
 * matter more than the happy path.
 *
 * URLs here are synthetic. No real attachment location is committed.
 */

describe("classifying attachments", () => {
  it("renders a photograph inline", () => {
    const [attachment] = attachmentsFrom(["https://storage.example.invalid/a/photo.jpg"]);
    expect(attachment).toMatchObject({ kind: "image", label: "photo.jpg" });
  });

  it("treats a document as a link, not a broken image", () => {
    // The live data holds PDF invoices alongside photographs.
    const [attachment] = attachmentsFrom(["https://storage.example.invalid/a/Invoice_4054211.pdf"]);
    expect(attachment).toMatchObject({ kind: "document", label: "Invoice_4054211.pdf" });
  });

  it("recognises the image types the source actually produces", () => {
    for (const ext of ["jpg", "jpeg", "png", "gif", "webp", "bmp", "heic", "heif"]) {
      const [attachment] = attachmentsFrom([`https://storage.example.invalid/a/x.${ext}`]);
      expect(attachment?.kind, ext).toBe("image");
    }
  });

  it("strips the upload prefix from the label but never from the URL", () => {
    const url = "https://storage.example.invalid/a/1786616676_6a7d9b640eb7e_image001.jpg";
    const [attachment] = attachmentsFrom([url]);
    expect(attachment?.label).toBe("image001.jpg");
    expect(attachment?.url).toBe(url);
  });
});

describe("refusing what must not be rendered", () => {
  it("rejects a javascript: URL", () => {
    expect(attachmentsFrom(["javascript:alert(1)"])).toEqual([]);
  });

  it("rejects a data: URL", () => {
    expect(attachmentsFrom(["data:image/png;base64,iVBORw0KGgo="])).toEqual([]);
  });

  it("rejects plain http", () => {
    // Blocked as mixed content anyway, and an unencrypted fetch of a customer's
    // photograph is not something to attempt.
    expect(attachmentsFrom(["http://storage.example.invalid/a/photo.jpg"])).toEqual([]);
  });

  it("survives a column that is not the shape the constraint promises", () => {
    // jsonb accepts an object, a number or a bare string just as happily as an
    // array. A malformed row must not throw in the conversation view.
    expect(attachmentsFrom(null)).toEqual([]);
    expect(attachmentsFrom(undefined)).toEqual([]);
    expect(attachmentsFrom("https://storage.example.invalid/a/photo.jpg")).toEqual([]);
    expect(attachmentsFrom({ url: "https://storage.example.invalid/a/photo.jpg" })).toEqual([]);
    expect(attachmentsFrom(42)).toEqual([]);
  });

  it("drops non-string and blank entries but keeps the usable ones", () => {
    const out = attachmentsFrom([
      "https://storage.example.invalid/a/photo.jpg",
      "",
      "   ",
      null,
      7,
      { nested: true },
      "https://storage.example.invalid/a/second.png",
    ]);
    expect(out.map((a) => a.label)).toEqual(["photo.jpg", "second.png"]);
  });

  it("de-duplicates a repeated URL", () => {
    const url = "https://storage.example.invalid/a/photo.jpg";
    expect(attachmentsFrom([url, url])).toHaveLength(1);
  });

  it("ignores a query string when deciding the type", () => {
    const [attachment] = attachmentsFrom([
      "https://storage.example.invalid/a/photo.jpg?X-Amz-Signature=abc",
    ]);
    expect(attachment?.kind).toBe("image");
    expect(attachment?.label).toBe("photo.jpg");
  });
});
