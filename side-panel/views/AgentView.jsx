import React from "react";

/**
 * AgentView — Slice 1 placeholder.
 * Slice 11 will add: "Find It for Me" element selection.
 * Slice 12 will add: full approval-gated agent loop.
 * Slice 13 will add: persistence, dry-run, step limit, action log.
 */
export default function AgentView() {
  return (
    <div
      id="panel-agent"
      role="tabpanel"
      aria-labelledby="tab-agent"
      className="flex flex-col h-full items-center justify-center p-6 text-center gap-3"
    >
      <span className="text-4xl" aria-hidden="true">🤖</span>
      <h2 className="font-semibold text-gray-800">Agent</h2>
      <p className="text-sm text-gray-500">
        Give Lemon a browser task. Approve each step before it acts. Coming in Slice 12.
      </p>
    </div>
  );
}
