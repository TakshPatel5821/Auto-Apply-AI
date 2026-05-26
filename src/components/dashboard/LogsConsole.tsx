"use client";

import { useEffect, useRef } from "react";
import { Terminal, Trash2 } from "lucide-react";

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
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

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
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
      <div className="h-64 overflow-y-auto p-3 font-mono text-xs space-y-0.5">
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
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
