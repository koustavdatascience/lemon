import React from "react";

/**
 * SkillsView — Slice 1 placeholder.
 * Slice 15 will add: save, run, import, export one-click skills.
 */
export default function SkillsView() {
  return (
    <div
      id="panel-skills"
      role="tabpanel"
      aria-labelledby="tab-skills"
      className="flex flex-col h-full items-center justify-center p-6 text-center gap-3"
    >
      <span className="text-4xl" aria-hidden="true">⚡</span>
      <h2 className="font-semibold text-gray-800">Skills</h2>
      <p className="text-sm text-gray-500">
        Save reusable one-click prompt recipes. Coming in Slice 15.
      </p>
    </div>
  );
}
