/** Shared schemas and durable data contracts for the bundled deep-research workflow. */
import { z, type ArtifactRef } from "acpus/core";

const Relevance = z.enum(["high", "medium", "low"]);
const SourceQuality = z.enum(["primary", "secondary", "blog", "forum", "unreliable"]);
const Importance = z.enum(["central", "supporting", "tangential"]);
const Confidence = z.enum(["high", "medium", "low"]);
const ToolStatus = z.enum(["ok", "tool_unavailable"]);
const ReportLanguage = z.enum(["zh-CN", "en"]);

const ArtifactRefSchema = z.object({
  kind: z.literal("artifact"),
  uri: z.string(),
  mediaType: z.string().optional(),
}).transform((ref): ArtifactRef => ref.mediaType === undefined
  ? { kind: ref.kind, uri: ref.uri }
  : { kind: ref.kind, uri: ref.uri, mediaType: ref.mediaType });

const SearchAngle = z.object({
  label: z.string(),
  query: z.string(),
  rationale: z.string(),
});

const SearchResult = z.object({
  url: z.string(),
  title: z.string(),
  snippet: z.string(),
  relevance: Relevance,
});

export const SearchBatch = z.object({
  round: z.number().int(),
  angle: z.string(),
  query: z.string(),
  rationale: z.string(),
  results: z.array(SearchResult),
});

export type SearchBatch = z.infer<typeof SearchBatch>;

export const ScopeOutput = z.object({
  researchFrame: z.string(),
  summary: z.string(),
  angles: z.array(SearchAngle),
});

export const GapPlanOutput = z.object({
  coverageSummary: z.string(),
  sufficient: z.boolean(),
  gaps: z.array(SearchAngle),
});

export const SearchWorkerOutput = z.object({
  status: ToolStatus,
  error: z.string(),
  angles: z.array(z.object({
    angleIndex: z.number().int().min(0),
    results: z.array(SearchResult),
  })),
});

const ExtractedClaim = z.object({
  claim: z.string(),
  quote: z.string(),
  importance: Importance,
});

export const ExtractionOutput = z.object({
  status: ToolStatus,
  error: z.string(),
  sourceQuality: SourceQuality,
  author: z.string(),
  publishDate: z.string(),
  summary: z.string(),
  claims: z.array(ExtractedClaim),
});

export const SelectedSource = SearchResult.extend({
  round: z.number().int(),
  angle: z.string(),
});

const ExtractedSource = z.object({
  url: z.string(),
  title: z.string(),
  round: z.number().int(),
  angle: z.string(),
  relevance: Relevance,
  sourceQuality: SourceQuality,
  author: z.string(),
  publishDate: z.string(),
  summary: z.string(),
  claims: z.array(ExtractedClaim),
});

export const RankedClaim = ExtractedClaim.extend({
  sourceUrl: z.string(),
  sourceTitle: z.string(),
  sourceQuality: SourceQuality,
  author: z.string(),
  publishDate: z.string(),
  angle: z.string(),
  claimId: z.string(),
});

export const LedgerSource = z.object({
  url: z.string(),
  title: z.string(),
  round: z.number().int(),
  angle: z.string(),
  relevance: Relevance,
  quality: SourceQuality,
  author: z.string(),
  publishDate: z.string(),
  summary: z.string(),
  claimCount: z.number().int().min(0),
});

export const VerificationVerdictOutput = z.object({
  claimId: z.string(),
  decision: z.enum(["supports", "refutes", "insufficient"]),
  evidence: z.string(),
  confidence: Confidence,
  counterSource: z.string(),
});

export const VerificationBatchOutput = z.object({
  status: ToolStatus,
  error: z.string(),
  verdicts: z.array(VerificationVerdictOutput),
});

const ClaimVerdict = VerificationVerdictOutput.omit({ claimId: true });

export const ClaimReview = z.object({
  claim: RankedClaim,
  verdicts: z.array(VerificationVerdictOutput),
});

export const InitialVerificationResult = z.object({
  reviews: z.array(ClaimReview),
});

export const TieBreakerResult = z.object({
  verdicts: z.array(VerificationVerdictOutput),
});

export const VerifiedClaim = RankedClaim.extend({
  verdicts: z.array(ClaimVerdict),
  status: z.enum(["confirmed", "refuted", "unverified"]),
});

export type VerifiedClaim = z.infer<typeof VerifiedClaim>;

export const EvidenceRef = z.object({
  claimId: z.string(),
  role: z.enum(["support", "correction", "uncertainty"]),
});

const NarrativeOutput = z.object({
  title: z.string(),
  deck: z.string(),
  throughline: z.string(),
  executiveSummary: z.string(),
  findings: z.array(z.object({
    kind: z.enum(["finding", "correction"]),
    heading: z.string(),
    analysis: z.string(),
    confidence: Confidence,
    evidenceRefs: z.array(EvidenceRef),
  })),
  implications: z.array(z.string()),
});

const ScrutinyOutput = z.object({
  tensions: z.array(z.object({
    heading: z.string(),
    analysis: z.string(),
    evidenceRefs: z.array(EvidenceRef),
  })),
  uncertainties: z.array(z.object({
    heading: z.string(),
    analysis: z.string(),
    evidenceRefs: z.array(EvidenceRef),
  })),
  limitations: z.array(z.string()),
  openQuestions: z.array(z.string()),
});

export const EditorialBundleOutput = z.object({
  narrative: NarrativeOutput,
  scrutiny: ScrutinyOutput,
});

