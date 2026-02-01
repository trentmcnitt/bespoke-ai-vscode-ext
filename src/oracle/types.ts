export interface ImportInfo {
  module: string;
  provides: string;
}

export interface TypeContextEntry {
  name: string;
  signature: string;
}

export interface RelatedSymbol {
  name: string;
  description: string;
  signature: string;
}

export interface ContextBrief {
  filePath: string;
  generatedAt: number;
  language: string;
  imports: ImportInfo[];
  typeContext: TypeContextEntry[];
  patterns: string[];
  relatedSymbols: RelatedSymbol[];
  projectSummary: string;
}

export type OracleStatus =
  | 'disabled'
  | 'initializing'
  | 'ready'
  | 'analyzing'
  | 'error'
  | 'unavailable';

export interface OracleConfig {
  enabled: boolean;
  debounceMs: number;
  briefTtlMs: number;
  model: string;
  allowedTools: string[];
}
