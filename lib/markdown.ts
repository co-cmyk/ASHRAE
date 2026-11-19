// Minimal, safe markdown -> HTML for answers and reports. Everything is HTML-escaped first;
// only the tags generated here are emitted. Citations like [E2] or [E1, G3] become buttons.

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string, citeButtons: boolean): string {
  let t = esc(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/(^|[\s(])_([^_]+)_(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
  t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
  t = t.replace(/(https?:\/\/[^\s)<]+[^\s)<.,;:])/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  t = t.replace(/\[((?:[EGM]\d+(?:\s*,\s*)?)+)\]/g, (_m, ids: string) => {
    const parts = ids.split(/\s*,\s*/);
    return citeButtons
      ? parts.map((id) => `<button type="button" class="cite" data-cite="${id}" title="Show evidence ${id}">${id}</button>`).join("")
      : `<span class="cite-ref">[${parts.join(", ")}]</span>`;
  });
  return t;
}

export function mdToHtml(md: string, opts: { citeButtons?: boolean } = {}): string {
  const cite = opts.citeButtons ?? true;
  const lines = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const tr = line.trim();
    if (!tr) {
      i++;
      continue;
    }
    if (tr === "<details><summary>" || /^<details><summary>.*<\/summary>$/.test(tr)) {
      const title = tr.replace(/^<details><summary>/, "").replace(/<\/summary>$/, "");
      out.push(`<details><summary>${inline(title, cite)}</summary>`);
      i++;
      continue;
    }
    if (tr === "</details>") {
      out.push("</details>");
      i++;
      continue;
    }
    const h = tr.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = Math.min(h[1].length + 1, 5);
      out.push(`<h${lvl}>${inline(h[2], cite)}</h${lvl}>`);
      i++;
      continue;
    }
    if (tr.startsWith(">")) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) buf.push(lines[i++].trim().replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "), cite)}</blockquote>`);
      continue;
    }
    if (tr.startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        const cells = lines[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
        i++;
      }
      if (rows.length) {
        const [head, ...body] = rows;
        out.push(
          `<div class="table-wrap"><table><thead><tr>${head.map((c) => `<th>${inline(c, cite)}</th>`).join("")}</tr></thead><tbody>` +
            body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, cite)}</td>`).join("")}</tr>`).join("") +
            "</tbody></table></div>",
        );
      }
      continue;
    }
    if (/^([-*•])\s+/.test(tr) || /^\d+[.)]\s+/.test(tr)) {
      const ordered = /^\d+[.)]\s+/.test(tr);
      const items: string[] = [];
      while (i < lines.length && (/^\s*([-*•])\s+/.test(lines[i]) || /^\s*\d+[.)]\s+/.test(lines[i]))) {
        items.push(lines[i].trim().replace(/^([-*•]|\d+[.)])\s+/, ""));
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((x) => `<li>${inline(x, cite)}</li>`).join("")}</${tag}>`);
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|\||[-*•]\s|\d+[.)]\s|<\/?details)/.test(lines[i].trim())) buf.push(lines[i++].trim());
    if (buf.length) out.push(`<p>${inline(buf.join(" "), cite)}</p>`);
    else i++;
  }
  return out.join("\n");
}

export function reportHtmlDocument(title: string, md: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#0b0b0b;background:#fff;max-width:900px;margin:2rem auto;padding:0 1.25rem;line-height:1.55;font-size:15px}
h1{font-size:1.6rem;margin:0 0 .5rem}h2{font-size:1.3rem;margin-top:2rem}h3{font-size:1.15rem;margin-top:2rem;border-top:1px solid #e1e0d9;padding-top:1rem}
table{border-collapse:collapse;width:100%;font-size:13px;margin:.75rem 0}th,td{border:1px solid #e1e0d9;padding:6px 8px;text-align:left;vertical-align:top}th{background:#f6f5f2}
td{font-variant-numeric:tabular-nums}blockquote{border-left:4px solid #fab219;margin:1rem 0;padding:.5rem 1rem;background:#fff8e6}
.cite-ref{color:#52514e;font-size:.85em;white-space:nowrap}details{margin:.5rem 0 1rem;font-size:13px;color:#52514e}summary{cursor:pointer;font-weight:600}
code{background:#f6f5f2;padding:0 .25rem;border-radius:3px}@media print{details{display:block}details>*{display:block}a{color:inherit}}
</style></head><body>
${mdToHtml(md, { citeButtons: false })}
</body></html>`;
}
