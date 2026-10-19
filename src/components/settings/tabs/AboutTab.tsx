import { useEffect, useState } from "react";
import { ExternalLink, GitFork, Github, Scale } from "lucide-react";
import { BUILD_INFO } from "@/constants/build";
import appIcon from "@/assets/icon.png";
import { Section } from "../SettingsSection";
import { DeveloperInfo } from "../DeveloperInfo";

/** About this build: versions, links, license. */
export function AboutTab() {
  const [appVersion, setAppVersion] = useState("");

  useEffect(() => {
    import("@tauri-apps/api/app").then(({ getVersion }) =>
      getVersion().then(setAppVersion),
    );
  }, []);

  const openExternal = async (url: string) => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
  };

  return (
    <>
      <DeveloperInfo />

      <Section title="sndmail">
        <div className="flex items-center gap-3 mb-2">
          <img src={appIcon} alt="sndmail" className="w-12 h-12 rounded-xl" />
          <div>
            <h3 className="text-base font-semibold text-text-primary">sndmail</h3>
            <p className="text-sm text-text-tertiary">
              {appVersion
                ? `Version ${appVersion}${BUILD_INFO.shortSha !== "unknown" ? ` · ${BUILD_INFO.shortSha}` : ""}`
                : "Loading..."}
            </p>
          </div>
        </div>
        <p className="text-sm text-text-secondary leading-relaxed">
          A fast, open-source desktop email client built with privacy in mind. Your emails stay on your machine — no cloud, no tracking.
        </p>
      </Section>

      <Section title="Links">
        <div className="space-y-1">
          <button
            onClick={() => openExternal("https://github.com/ArneNostitz/sndmail")}
            className="flex items-center gap-3 w-full px-4 py-2.5 rounded-lg bg-bg-secondary hover:bg-bg-hover transition-colors text-left"
          >
            <Github size={16} className="text-text-tertiary shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="text-sm text-text-primary">GitHub Repository</span>
            </div>
            <ExternalLink size={14} className="text-text-tertiary shrink-0" />
          </button>

        </div>
      </Section>

      <Section title="License">
        <div className="px-4 py-3 bg-bg-secondary rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <Scale size={15} className="text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">Apache License 2.0</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed mb-3">
            Licensed under the Apache License, Version 2.0. You may obtain a copy of the License at{" "}
            <button
              onClick={() => openExternal("https://www.apache.org/licenses/LICENSE-2.0")}
              className="text-accent hover:text-accent-hover transition-colors"
            >
              apache.org/licenses/LICENSE-2.0
            </button>
          </p>
          <p className="text-xs text-text-tertiary leading-relaxed">
            Copyright 2025 sndmail. You may use, distribute, and modify this software under the terms of the Apache 2.0 license. This software is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.
          </p>
        </div>
      </Section>

      <Section title="Attribution">
        <div className="px-4 py-3 bg-bg-secondary rounded-lg">
          <div className="flex items-center gap-2 mb-2">
            <GitFork size={15} className="text-text-tertiary" />
            <span className="text-sm font-medium text-text-primary">Third-party attribution</span>
          </div>
          <p className="text-xs text-text-secondary leading-relaxed">
            Third-party copyright and license notices are included in NOTICE.
          </p>
        </div>
      </Section>
    </>
  );
}
