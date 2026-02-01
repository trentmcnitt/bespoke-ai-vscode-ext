import { ContextBrief } from './types';

export function formatBriefForPrompt(brief: ContextBrief | null): string {
  if (!brief) {
    return '';
  }

  const sections: string[] = [];

  if (brief.imports.length > 0) {
    const lines = brief.imports.map((i) => `- ${i.module}: ${i.provides}`);
    sections.push(`Imports:\n${lines.join('\n')}`);
  }

  if (brief.typeContext.length > 0) {
    const lines = brief.typeContext.map((t) => `- ${t.name}: ${t.signature}`);
    sections.push(`Types in scope:\n${lines.join('\n')}`);
  }

  if (brief.patterns.length > 0) {
    const lines = brief.patterns.map((p) => `- ${p}`);
    sections.push(`Patterns:\n${lines.join('\n')}`);
  }

  if (brief.relatedSymbols.length > 0) {
    const lines = brief.relatedSymbols.map((s) => `- ${s.name}: ${s.description} — ${s.signature}`);
    sections.push(`Related symbols:\n${lines.join('\n')}`);
  }

  if (brief.projectSummary) {
    sections.push(`Project: ${brief.projectSummary}`);
  }

  if (sections.length === 0) {
    return '';
  }

  return `<project-context>\n${sections.join('\n\n')}\n</project-context>`;
}
