"use client";

import Link from "next/link";
import { memo } from "react";
import { formatMs, linkableRequestIds, prettyLine, spanBars, statusTone, summarize } from "@/lib/logs/view/format";
import { requestSearchHref } from "@/lib/logs/view/filters";
import type { Row } from "@/lib/logs/view/tail";

// Everything below renders log text as React text children, which React escapes. Nothing here
// builds HTML from a log line, and links are only made from ids matching the API's id pattern.

function RequestLink({ id }: { id: string }) {
  const href = requestSearchHref(id);
  if (!href) return <span>{id}</span>;
  return <Link className="log-request-link" href={href} prefetch={false} title="Search every app for this request id">{id}</Link>;
}

type LogRowProps = {
  row: Row;
  expanded: boolean;
  showApp: boolean;
  onToggle: (id: number) => void;
};

export const LogRow = memo(function LogRow({ row, expanded, showApp, onToggle }: LogRowProps) {
  const { line } = row;
  const summary = summarize(line);
  const ids = linkableRequestIds(line);
  const bars = expanded ? spanBars(line.fields) : [];
  const route = summary.route ? `${summary.method ? `${summary.method} ` : ""}${summary.route}` : undefined;

  return <div className={`log-row log-row-${summary.level}${expanded ? " open" : ""}`} role="listitem">
    <button aria-expanded={expanded} className="log-row-main" onClick={() => onToggle(row.id)} type="button">
      <span className="log-time" title={line.ts}>{summary.time}</span>
      <span className={`log-badge log-badge-${summary.level}`}>{summary.level}</span>
      <span className="log-event">{showApp ? <em className="log-app">{summary.app}</em> : null}{summary.event}</span>
      <span className="log-detail" title={route ?? summary.text}>{route ?? summary.text ?? ""}</span>
      <span className="log-status">{summary.status !== undefined ? <span className={`log-status-pill log-status-${statusTone(summary.status)}`}>{summary.status}</span> : null}</span>
      <span className={summary.slow ? "log-ms slow" : "log-ms"}>{summary.ms !== undefined ? formatMs(summary.ms) : ""}{summary.slow ? " · slow" : ""}</span>
      <span className="log-user" title="User id (shortened)">{summary.user ?? ""}</span>
    </button>
    <span className="log-ref">{summary.requestId ? <RequestLink id={summary.requestId} /> : summary.relatedRequestId ? <>↳ <RequestLink id={summary.relatedRequestId} /></> : null}</span>
    {expanded ? <div className="log-expanded">
      <div className="log-meta">
        <span>{line.ts}</span><span>{line.container}</span><span>{line.stream}</span>
        {line.clipped ? <span className="log-clipped">clipped at 16 KB</span> : null}
        {ids.map((id) => <span key={id}>{id === summary.relatedRequestId && id !== summary.requestId ? "related request " : "request "}<RequestLink id={id} /></span>)}
      </div>
      {bars.length ? <div className="span-list" aria-label="Spans, slowest first">{bars.map((bar, index) => <div className="span-row" key={`${bar.name}-${index}`}><span className="span-name" title={bar.name}>{bar.name}</span><span className="span-track"><span style={{ width: `${Math.max(2, bar.share * 100)}%` }} /></span><span className="span-ms">{formatMs(bar.ms)}</span></div>)}</div> : null}
      <pre className="log-json">{prettyLine(line)}</pre>
    </div> : null}
  </div>;
});
