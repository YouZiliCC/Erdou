// Types for render-help.mjs so src tests can import it (allowJs is off).
export interface HelpProfileMeta {
  version: string;
  packages: string[];
  label: string;
  interpreters: string[];
  packageManagers: string[];
}
export declare function renderMd(md: string): string;
export declare function inject(md: string, profiles: Record<string, HelpProfileMeta>): string;