const ResearchBudget = z.object({
  depth: z.enum(["quick", "standard", "deep"]),
  maxSearchRounds: z.number().int(),
  searchWorkers: z.number().int(),
  angleLimit: z.number().int(),
  sourceLimit: z.number().int(),
  claimLimit: z.number().int(),
  verificationBatchSize: z.number().int(),
  editorialPasses: z.number().int(),
  maxAgentConcurrency: z.number().int(),
  maxLogicalAgentCalls: z.number().int(),
});

export const ResearchStats = z.object({
  searchRounds: z.number().int(),
  searchAngles: z.number().int(),
  searchWorkerCalls: z.number().int(),
  searchPlanningCalls: z.number().int(),
  searchCandidates: z.number().int(),
  uniqueSources: z.number().int(),
  sourcesFetched: z.number().int(),
  claimsExtracted: z.number().int(),
  duplicateClaims: z.number().int(),
  claimsDropped: z.number().int(),
  claimsVerified: z.number().int(),
  verificationVotes: z.number().int(),
  tieBreakersUsed: z.number().int(),
  verificationAgentCalls: z.number().int(),
  tieBreakerAgentCalls: z.number().int(),
  confirmed: z.number().int(),
  refuted: z.number().int(),
  unverified: z.number().int(),
  rejectedUrls: z.number().int(),
  urlDupes: z.number().int(),
  budgetDropped: z.number().int(),
  editorialRepairCalls: z.number().int(),
  logicalAgentCalls: z.number().int(),
});

export const EvidenceLedger = z.object({
  schemaVersion: z.number().int(),
  question: z.string(),
  context: z.string(),
  reportLanguage: ReportLanguage,
  budget: ResearchBudget,
  planning: z.object({
    researchFrame: z.string(),
    decomposition: z.string(),
    coverageSummary: z.string(),
    completedRounds: z.number().int(),
    remainingGaps: z.array(SearchAngle),
  }),
  searches: z.array(SearchBatch),
  sources: z.array(LedgerSource),
  confirmed: z.array(VerifiedClaim),
  refuted: z.array(VerifiedClaim),
  unverified: z.array(VerifiedClaim),
  stats: ResearchStats,
});

export type EvidenceLedger = z.infer<typeof EvidenceLedger>;

export const SelectSourcesInput = z.object({
  searches: z.array(SearchBatch),
  sourceLimit: z.number().int().min(0),
});

export const RankClaimsInput = z.object({
  sources: z.array(ExtractedSource),
  claimLimit: z.number().int().min(0),
});

export const BatchClaimsInput = z.object({
  claims: z.array(RankedClaim),
  batchSize: z.number().int().min(1),
});

export const RequireInitialVerdictsInput = z.object({
  claims: z.array(RankedClaim),
  voterA: VerificationBatchOutput,
  voterB: VerificationBatchOutput,
});

export const PlanTieBreakBatchesInput = z.object({
  initial: z.array(InitialVerificationResult),
  batchSize: z.number().int().min(1),
});

export const RequireTieBreakVerdictsInput = z.object({
  claims: z.array(RankedClaim),
  result: VerificationBatchOutput,
});

export const TallyVerifiedClaimsInput = z.object({
  reviews: z.array(ClaimReview),
  initialAgentCalls: z.number().int().min(0),
  tieBreakers: z.array(TieBreakerResult),
});

export const WriteEvidenceLedgerInput = z.object({
  request: z.object({
    question: z.string(),
    context: z.string(),
    reportLanguage: ReportLanguage,
  }),
  planning: z.object({
    researchFrame: z.string(),
    decomposition: z.string(),
    coverageSummary: z.string(),
    completedRounds: z.number().int(),
    remainingGaps: z.array(SearchAngle),
    searches: z.array(SearchBatch),
    searchAgentCalls: z.number().int(),
    planningAgentCalls: z.number().int(),
  }),
  selection: z.object({
    sourcesFetched: z.number().int().min(0),
    candidateCount: z.number().int(),
    uniqueCount: z.number().int(),
    rejectedUrlCount: z.number().int(),
    duplicateCount: z.number().int(),
    budgetDropped: z.number().int(),
  }),
  claimPool: z.object({
    claimsExtracted: z.number().int(),
    duplicateClaims: z.number().int(),
    claimsDropped: z.number().int(),
    sources: z.array(LedgerSource),
  }),
  verification: z.object({
    claims: z.array(VerifiedClaim),
    verificationAgentCalls: z.number().int(),
    tieBreakerAgentCalls: z.number().int(),
  }),
  budget: ResearchBudget,
});

export const FinalizeEvidenceLedgerInput = z.object({
  ledger: ArtifactRefSchema,
  editorialRepairCalls: z.number().int().min(0),
});

export const ValidateEditorialInput = z.object({
  ledger: ArtifactRefSchema,
  narrative: NarrativeOutput,
  scrutiny: ScrutinyOutput,
});

export const GroundEditorialInput = z.object({
  ledger: ArtifactRefSchema,
  reportLanguage: ReportLanguage,
  narrative: NarrativeOutput,
  scrutiny: ScrutinyOutput,
  editorialRepairCalls: z.number().int().min(0),
});

export const WriteResearchPackageInput = z.object({
  report: ArtifactRefSchema,
  ledger: ArtifactRefSchema,
  reportLanguage: ReportLanguage,
  runId: z.string(),
});

export const PrepareReportInputsInput = z.object({
  format: z.enum(["md", "html"]),
  reportLanguage: ReportLanguage,
  reportPath: z.string(),
  runId: z.string(),
  workspaceDir: z.string(),
});

export const PublishRenderedReportInput = z.object({
  format: z.enum(["md", "html"]),
  draftPath: z.string(),
  outputPath: z.string(),
  completed: z.literal(true),
});
