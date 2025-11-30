
export interface UploadedImage {
  id: string;
  url: string; // Base64 or Blob URL
  name: string;
  uploadedAt: number;
  hash?: string; // dHash string for fast pre-screening
}

export interface RiskScores {
  semantic: number; // Max 40
  structure: number; // Max 40
  compliance: number; // Max 20
  total: number; // Max 100
}

export interface AssessmentResult {
  referenceImageId: string;
  isMatch: boolean; // True if Risk is significant
  scores: RiskScores;
  analysisText: string;
  evidence: {
    similarities: string[]; // List of matching visual elements
    differences: string[]; // List of distinct elements
  };
  breakdown: {
    style: { score: number; comment: string };
    composition: { score: number; comment: string };
    elements: { score: number; comment: string };
    font: { score: number; comment: string };
  };
  modificationSuggestion: string | null;
  pHashMatch?: boolean; // Indicates if pHash detected high similarity
}

export interface HistoryRecord {
  id: string;
  timestamp: number;
  targetImage: UploadedImage;
  results: AssessmentResult[];
}

export enum AppState {
  GALLERY = 'GALLERY',
  ASSESS = 'ASSESS',
  HISTORY = 'HISTORY',
}

export interface AnalysisStatus {
  step: 'idle' | 'analyzing' | 'complete';
  progress: number;
  currentFile?: string;
}
