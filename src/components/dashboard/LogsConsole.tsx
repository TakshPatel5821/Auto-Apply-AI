"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, Trash2, ArrowDown } from "lucide-react";

interface LogEntry {
  id: string;
  level: string;
  category: string;
  message: string;
  details?: Record<string, unknown>;
  createdAt: string;
}

const levelColors: Record<string, string> = {
  DEBUG: "text-gray-500",
  INFO: "text-blue-400",
  WARN: "text-yellow-400",
  ERROR: "text-red-400",
  SUCCESS: "text-green-400",
};

const levelPrefixes: Record<string, string> = {
  DEBUG: "[DBG]",
  INFO: "[INF]",
  WARN: "[WRN]",
  ERROR: "[ERR]",
  SUCCESS: "[OK!]",
};

export function LogsConsole({
  logs,
  onClear,
}: {
  logs: LogEntry[];
  onClear: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  // Sticky-to-bottom: only auto-scroll the container if the user is already near the bottom.
  // Once they scroll up, autoscroll stops until they manually scroll back down.
  const stickToBottomRef = useRef(true);
  const [showJumpButton, setShowJumpButton] = useState(false);

  function handleScroll() {
    const el = containerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distFromBottom < 30;
    stickToBottomRef.current = atBottom;
    setShowJumpButton(!atBottom);
  }

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = containerRef.current;
    if (el) el.scrollTop = el.scrollHeight; // scroll only the inner container, never the page
  }, [logs]);

  function jumpToLatest() {
    const el = containerRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      stickToBottomRef.current = true;
      setShowJumpButton(false);
    }
  }

  async function clearLogs() {
    await fetch("/api/logs", { method: "DELETE" });
    onClear();
  }

  return (
    <div className="bg-gray-950 border border-gray-800 rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-gray-800 bg-gray-900">
        <Terminal className="w-4 h-4 text-gray-500" />
        <span className="text-sm font-medium text-gray-400">Automation Logs</span>
        <span className="text-xs text-gray-600 ml-1">({logs.length} entries)</span>
        <button
          onClick={clearLogs}
          className="ml-auto p-1 text-gray-600 hover:text-gray-400 transition-colors"
          title="Clear logs"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="relative">
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className="h-64 overflow-y-auto p-3 font-mono text-xs space-y-0.5"
        >
          {logs.length === 0 ? (
            <div className="text-gray-700 text-center py-8">No logs yet. Start automation to see activity.</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="flex gap-2 leading-5">
                <span className="text-gray-600 flex-shrink-0">
                  {new Date(log.createdAt).toLocaleTimeString()}
                </span>
                <span className={`flex-shrink-0 ${levelColors[log.level] || "text-gray-400"}`}>
                  {levelPrefixes[log.level] || log.level}
                </span>
                <span className="text-gray-600 flex-shrink-0">[{log.category}]</span>
                <span className="text-gray-300 break-all">
                  {log.message}
                  {log.details?.error != null && (
                    <span className="text-red-400 ml-1">— {String(log.details.error)}</span>
                  )}
                </span>
              </div>
            ))
          )}
        </div>

        {showJumpButton && (
          <button
            onClick={jumpToLatest}
            className="absolute bottom-3 right-3 flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs rounded-full shadow-lg transition-colors"
            title="Jump to latest log"
          >
            <ArrowDown className="w-3 h-3" />
            Latest
          </button>
        )}
      </div>
    </div>
  );
}
