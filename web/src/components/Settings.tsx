import { useState } from "react";
import { GeneralSettings } from "./settings/GeneralSettings";
import { McpSettings } from "./settings/McpSettings";
import { ClaudeMdSettings } from "./settings/ClaudeMdSettings";
import { HooksSettings } from "./settings/HooksSettings";
import { RailwaySettings } from "./settings/RailwaySettings";

type Section = "general" | "mcp" | "claudemd" | "hooks" | "railway";

const SECTIONS: { id: Section; label: string }[] = [
  { id: "general", label: "General" },
  { id: "mcp", label: "MCP Servers" },
  { id: "claudemd", label: "CLAUDE.md" },
  { id: "hooks", label: "Hooks" },
  { id: "railway", label: "Railway" },
];

export function Settings() {
  const [section, setSection] = useState<Section>("general");

  return (
    <div className="pane settings-pane">
      <h2>Settings</h2>

      <nav className="settings-subtabs">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`settings-subtab ${section === s.id ? "active" : ""}`}
            onClick={() => setSection(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      {section === "general" && <GeneralSettings />}
      {section === "mcp" && <McpSettings />}
      {section === "claudemd" && <ClaudeMdSettings />}
      {section === "hooks" && <HooksSettings />}
      {section === "railway" && <RailwaySettings />}
    </div>
  );
}
