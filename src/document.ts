/** Unknown MIME data keeps legacy review evidence applicable. */
export function classifyDocument(
  contentType: string | undefined,
): "html" | "non-html" | "unknown" {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  if (!mime) return "unknown";
  return mime === "text/html" || mime === "application/xhtml+xml"
    ? "html"
    : "non-html";
}
