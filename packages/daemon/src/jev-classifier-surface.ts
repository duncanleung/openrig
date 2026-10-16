// Cross-package surface for the RIG-97 shadow-mode Jev classifier (ADR-0008). Consumed by
// `rig ticket-factory jev-classify`. Keep minimal: nothing here may gate a merge.
export {
  JEV_DEFAULT_BASE_URL,
  JEV_DEFAULT_MODEL,
  JEV_DEFAULT_THRESHOLD,
  JEV_DEFAULT_TIMEOUT_MS,
  RISK_CLASSES,
  buildPrSummary,
  classifyWithJev,
  decideJev,
  type ChangedFile,
  type JevOptions,
  type JevVerdict,
  type PrSummary,
  type RiskClass,
} from "./domain/jev-classifier.js";
