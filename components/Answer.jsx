"use client";
import { mdToHtml } from "../lib/markdown";

export function sourceLabel(source) {
  if (!source) return "";
  if (source === "template") return "Approved template";
  if (source.startsWith("browser:")) return `${source.slice(8)} · in your browser`;
  if (source.startsWith("llm:")) return `${source.slice(4)} · server`;
  return source;
}

export function VerificationBadge({ v, onShowTemplate, showingTemplate, isTemplate }) {
  if (!v) return null;
  if (v.pass) {
    return (
      <div className="verify ok" title="Every number was matched to the evidence pack and every citation points to an evidence item.">
        <span aria-hidden="true">✓</span> Verified — {v.numbersSupported}/{v.numbersChecked} figures traced to evidence
        {v.citations.length ? `, ${v.citations.length} citation${v.citations.length > 1 ? "s" : ""} valid` : ""}
        {v.missingRequired ? (v.mentionsMissing ? ", missing information requested" : "") : ""}
      </div>
    );
  }
  return (
    <div className="verify warn" role="alert">
      <div>
        <span aria-hidden="true">⚠</span> <strong>Check failed</strong> — {v.issues.join(" ")}
      </div>
      {!isTemplate && (
        <button type="button" className="link" onClick={onShowTemplate}>
          {showingTemplate ? "Show the model's answer" : "Show the approved answer instead"}
        </button>
      )}
    </div>
  );
}

export function AnswerBody({ text, streaming }) {
  return (
    <div className={`answer md${streaming ? " streaming" : ""}`} dangerouslySetInnerHTML={{ __html: mdToHtml(text || (streaming ? "…" : "")) }} />
  );
}
