const LS = new RegExp(String.fromCharCode(0x2028), "g");
const PS = new RegExp(String.fromCharCode(0x2029), "g");

/**
 * Serialise JSON-LD for a `<script type="application/ld+json">` tag. Escapes `<`, `>` and `&` and
 * the line/paragraph separators so the document cannot break out of the script element.
 */
export function serializeJsonLd(doc: unknown): string {
  return JSON.stringify(doc)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LS, "\\u2028")
    .replace(PS, "\\u2029");
}
